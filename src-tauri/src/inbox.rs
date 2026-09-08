//! Memory Promotion Inbox (second-brain slice 3). The harvest PROPOSES notes;
//! nothing reaches the vault until a human approves (or the explicit
//! memoryAutoPromote automation class bypasses the inbox skill-side).
//! Store: backend-owned JSON via app_state ("memory-inbox"). Writes: only
//! through commands::write_vault (confined). Dedupe: sha256 source hash,
//! checked against every stored proposal AND the target note's frontmatter.

use sha2::{Digest, Sha256};

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub kind: String, // "session" | "meeting" | "note" | "other"
    pub label: String, // human-readable, shown in the UI
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub message_uuid: Option<String>,
    #[serde(default)]
    pub rel: Option<String>, // vault-relative path for meeting/note sources
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,         // "prop-" + first 12 hex chars of source_hash
    pub op: String,         // "create" | "update" — inferred at propose time
    pub target_rel: String, // e.g. "output/memory/2026-07-15-oauth-fix.md"
    pub title: String,
    pub note_type: String, // decision | fix | preference | lesson | project-context
    pub project: String,
    pub body: String, // markdown body WITHOUT frontmatter
    pub reason: String,
    pub sources: Vec<Source>,
    pub source_hash: String,
    pub status: String, // "pending" | "approved" | "rejected"
    pub created_ms: u64,
    #[serde(default)]
    pub decided_ms: Option<u64>,
}

