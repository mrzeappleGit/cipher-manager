//! Universal-search backends for the command palette: installed applications
//! (Start Menu shortcuts) and local files (the Windows Search index).
//! Launching is *not* here — results go back through commands::open_path,
//! which already canonicalizes and rejects anything that isn't a real path.
//! Desktop-only: no serve.rs arms.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde::Serialize;

use crate::commands;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AppEntry {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FileHit {
    pub name: String,
    pub path: String,
}

/// Start Menu shortcuts that nobody wants to launch from a search bar.
const NOISE: [&str; 6] = ["uninstall", "readme", "release notes", "license", "help", "documentation"];

fn is_noise(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    NOISE.iter().any(|n| lower.contains(n))
}

fn start_menu_roots() -> Vec<PathBuf> {
    let mut roots = vec![];
    // Per-user (%APPDATA%) then all-users (%ProgramData%).
    if let Some(d) = dirs::data_dir() {
        roots.push(d.join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Ok(pd) = std::env::var("ProgramData") {
        roots.push(PathBuf::from(pd).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    roots
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<AppEntry>) {
    // Start Menu trees are shallow; the cap just stops a symlink loop.
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, depth + 1, out);
            continue;
        }
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "lnk" && ext != "url" {
            continue;
        }
        let Some(name) = p.file_stem().and_then(|s| s.to_str()) else { continue };
        if is_noise(name) {
            continue;
        }
        out.push(AppEntry { name: name.to_string(), path: p.to_string_lossy().to_string() });
    }
}

/// Sort by name and drop same-named duplicates — most apps install a shortcut
/// under both the per-user and all-users Start Menu.
fn dedupe(mut apps: Vec<AppEntry>) -> Vec<AppEntry> {
    apps.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    apps.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    apps
}

// ponytail: scanned once per app run. Installing something new needs a restart
// before it shows up; swap the OnceLock for a mtime check if that ever bites.
static APPS: OnceLock<Vec<AppEntry>> = OnceLock::new();

fn scan_apps() -> Vec<AppEntry> {
    let mut out = vec![];
    for root in start_menu_roots() {
        walk(&root, 0, &mut out);
    }
    dedupe(out)
}

#[tauri::command]
pub async fn list_apps() -> Result<Vec<AppEntry>, String> {
    if let Some(cached) = APPS.get() {
        return Ok(cached.clone());
    }
    let apps = tauri::async_runtime::spawn_blocking(scan_apps)
        .await
        .map_err(|e| e.to_string())?;
    Ok(APPS.get_or_init(|| apps).clone())
}

// ---------------------------------------------------------------------------
// File search (Windows Search index)
// ---------------------------------------------------------------------------

/// Queries the index Windows already maintains, so there's nothing to build and
/// no dependency to install. Anything the index doesn't cover (excluded drives,
/// indexing switched off) simply returns no rows. A failure prints `[]` rather
/// than erroring — this runs on every keystroke and must never raise a toast.
const SEARCH_FILES_PS: &str = r#"
param([string]$Query, [int]$Limit = 20)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $sql = "SELECT TOP $Limit System.ItemPathDisplay, System.ItemNameDisplay FROM SYSTEMINDEX " +
         "WHERE CONTAINS(System.FileName, '""$Query*""') ORDER BY System.DateModified DESC"
  $conn = New-Object -ComObject ADODB.Connection
  $conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows'")
  $rs = $conn.Execute($sql)
  $rows = @()
  while (-not $rs.EOF) {
    $p = $rs.Fields.Item(0).Value
    if ($p) { $rows += [pscustomobject]@{ name = $rs.Fields.Item(1).Value; path = $p } }
    $rs.MoveNext()
  }
  $rs.Close()
  $conn.Close()
  ConvertTo-Json -InputObject $rows -Compress -Depth 3
} catch {
  Write-Output '[]'
}
"#;

/// The query is interpolated into a SQL string literal inside a CONTAINS
/// predicate, so both quote characters have to go. Backslashes and control
/// characters go too; none of them are useful in a file-name search.
fn sanitize_query(q: &str) -> String {
    q.chars()
        .filter(|c| !matches!(c, '\'' | '"' | '\\') && !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(64)
        .collect()
}

/// Index rows nobody wants from a launcher. These dominate an unfiltered
/// result set because caches are rewritten constantly and the query is ordered
/// by modification time — "Code Cache\js\index-dir" beating your notes.
const NOISE_SEGMENTS: [&str; 9] = [
    r"\cache\",
    r"\code cache\",
    r"\__pycache__\",
    r"\node_modules\",
    r"\.git\",
    r"\appdata\local\temp\",
    r"\$recycle.bin\",
    r"\.venv\",
    r"\target\debug\",
];
const NOISE_EXT: [&str; 6] = ["pyc", "pyo", "tmp", "log", "lock", "crdownload"];

fn is_useful(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if NOISE_SEGMENTS.iter().any(|s| lower.contains(s)) {
        return false;
    }
    match lower.rsplit_once('.') {
        Some((_, ext)) => !NOISE_EXT.contains(&ext),
        None => true,
    }
}

fn parse_hits(json: &str) -> Vec<FileHit> {
    let v: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let items: Vec<&serde_json::Value> = match &v {
        serde_json::Value::Array(a) => a.iter().collect(),
        serde_json::Value::Null => vec![],
        o => vec![o],
    };
    items
        .into_iter()
        .filter_map(|it| {
            let path = it.get("path")?.as_str()?.to_string();
            let name = it
                .get("name")
                .and_then(|n| n.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
                .unwrap_or_else(|| path.clone());
            Some(FileHit { name, path })
        })
        .collect()
}

fn search_files_impl(query: &str, limit: u32) -> Result<Vec<FileHit>, String> {
    let q = sanitize_query(query);
    // One or two characters match half the disk; not worth the round trip.
    if q.len() < 2 {
        return Ok(vec![]);
    }
    let want = limit.clamp(1, 50) as usize;
    // Over-fetch so filtering junk out still leaves a full list.
    let fetch = (want * 4).min(200);
    let script = std::env::temp_dir().join("cipher-manager-search-files.ps1");
    std::fs::write(&script, SEARCH_FILES_PS)
        .map_err(|e| format!("couldn't write file-search script: {e}"))?;
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(["-Query", &q, "-Limit", &fetch.to_string()]);
    commands::no_window(&mut c);
    let out = c.output().map_err(|e| format!("couldn't search files: {e}"))?;
    let mut hits = parse_hits(&String::from_utf8_lossy(&out.stdout));
    hits.retain(|h| is_useful(&h.path));
    hits.truncate(want);
    Ok(hits)
}

#[tauri::command]
pub async fn search_files(query: String, limit: Option<u32>) -> Result<Vec<FileHit>, String> {
    tauri::async_runtime::spawn_blocking(move || search_files_impl(&query, limit.unwrap_or(20)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_cannot_break_out_of_the_sql_literal() {
        // Both quote styles would end the string / the CONTAINS phrase.
        assert_eq!(sanitize_query("foo'; DROP TABLE --"), "foo; DROP TABLE --");
        assert_eq!(sanitize_query(r#"a"* OR "b"#), "a* OR b");
        assert_eq!(sanitize_query("nul\u{0}byte"), "nulbyte");
        assert_eq!(sanitize_query(r"C:\temp\notes"), "C:tempnotes");
        assert_eq!(sanitize_query("  spaced  "), "spaced");
        assert_eq!(sanitize_query(&"x".repeat(200)).len(), 64);
        let clean = sanitize_query("report 2026");
        assert_eq!(clean, "report 2026");
    }

    #[test]
    fn short_queries_never_spawn_powershell() {
        assert_eq!(search_files_impl("a", 20).unwrap(), vec![]);
        assert_eq!(search_files_impl("'", 20).unwrap(), vec![]); // sanitizes to empty
    }

    #[test]
    fn hits_parse_from_array_and_single_object() {
        let many = r#"[{"name":"a.md","path":"C:\\notes\\a.md"},{"name":"b.md","path":"C:\\b.md"}]"#;
        assert_eq!(parse_hits(many).len(), 2);
        let one = r#"{"name":"solo.md","path":"C:\\solo.md"}"#;
        assert_eq!(parse_hits(one)[0].name, "solo.md");
        // No name column value: fall back to the path so the row is still usable.
        let nameless = r#"{"path":"C:\\x.md"}"#;
        assert_eq!(parse_hits(nameless)[0].name, r"C:\x.md");
        assert!(parse_hits("[]").is_empty());
        assert!(parse_hits("boom").is_empty());
    }

    #[test]
    fn cache_and_build_junk_is_kept_out_of_results() {
        assert!(is_useful(r"C:\Users\me\Documents\notes\plan.md"));
        assert!(is_useful(r"C:\Users\me\Desktop\remote")); // extensionless folder
        assert!(!is_useful(r"C:\Users\me\Documents\Game\Renderer\Code Cache\js\the-real-index"));
        assert!(!is_useful(r"C:\proj\node_modules\react\index.js"));
        assert!(!is_useful(r"C:\proj\pkg\__pycache__\remotecdm.cpython-310.pyc"));
        assert!(!is_useful(r"C:\proj\.git\HEAD"));
        assert!(!is_useful(r"C:\Users\me\AppData\Local\Temp\scratch.txt"));
        assert!(!is_useful(r"C:\proj\build.log"));
        // A path merely containing the word "cache" is fine — only real segments.
        assert!(is_useful(r"C:\Users\me\Documents\cache-design-notes.md"));
    }

    #[test]
    fn shortcut_noise_is_filtered_and_duplicates_collapse() {
        assert!(is_noise("Uninstall Slack"));
        assert!(is_noise("Release Notes"));
        assert!(!is_noise("Slack"));
        let apps = dedupe(vec![
            AppEntry { name: "Zoom".into(), path: r"C:\b\Zoom.lnk".into() },
            AppEntry { name: "Blender".into(), path: r"C:\a\Blender.lnk".into() },
            AppEntry { name: "zoom".into(), path: r"C:\a\zoom.lnk".into() },
        ]);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].name, "Blender"); // sorted, case-insensitively
    }

    /// Live probe for both search backends on this machine: the real Start Menu
    /// and the real Windows Search index. Either coming back empty means the
    /// palette's Apps / Files groups would silently never appear.
    /// `cargo test -- --ignored --nocapture real_launcher`
    #[test]
    #[ignore = "reads the live Start Menu and search index — run explicitly"]
    fn real_launcher() {
        let apps = scan_apps();
        eprintln!("{} apps, first 10:", apps.len());
        for a in apps.iter().take(10) {
            eprintln!("  {} — {}", a.name, a.path);
        }
        assert!(!apps.is_empty(), "no Start Menu shortcuts found on a live desktop");

        let hits = search_files_impl("re", 10).expect("search failed");
        eprintln!("{} file hits:", hits.len());
        for h in &hits {
            eprintln!("  {} — {}", h.name, h.path);
        }
        assert!(!hits.is_empty(), "Windows Search returned nothing — index off?");
    }
}
