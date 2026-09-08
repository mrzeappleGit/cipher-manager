//! Agent PTY sessions — interactive `claude` (or any CLI) in a real ConPTY,
//! hosted by the serve binary so sessions survive app restarts and the phone
//! can attach. Used only by serve; the desktop frontend reaches these over
//! localhost HTTP (see api.ts agentCall).
//! Running sessions are mirrored to app state ("agent-sessions"); a serve
//! restart revives them via restore_persisted() (claude bins with --continue).
//! The terminal scrollback itself is NOT persisted — revived sessions start a
//! fresh ring; claude repaints its own UI.

use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::sync::{Arc, Mutex, OnceLock};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

/// Ring buffer cap per session. ponytail: fixed 1 MiB — a scrollback-hungry
/// UI would want this configurable, but xterm keeps its own scrollback.
const RING_CAP: usize = 1 << 20;

struct AgentSession {
    title: String,
    cwd: String,
    bin: String,
    resume_session_id: Option<String>,
    project_id: Option<String>,
    started_ms: u64,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    // Shared handle so writes happen OUTSIDE the map lock — a blocked PTY
    // write while holding the map would deadlock against the reader thread.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    buf: Vec<u8>,
    base: u64, // absolute stream offset of buf[0]
    exited: bool,
    exit_code: Option<u32>,
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpawnReq {
    pub bin: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub create_cwd: bool,
    #[serde(default)]
    pub resume: Option<ResumeRef>,
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResumeRef {
    pub project_id: String,
    pub session_id: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub started_ms: u64,
    pub status: String, // "running" | "exited"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub data_b64: String,
    pub offset: u64, // next offset the client should pass
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
}

fn sessions() -> &'static Mutex<HashMap<String, AgentSession>> {
    static S: OnceLock<Mutex<HashMap<String, AgentSession>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What survives a serve restart: enough to respawn, not the scrollback.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PersistEntry {
    title: String,
    cwd: String,
    bin: String,
}

const PERSIST_KEY: &str = "agent-sessions";

/// Mirror the running sessions to app state. Snapshot under the map lock,
/// file IO outside it.
fn persist_registry() {
    let entries: Vec<PersistEntry> = {
        let map = sessions().lock().unwrap();
        map.values()
            .filter(|s| !s.exited)
            .map(|s| PersistEntry {
                title: s.title.clone(),
                cwd: s.cwd.clone(),
                bin: s.bin.clone(),
            })
            .collect()
    };
    let json = serde_json::to_string(&entries).unwrap_or_else(|_| "[]".into());
    let _ = crate::commands::write_app_state(PERSIST_KEY, &json);
}

/// Revive sessions persisted by a previous serve run. Call once at serve boot.
pub fn restore_persisted() {
    let raw = match crate::commands::read_app_state(PERSIST_KEY) {
        Ok(Some(r)) => r,
        _ => return,
    };
    let entries: Vec<PersistEntry> = serde_json::from_str(&raw).unwrap_or_default();
    if entries.is_empty() {
        return;
    }
    if !acting_mode_on() {
        // The old processes died with serve; never respawn without the switch.
        let _ = crate::commands::write_app_state(PERSIST_KEY, "[]");
        return;
    }
    for e in entries {
        // ponytail: claude-ish bins revive with --continue (the latest
        // conversation in that cwd — the exact old id would fork a stale
        // snapshot); anything else revives bare. Per-entry resume state is
        // the upgrade path.
        let args = if e.bin.to_ascii_lowercase().contains("claude") {
            vec!["--continue".to_string()]
        } else {
            Vec::new()
        };
        let req = SpawnReq {
            bin: e.bin,
            args,
            title: Some(e.title),
            cwd: Some(e.cwd),
            create_cwd: false,
            resume: None,
        };
        if let Err(err) = agent_spawn_impl(req) {
            eprintln!("agent session restore failed: {err}");
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Status refresh via the child itself (ConPTY may not EOF the reader
/// promptly after exit, so list/read poll this instead of trusting EOF).
fn refresh_status(s: &mut AgentSession) {
    if s.exited {
        return;
    }
    if let Ok(Some(st)) = s.child.try_wait() {
        s.exited = true;
        s.exit_code = Some(st.exit_code());
    }
}

fn append(buf: &mut Vec<u8>, base: &mut u64, data: &[u8]) {
    buf.extend_from_slice(data);
    if buf.len() > RING_CAP {
        // ponytail: Vec::drain memmove on overflow — fine at terminal
        // throughput; swap for a real ring if a session ever streams MB/s.
        let drop = buf.len() - RING_CAP;
        buf.drain(..drop);
        *base += drop as u64;
    }
}

/// Clamp a client offset against the ring: returns (start index into buf,
/// next offset). Older than the ring's start → replay from the start; beyond
/// the end (stale client after a restart id-collision) → nothing.
fn ring_from(base: u64, len: usize, offset: u64) -> (usize, u64) {
    let end = base + len as u64;
    let from = offset.max(base).min(end);
    ((from - base) as usize, end)
}

fn acting_mode_on() -> bool {
    crate::commands::require_acting_mode().is_ok()
}

/// One path component, no traversal (project/session ids from the client).
fn plain_component(s: &str) -> bool {
    // ':' rejects drive-relative names ("C:foo") — PathBuf::push replaces the base.
    !s.is_empty() && !s.contains(['/', '\\', ':']) && s != "." && s != ".."
}

/// The transcript's own `"cwd"` field is the authoritative working dir —
/// decoding the project dir name is lossy. Checks the head of the file only.
fn resume_cwd(project_id: &str, session_id: &str) -> Result<String, String> {
    if !plain_component(project_id) || !plain_component(session_id) {
        return Err("bad resume ids".into());
    }
    let path = crate::claude::projects_dir()
        .ok_or("No ~/.claude directory")?
        .join(project_id)
        .join(format!("{session_id}.jsonl"));
    let f = std::fs::File::open(&path)
        .map_err(|_| format!("transcript not found: {project_id}/{session_id}"))?;
    for line in std::io::BufReader::new(f).lines().take(40) {
        let Ok(line) = line else { break };
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                if !c.trim().is_empty() {
                    return Ok(c.to_string());
                }
            }
        }
    }
    Err(format!("no cwd recorded in transcript {project_id}/{session_id}"))
}

pub fn agent_spawn_impl(req: SpawnReq) -> Result<String, String> {
    if !acting_mode_on() {
        return Err("Agent sessions are disabled — turn on acting mode in Settings first.".into());
    }
    let bin = req.bin.trim();
    if bin.is_empty() {
        return Err("missing bin".into());
    }
    let has_cwd = req.cwd.as_deref().map(|c| !c.trim().is_empty()).unwrap_or(false);
    let mut args = req.args.clone();
    let (cwd, resume_session_id, project_id) = match (&req.resume, has_cwd) {
        (Some(_), true) | (None, false) => {
            return Err("exactly one of cwd or resume is required".into())
        }
        (Some(r), false) => {
            if req.create_cwd {
                return Err("createCwd is only valid with cwd".into());
            }
            let cwd = resume_cwd(&r.project_id, &r.session_id)?;
            args.push("--resume".into());
            args.push(r.session_id.clone());
            (cwd, Some(r.session_id.clone()), Some(r.project_id.clone()))
        }
        (None, true) => (req.cwd.clone().unwrap().trim().to_string(), None, None),
    };
    let cwd_path = std::path::Path::new(&cwd);
    if req.create_cwd {
        if !cwd_path.is_absolute() {
            return Err("createCwd requires an absolute cwd path".into());
        }
        // `..` (or `.`) segments would let "New project" escape its parent dir.
        if cwd_path.components().any(|c| {
            matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir)
        }) {
            return Err("project path may not contain . or .. segments".into());
        }
        std::fs::create_dir_all(cwd_path).map_err(|e| format!("createCwd failed: {e}"))?;
    }
    if !cwd_path.is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }

    // Spawn through cmd.exe so the `claude` .cmd shim resolves via PATHEXT
    // (bare-name spawn finds .exe but not .cmd — same trick as run_child).
    #[cfg(windows)]
    let mut cmd = {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/c");
        c.arg(bin);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = CommandBuilder::new(bin);
    for a in &args {
        cmd.arg(a);
    }
    cmd.cwd(&cwd);
    // npm-global CLIs (claude/codex/gemini) live in %APPDATA%\npm and
    // ~/.local/bin, which aren't always on the PATH serve inherits (Startup
    // launch vs shell launch) — append them so bare bin names resolve.
    #[cfg(windows)]
    {
        let mut path = std::env::var("PATH").unwrap_or_default();
        if let Ok(appdata) = std::env::var("APPDATA") {
            path.push(';');
            path.push_str(&format!("{appdata}\\npm"));
        }
        if let Some(home) = dirs::home_dir() {
            path.push(';');
            path.push_str(&home.join(".local").join("bin").to_string_lossy());
        }
        cmd.env("PATH", path);
    }

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let title = req
        .title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| format!("{bin} — {cwd}"));
    // Collision check and insert under ONE guard, or racing spawns could both
    // pass contains_key and one would silently overwrite the other's session.
    let id = {
        let mut map = sessions().lock().unwrap();
        let id = loop {
            let candidate = crate::g2::rand_hex(1)[..8].to_string();
            if !map.contains_key(&candidate) {
                break candidate;
            }
        };
        map.insert(
            id.clone(),
            AgentSession {
                title,
                cwd,
                bin: bin.to_string(),
                resume_session_id,
                project_id,
                started_ms: now_ms(),
                child,
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                buf: Vec::new(),
                base: 0,
                exited: false,
                exit_code: None,
            },
        );
        id
    };

    // One reader thread per session: blocks on the pty, appends under the
    // map lock only per chunk. Ends on EOF/err (child gone or session removed).
    let tid = id.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut map = sessions().lock().unwrap();
                    match map.get_mut(&tid) {
                        Some(s) => append(&mut s.buf, &mut s.base, &chunk[..n]),
                        None => return, // removed while we were reading
                    }
                }
            }
        }
        // EOF: harvest the exit code (give the OS a few seconds to settle).
        for _ in 0..50 {
            // Guard scoped so persist_registry can retake the (non-reentrant)
            // map lock after the flip.
            let exited_now = {
                let mut map = sessions().lock().unwrap();
                match map.get_mut(&tid) {
                    None => return, // removed elsewhere; remove persisted already
                    Some(s) => {
                        refresh_status(s);
                        s.exited
                    }
                }
            };
            if exited_now {
                persist_registry();
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        // ponytail: EOF but no reapable status — call it exited, code unknown.
        if let Some(s) = sessions().lock().unwrap().get_mut(&tid) {
            s.exited = true;
        }
        persist_registry();
    });

    persist_registry();
    Ok(id)
}