/// What the harvest sends (everything but the fields the backend derives).
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewProposal {
    pub target_rel: String,
    pub title: String,
    #[serde(default = "default_note_type")]
    pub note_type: String,
    #[serde(default)]
    pub project: String,
    pub body: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub sources: Vec<Source>,
}
fn default_note_type() -> String {
    "lesson".into()
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProposeResult {
    pub accepted: usize,
    pub duplicates: usize,
    pub rejected_paths: usize,
}

const STORE_KEY: &str = "memory-inbox";
/// Decided proposals kept for dedupe/history; oldest pruned past this.
/// ponytail: approved notes still dedupe via their frontmatter after pruning;
/// only ancient REJECTED items can resurface. Raise if that ever stings.
const MAX_DECIDED: usize = 200;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ponytail: load->mutate->save with no cross-process lock (app + serve); nightly cadence makes the race window irrelevant — add a file lock if the inbox ever gets chatty.
fn load() -> Result<Vec<Proposal>, String> {
    Ok(crate::commands::read_app_state(STORE_KEY)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

fn save(list: &[Proposal]) -> Result<(), String> {
    crate::commands::write_app_state(STORE_KEY, &serde_json::to_string(list).map_err(|e| e.to_string())?)
}

/// One stable line per source, used for both hashing and frontmatter.
fn source_line(s: &Source) -> String {
    match s.kind.as_str() {
        "session" => format!(
            "session: {}/{}{}",
            s.project_id.as_deref().unwrap_or("?"),
            s.session_id.as_deref().unwrap_or("?"),
            s.message_uuid.as_deref().map(|u| format!("#{u}")).unwrap_or_default()
        ),
        _ => match &s.rel {
            Some(rel) => format!("{}: {}", s.kind, rel),
            None => format!("{}: {}", s.kind, s.label),
        },
    }
}

/// sha256 of the normalized target + sorted source identity lines. Same
/// sources aimed at the same note = same hash, however the prose is worded.
fn source_hash(target_rel: &str, sources: &[Source]) -> String {
    let mut lines: Vec<String> = sources.iter().map(source_line).collect();
    lines.sort();
    let norm = format!("{}\n{}", target_rel.to_lowercase().replace('\\', "/"), lines.join("\n"));
    Sha256::digest(norm.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Same path rules as commands::write_vault, checked at propose time so bad
/// targets never enter the store.
fn valid_target(rel: &str) -> bool {
    let p = std::path::Path::new(rel);
    !rel.trim().is_empty()
        && p.components().all(|c| matches!(c, std::path::Component::Normal(_)))
        && p.extension().and_then(|s| s.to_str()) == Some("md")
}

/// source_hash recorded in an existing note's frontmatter, if any.
fn existing_note_hash(dir: &str, rel: &str) -> Option<String> {
    let base = std::path::Path::new(dir).canonicalize().ok()?;
    let text = std::fs::read_to_string(base.join(rel)).ok()?;
    let mut in_frontmatter = false;
    for line in text.lines() {
        if line == "---" {
            if in_frontmatter {
                // Reached the closing fence.
                break;
            }
            // Opening fence.
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if let Some(h) = line.strip_prefix("source_hash: ") {
                return Some(h.trim().to_string());
            }
        }
    }
    None
}

pub fn inbox_list_impl() -> Result<Vec<Proposal>, String> {
    let mut list = load()?;
    // Pending first, newest first within each group.
    list.sort_by(|a, b| {
        let ap = (a.status != "pending") as u8;
        let bp = (b.status != "pending") as u8;
        ap.cmp(&bp).then(b.created_ms.cmp(&a.created_ms))
    });
    Ok(list)
}

pub fn inbox_propose_impl(dir: &str, items: Vec<NewProposal>) -> Result<ProposeResult, String> {
    let mut list = load()?;
    let mut known: std::collections::HashSet<String> =
        list.iter().map(|p| p.source_hash.clone()).collect();
    let base_ok = std::path::Path::new(dir).canonicalize().is_ok();
    if !base_ok {
        return Err(format!("vault folder not found: {dir}"));
    }
    let (mut accepted, mut duplicates, mut rejected_paths) = (0usize, 0usize, 0usize);
    for it in items {
        if !valid_target(&it.target_rel) {
            rejected_paths += 1;
            continue;
        }
        let hash = source_hash(&it.target_rel, &it.sources);
        if known.contains(&hash) || existing_note_hash(dir, &it.target_rel).as_deref() == Some(hash.as_str()) {
            duplicates += 1;
            continue;
        }
        let exists = std::path::Path::new(dir).join(&it.target_rel).exists();
        list.push(Proposal {
            id: format!("prop-{}", &hash[..12]),
            op: if exists { "update".into() } else { "create".into() },
            target_rel: it.target_rel,
            title: it.title,
            note_type: it.note_type,
            project: it.project,
            body: it.body,
            reason: it.reason,
            sources: it.sources,
            source_hash: hash.clone(),
            status: "pending".into(),
            created_ms: now_ms(),
            decided_ms: None,
        });
        known.insert(hash);
        accepted += 1;
    }
    prune(&mut list);
    save(&list)?;
    Ok(ProposeResult { accepted, duplicates, rejected_paths })
}

fn prune(list: &mut Vec<Proposal>) {
    let decided: Vec<usize> = list
        .iter()
        .enumerate()
        .filter(|(_, p)| p.status != "pending")
        .map(|(i, _)| i)
        .collect();
    if decided.len() > MAX_DECIDED {
        // Drop the oldest decided entries (list is append-ordered).
        let drop: std::collections::HashSet<usize> =
            decided[..decided.len() - MAX_DECIDED].iter().copied().collect();
        let mut i = 0;
        list.retain(|_| {
            let keep = !drop.contains(&i);
            i += 1;
            keep
        });
    }
}

/// Full note content: provenance frontmatter + body.
fn render_note(p: &Proposal) -> String {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut fm = String::from("---\n");
    fm.push_str(&format!("title: {}\n", p.title.replace(['\n', ':'], " ").trim())); // ponytail: strips only \n and : — quote the title if YAML-hostile agent titles ever appear.
    fm.push_str(&format!("type: {}\n", p.note_type));
    fm.push_str("status: canonical\n");
    if !p.project.is_empty() {
        fm.push_str(&format!("project: {}\n", p.project));
    }
    fm.push_str("sources:\n");
    for s in &p.sources {
        fm.push_str(&format!("  - {}\n", source_line(s)));
    }
    fm.push_str(&format!("source_hash: {}\n", p.source_hash));
    fm.push_str(&format!("generated: {now}\nlast_verified: {now}\n---\n\n"));
    format!("{fm}{}\n", p.body.trim_end())
}

pub fn inbox_decide_impl(dir: &str, id: &str, approve: bool) -> Result<Proposal, String> {
    let mut list = load()?;
    let p = list
        .iter_mut()
        .find(|p| p.id == id && p.status == "pending")
        .ok_or_else(|| format!("no pending proposal {id}"))?;
    if approve {
        let note = render_note(p);
        crate::commands::write_vault(dir, &p.target_rel, &note)?;
        p.status = "approved".into();
    } else {
        p.status = "rejected".into();
    }
    p.decided_ms = Some(now_ms());
    let decided = p.clone();
    save(&list)?;
    Ok(decided)
}

#[tauri::command]
pub async fn inbox_list() -> Result<Vec<Proposal>, String> {
    tauri::async_runtime::spawn_blocking(inbox_list_impl).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inbox_propose(dir: String, items: Vec<NewProposal>) -> Result<ProposeResult, String> {
    tauri::async_runtime::spawn_blocking(move || inbox_propose_impl(&dir, items))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inbox_decide(dir: String, id: String, approve: bool) -> Result<Proposal, String> {
    tauri::async_runtime::spawn_blocking(move || inbox_decide_impl(&dir, &id, approve))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh state dir + vault dir per test, env guarded by the shared lock.
    fn setup(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let state = std::env::temp_dir().join(format!("cm-inbox-state-{name}"));
        let vault = std::env::temp_dir().join(format!("cm-inbox-vault-{name}"));
        for d in [&state, &vault] {
            let _ = std::fs::remove_dir_all(d);
            std::fs::create_dir_all(d).unwrap();
        }
        std::env::set_var("CIPHER_STATE_DIR", &state);
        (state, vault)
    }

    fn item(rel: &str, title: &str) -> NewProposal {
        NewProposal {
            target_rel: rel.into(),
            title: title.into(),
            note_type: "fix".into(),
            project: "cipherManager".into(),
            body: "The OAuth 401 was a stale cached token; evict on 401 and retry once.".into(),
            reason: "Reusable fix worth remembering.".into(),
            sources: vec![Source {
                kind: "session".into(),
                label: "cipherManager session".into(),
                project_id: Some("G--proj".into()),
                session_id: Some("abc-123".into()),
                message_uuid: Some("m-9".into()),
                rel: None,
            }],
        }
    }

    #[test]
    fn propose_dedupes_infers_op_and_decide_writes_or_not() {
        let _guard = crate::commands::state_env_lock().lock().unwrap();
        let (_state, vault) = setup("main");
        let vdir = vault.to_str().unwrap();

        // First propose: send same item twice in one batch, accept one, dedupe one, op=create.
        let r = inbox_propose_impl(vdir, vec![
            item("output/memory/oauth-fix.md", "OAuth fix"),
            item("output/memory/oauth-fix.md", "OAuth fix"),
        ]).unwrap();
        assert_eq!((r.accepted, r.duplicates), (1, 1));
        let list = inbox_list_impl().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].op, "create");
        assert_eq!(list[0].status, "pending");
        assert!(list[0].id.starts_with("prop-"));

        // Same item again: pure duplicate, nothing new stored.
        let r2 = inbox_propose_impl(vdir, vec![item("output/memory/oauth-fix.md", "OAuth fix")]).unwrap();
        assert_eq!((r2.accepted, r2.duplicates), (0, 1));
        assert_eq!(inbox_list_impl().unwrap().len(), 1);

        // Reject: status flips, vault untouched.
        let id = list[0].id.clone();
        let decided = inbox_decide_impl(vdir, &id, false).unwrap();
        assert_eq!(decided.status, "rejected");
        assert!(!vault.join("output/memory/oauth-fix.md").exists());

        // Different sources -> different hash -> new proposal even at the same path.
        let mut other = item("output/memory/oauth-fix.md", "OAuth fix");
        other.sources[0].session_id = Some("def-456".into());
        let r3 = inbox_propose_impl(vdir, vec![other]).unwrap();
        assert_eq!((r3.accepted, r3.duplicates), (1, 0));

        // Approve: note written with full provenance frontmatter.
        let id2 = inbox_list_impl().unwrap().iter().find(|p| p.status == "pending").unwrap().id.clone();
        let ok = inbox_decide_impl(vdir, &id2, true).unwrap();
        assert_eq!(ok.status, "approved");
        let note = std::fs::read_to_string(vault.join("output/memory/oauth-fix.md")).unwrap();
        assert!(note.starts_with("---\n"));
        for needle in ["title: OAuth fix", "type: fix", "status: canonical", "project: cipherManager",
                       &format!("source_hash: {}", ok.source_hash), "generated: ", "last_verified: ",
                       "session: G--proj/def-456#m-9"] {
            assert!(note.contains(needle), "missing {needle} in:\n{note}");
        }
        assert!(note.contains("evict on 401"));

        // Re-proposing the approved item: caught by the note's own frontmatter
        // even after the store forgets (simulate by wiping the store).
        crate::commands::write_app_state("memory-inbox", "[]").unwrap();
        let mut again = item("output/memory/oauth-fix.md", "OAuth fix");
        again.sources[0].session_id = Some("def-456".into());
        let r4 = inbox_propose_impl(vdir, vec![again]).unwrap();
        assert_eq!((r4.accepted, r4.duplicates), (0, 1));

        // A now-existing target infers op=update.
        let mut upd = item("output/memory/oauth-fix.md", "OAuth fix v2");
        upd.sources[0].session_id = Some("ghi-789".into());
        inbox_propose_impl(vdir, vec![upd]).unwrap();
        let pend: Vec<Proposal> =
            inbox_list_impl().unwrap().into_iter().filter(|p| p.status == "pending").collect();
        assert_eq!(pend.len(), 1);
        assert_eq!(pend[0].op, "update");
    }

    #[test]
    fn bad_paths_are_rejected_not_stored() {
        let _guard = crate::commands::state_env_lock().lock().unwrap();
        let (_state, vault) = setup("paths");
        let vdir = vault.to_str().unwrap();
        let mut evil = item("../escape.md", "nope");
        evil.sources[0].session_id = Some("zzz".into());
        let mut txt = item("output/memory/notes.txt", "nope");
        txt.sources[0].session_id = Some("yyy".into());
        let r = inbox_propose_impl(vdir, vec![evil, txt]).unwrap();
        assert_eq!((r.accepted, r.rejected_paths), (0, 2));
        assert!(inbox_list_impl().unwrap().is_empty());
    }
}