pub fn agent_list_impl() -> Vec<AgentSessionInfo> {
    // ConPTY may never EOF the reader, so exits are often noticed here via
    // try_wait — keep the on-disk mirror in sync when that happens.
    let mut flipped = false;
    let mut map = sessions().lock().unwrap();
    let mut out: Vec<AgentSessionInfo> = map
        .iter_mut()
        .map(|(id, s)| {
            let was_running = !s.exited;
            refresh_status(s);
            if was_running && s.exited {
                flipped = true;
            }
            AgentSessionInfo {
                id: id.clone(),
                title: s.title.clone(),
                cwd: s.cwd.clone(),
                resume_session_id: s.resume_session_id.clone(),
                project_id: s.project_id.clone(),
                started_ms: s.started_ms,
                status: if s.exited { "exited" } else { "running" }.into(),
                exit_code: s.exit_code,
            }
        })
        .collect();
    out.sort_by(|a, b| b.started_ms.cmp(&a.started_ms));
    drop(map); // persist_registry retakes the lock
    if flipped {
        persist_registry();
    }
    out
}

pub fn agent_read_impl(id: &str, offset: u64) -> Result<ReadResult, String> {
    let mut map = sessions().lock().unwrap();
    let s = map.get_mut(id).ok_or("unknown agent session")?;
    refresh_status(s);
    let (start, end) = ring_from(s.base, s.buf.len(), offset);
    let slice = &s.buf[start..];
    Ok(ReadResult {
        data_b64: crate::commands::base64_encode(slice),
        offset: end,
        status: if s.exited { "exited" } else { "running" }.into(),
        exit_code: s.exit_code,
    })
}

pub fn agent_write_impl(id: &str, data_b64: &str) -> Result<(), String> {
    let bytes = crate::commands::base64_decode(data_b64)?;
    // Clone the writer handle and DROP the map guard before the (potentially
    // blocking) PTY write — holding the map across it deadlocks the reader.
    let writer = {
        let mut map = sessions().lock().unwrap();
        let s = map.get_mut(id).ok_or("unknown agent session")?;
        if s.exited {
            return Err("session has exited".into());
        }
        s.writer.clone()
    };
    let mut w = writer.lock().unwrap();
    w.write_all(&bytes).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

pub fn agent_resize_impl(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err("bad size".into());
    }
    let map = sessions().lock().unwrap();
    let s = map.get(id).ok_or("unknown agent session")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

/// Kill the child but keep the entry (status "exited") until agent_remove.
pub fn agent_kill_impl(id: &str) -> Result<(), String> {
    {
        let mut map = sessions().lock().unwrap();
        let s = map.get_mut(id).ok_or("unknown agent session")?;
        refresh_status(s);
        if !s.exited {
            // Kill the tree: the direct child is cmd.exe; the real claude is a
            // grandchild still attached to the live ConPTY otherwise.
            #[cfg(windows)]
            let tree_killed = s.child.process_id().is_some_and(|pid| {
                let mut c = std::process::Command::new("taskkill");
                c.args(["/T", "/F", "/PID", &pid.to_string()]);
                crate::commands::no_window(&mut c);
                c.output().map(|out| out.status.success()).unwrap_or(false)
            });
            #[cfg(not(windows))]
            let tree_killed = false;
            if !tree_killed {
                if let Err(error) = s.child.kill() {
                    // The process may have exited between try_wait and kill.
                    if s.child.try_wait().map_err(|e| e.to_string())?.is_none() {
                        return Err(format!("Could not stop agent process: {error}"));
                    }
                }
            }
            s.exited = true;
            refresh_status_after_kill(s);
        }
    }
    persist_registry(); // killed sessions must not revive on restart
    Ok(())
}

/// Best-effort exit-code harvest right after a kill (usually instant).
fn refresh_status_after_kill(s: &mut AgentSession) {
    if let Ok(Some(st)) = s.child.try_wait() {
        s.exit_code = Some(st.exit_code());
    }
}

pub fn agent_remove_impl(id: &str) -> Result<(), String> {
    // Remove under a scoped guard, then drop the session with the map
    // unlocked — ClosePseudoConsole can block against the reader thread.
    let mut s = {
        let mut map = sessions().lock().unwrap();
        map.remove(id).ok_or("unknown agent session")?
    };
    let _ = s.child.kill(); // no-op if already gone
    drop(s); // closes master/writer; the reader thread ends
    persist_registry();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh state dir with a mirrored settings.json; env guarded by the
    /// shared lock (same pattern as inbox.rs tests).
    fn setup(name: &str, acting: bool) -> crate::commands::TestProfile {
        crate::commands::TestProfile::new(&format!("cm-agents-{name}"), acting)
    }

    fn req(cwd: Option<String>) -> SpawnReq {
        SpawnReq {
            bin: "echo".into(),
            args: vec!["hi".into()],
            title: None,
            cwd,
            create_cwd: false,
            resume: None,
        }
    }

    #[cfg(windows)]
    fn stop_test_session(id: &str) {
        agent_kill_impl(id).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let exited = sessions().lock().unwrap().get_mut(id).unwrap().child.try_wait().unwrap().is_some();
            if exited { break; }
            assert!(std::time::Instant::now() < deadline, "owned PTY child survived cleanup");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        agent_remove_impl(id).unwrap();
    }

    #[test]
    fn pty_echo_round_trip() {
        let _g = crate::commands::state_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let state = setup("echo", true);
        let id = agent_spawn_impl(req(Some(state.to_string_lossy().into_owned()))).unwrap();

        // Poll until the output contains "hi" AND the status flips to exited.
        // ConPTY wraps the payload in ANSI noise — contains, never equals.
        // conhost also queries cursor position (ESC[6n) and stalls until the
        // "terminal" answers; xterm.js does that automatically, here we do it
        // by hand (also exercises agent_write).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut seen;
        let mut replied = false;
        loop {
            let r = agent_read_impl(&id, 0).unwrap();
            seen = String::from_utf8_lossy(&crate::commands::base64_decode(&r.data_b64).unwrap())
                .into_owned();
            if seen.contains("hi") && r.status == "exited" {
                break;
            }
            if !replied && seen.contains("\u{1b}[6n") {
                let _ = agent_write_impl(&id, &crate::commands::base64_encode(b"\x1b[1;1R"));
                replied = true;
            }
            assert!(std::time::Instant::now() < deadline, "timed out; saw: {seen:?}");
            std::thread::sleep(std::time::Duration::from_millis(200));
        }

        // Offset semantics: reading from the end returns nothing new.
        let r = agent_read_impl(&id, 0).unwrap();
        let again = agent_read_impl(&id, r.offset).unwrap();
        assert_eq!(again.data_b64, "");
        assert_eq!(again.offset, r.offset);

        let list = agent_list_impl();
        let mine = list.iter().find(|s| s.id == id).unwrap();
        assert_eq!(mine.status, "exited");
        assert!(mine.cwd.contains("cm-agents-echo"));

        agent_remove_impl(&id).unwrap();
        assert!(agent_list_impl().iter().all(|s| s.id != id));
        assert!(agent_read_impl(&id, 0).is_err());
        let _ = seen;
    }

    #[test]
    fn spawn_guards() {
        let _g = crate::commands::state_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        // actingMode off → refusal before anything spawns.
        let state = setup("guards", false);
        let err = agent_spawn_impl(req(Some(state.to_string_lossy().into_owned()))).unwrap_err();
        assert!(err.to_lowercase().contains("acting"), "got: {err}");

        let _enabled = setup("guards2", true);
        // Relative createCwd path → error.
        let mut r = req(Some("relative\\newproj".into()));
        r.create_cwd = true;
        let err = agent_spawn_impl(r).unwrap_err();
        assert!(err.contains("absolute"), "got: {err}");
        // Neither cwd nor resume → error.
        assert!(agent_spawn_impl(req(None)).is_err());
        // Both cwd and resume → error.
        let mut both = req(Some("C:\\Windows".into()));
        both.resume = Some(ResumeRef { project_id: "p".into(), session_id: "s".into() });
        assert!(agent_spawn_impl(both).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn persist_and_restore_round_trip() {
        let _g = crate::commands::state_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let state = setup("persist", true);
        let cwd = state.to_string_lossy().into_owned();

        // A session that stays alive: cmd.exe with no /c payload.
        let id = agent_spawn_impl(SpawnReq {
            bin: "cmd.exe".into(),
            args: vec![],
            title: Some("persist-test".into()),
            cwd: Some(cwd.clone()),
            create_cwd: false,
            resume: None,
        })
        .unwrap();

        // Spawn mirrored the registry to app state.
        let raw = crate::commands::read_app_state(PERSIST_KEY).unwrap().unwrap();
        assert!(raw.contains("persist-test") && raw.contains("cmd.exe"), "got: {raw}");

        // Kill+remove empties the mirror (killed sessions must not revive).
        stop_test_session(&id);
        let raw_after = crate::commands::read_app_state(PERSIST_KEY).unwrap().unwrap();
        assert_eq!(raw_after, "[]");

        // Pretend an old serve died while this was running, then reboot.
        crate::commands::write_app_state(PERSIST_KEY, &raw).unwrap();
        restore_persisted();
        let revived: Vec<AgentSessionInfo> = agent_list_impl()
            .into_iter()
            .filter(|s| s.title == "persist-test" && s.status == "running")
            .collect();
        assert_eq!(revived.len(), 1, "expected exactly one revived session");
        stop_test_session(&revived[0].id);

        // With acting mode off, restore refuses and clears the mirror.
        crate::commands::write_app_state(PERSIST_KEY, &raw).unwrap();
        crate::commands::write_app_state("settings", "{\"actingMode\":false}").unwrap();
        restore_persisted();
        assert!(agent_list_impl().iter().all(|s| s.title != "persist-test"));
        assert_eq!(crate::commands::read_app_state(PERSIST_KEY).unwrap().unwrap(), "[]");
    }

    #[test]
    fn create_cwd_traversal_rejected() {
        let _g = crate::commands::state_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let state = setup("traversal", true);
        let mut r = req(Some(format!("{}\\proj\\..\\evil", state.display())));
        r.create_cwd = true;
        let err = agent_spawn_impl(r).unwrap_err();
        assert!(err.contains(". or .."), "got: {err}");
    }

    #[test]
    fn resume_missing_errors() {
        let _g = crate::commands::state_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _state = setup("resume", true);
        let mut r = req(None);
        r.resume = Some(ResumeRef {
            project_id: "no-such-project".into(),
            session_id: "no-such-session".into(),
        });
        let err = agent_spawn_impl(r).unwrap_err();
        assert!(err.contains("no-such-"), "got: {err}");
        // Traversal in resume ids is rejected outright.
        let mut evil = req(None);
        evil.resume = Some(ResumeRef { project_id: "..".into(), session_id: "x".into() });
        assert!(agent_spawn_impl(evil).unwrap_err().contains("bad resume ids"));
        // Drive-relative names replace the base on PathBuf::push — rejected too.
        let mut evil = req(None);
        evil.resume = Some(ResumeRef { project_id: "C:evil".into(), session_id: "x".into() });
        assert!(agent_spawn_impl(evil).unwrap_err().contains("bad resume ids"));
    }

    #[test]
    fn ring_overflow_and_clamp() {
        let mut buf = Vec::new();
        let mut base = 0u64;
        append(&mut buf, &mut base, &vec![1u8; RING_CAP]);
        assert_eq!((buf.len(), base), (RING_CAP, 0));
        // Overflow by 100: oldest 100 bytes dropped, base advances.
        append(&mut buf, &mut base, &[2u8; 100]);
        assert_eq!((buf.len(), base), (RING_CAP, 100));
        assert_eq!(buf[RING_CAP - 101], 1);
        assert_eq!(buf[RING_CAP - 100], 2);
        // Offset below base → replay from the ring's start.
        let (start, end) = ring_from(base, buf.len(), 0);
        assert_eq!((start, end), (0, base + RING_CAP as u64));
        // Offset inside the ring → relative index.
        assert_eq!(ring_from(base, buf.len(), base + 5).0, 5);
        // Offset beyond the end (stale client) → empty read, offset pinned to end.
        assert_eq!(ring_from(base, buf.len(), end + 999), (buf.len(), end));
    }
}
