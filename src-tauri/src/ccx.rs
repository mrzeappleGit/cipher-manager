//! CipherCodex → Obsidian sync (native port of the codex-harvest skill).
//!
//! CipherCodex (the EPUB reader: Android app, X4 e-reader, rM2) syncs every
//! device's state as JSON snapshots to a WebDAV store. This module pulls the
//! snapshots, merges them (per-key last-write-wins), and regenerates the
//! reading-knowledge markdown in the vault's output/codex/ — the exact file
//! format the codex-harvest skill defines, so memory-harvest, vault-curator,
//! and Obsidian search see no difference.
//!
//! The WebDAV password never appears here: requests go through
//! a credential-store placeholder resolved only inside the native fetch.
//! Redirects are refused to keep credentials on the configured origin. Desktop-only —
//! runs in the app process, so the serve.exe firewall block is irrelevant.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

const AUTH_PLACEHOLDER: &str = "Basic {{secret:ccx-webdav-basic}}";
const SECRET_ID: &str = "ccx-webdav-basic";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CodexSyncResult {
    /// Books / notebooks that produced a file.
    pub books: usize,
    pub notebooks: usize,
    /// File names written or updated this run.
    pub written: Vec<String>,
    /// Files whose regenerated content was identical (not rewritten).
    pub unchanged: usize,
    /// Books/notebooks skipped for having no annotations.
    pub skipped: usize,
}

// ---------------------------------------------------------------------------
// Merging — per key, keep the row with the highest updatedAt, drop deleted.
// ---------------------------------------------------------------------------

fn merge_table(snaps: &[Value], table: &str, key: &str) -> Vec<Value> {
    let mut best: HashMap<String, Value> = HashMap::new();
    for s in snaps {
        let Some(rows) = s.get(table).and_then(|v| v.as_array()) else { continue };
        for r in rows {
            let Some(k) = r.get(key).and_then(|v| v.as_str()) else { continue };
            let up = r.get("updatedAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let cur = best
                .get(k)
                .and_then(|b| b.get("updatedAt"))
                .and_then(|v| v.as_f64())
                .unwrap_or(-1.0);
            if up > cur {
                best.insert(k.to_string(), r.clone());
            }
        }
    }
    best.into_values()
        .filter(|r| r.get("deleted").and_then(|v| v.as_i64()).unwrap_or(0) != 1)
        .collect()
}

struct Merged {
    books: Vec<Value>,
    highlights: Vec<Value>,
    bookmarks: Vec<Value>,
    progress: Vec<Value>,
    notebooks: Vec<Value>,
    pages: Vec<Value>,
    page_texts: Vec<Value>,
}

fn merge(snaps: &[Value]) -> Merged {
    Merged {
        books: merge_table(snaps, "books", "digest"),
        highlights: merge_table(snaps, "highlights", "guid"),
        bookmarks: merge_table(snaps, "bookmarks", "guid"),
        progress: merge_table(snaps, "progress", "bookDigest"),
        notebooks: merge_table(snaps, "notebooks", "guid"),
        pages: merge_table(snaps, "pages", "guid"),
        page_texts: merge_table(snaps, "pageTexts", "pageGuid"),
    }
}

// ---------------------------------------------------------------------------
// Markdown generation (pure — mirrors the codex-harvest skill format).
// ---------------------------------------------------------------------------

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.chars().take(48).collect();
    let out = out.trim_matches('-');
    if out.is_empty() { "untitled".into() } else { out.to_string() }
}

fn ymd(ms: f64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn s<'a>(v: &'a Value, field: &str) -> &'a str {
    v.get(field).and_then(|x| x.as_str()).unwrap_or("")
}

fn n(v: &Value, field: &str) -> f64 {
    v.get(field).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

/// Regenerate all book/notebook files → (filename, content) pairs plus a count
/// of books/notebooks skipped for having no annotations.
fn generate(m: &Merged) -> (Vec<(String, String)>, usize) {
    let mut files = vec![];
    let mut skipped = 0;

    for book in &m.books {
        let digest = s(book, "digest");
        let hls = {
            let mut h: Vec<&Value> =
                m.highlights.iter().filter(|h| s(h, "bookDigest") == digest).collect();
            // Reading order: spineIndex, then startChar.
            h.sort_by(|a, b| {
                (n(a, "spineIndex") as i64, n(a, "startChar") as i64)
                    .cmp(&(n(b, "spineIndex") as i64, n(b, "startChar") as i64))
            });
            h
        };
        let bms: Vec<&Value> =
            m.bookmarks.iter().filter(|b| s(b, "bookDigest") == digest).collect();
        if hls.is_empty() && bms.is_empty() {
            skipped += 1; // reading a book isn't knowledge; marking it is
            continue;
        }

        let title = { let t = s(book, "title"); if t.is_empty() { "untitled" } else { t } };
        let author = { let a = s(book, "author"); if a.is_empty() { "unknown" } else { a } };
        let progress = m
            .progress
            .iter()
            .find(|p| s(p, "bookDigest") == digest)
            .map(|p| n(p, "percentage"))
            .unwrap_or(0.0);
        let updated = hls
            .iter()
            .map(|h| {
                let c = n(h, "createdAt");
                if c > 0.0 { c } else { n(h, "updatedAt") }
            })
            .chain(bms.iter().map(|b| n(b, "updatedAt")))
            .fold(0.0f64, f64::max);

        let mut body = format!(
            "---\ntitle: {title}\nauthor: {author}\ntype: codex-book\nprogress: {:.0}%\nupdated: {}\n---\n\n# {title} — {author}\n\n## Highlights\n",
            progress * 100.0,
            ymd(updated),
        );
        for h in &hls {
            body.push('\n');
            for line in s(h, "text").lines() {
                body.push_str("> ");
                body.push_str(line);
                body.push('\n');
            }
            let note = s(h, "note").trim();
            if !note.is_empty() {
                body.push('\n');
                body.push_str(note);
                body.push('\n');
            }
        }
        if !bms.is_empty() {
            body.push_str("\n## Bookmarks\n\n");
            for b in &bms {
                let label = s(b, "label").trim().to_string();
                let label = if label.is_empty() {
                    format!("{:.0}%", n(b, "percentage") * 100.0)
                } else {
                    label
                };
                body.push_str(&format!("- {label}\n"));
            }
        }
        files.push((format!("book-{}.md", slug(title)), body));
    }

    // Recognized handwriting text per notebook page.
    let texts: HashMap<&str, &str> = m
        .page_texts
        .iter()
        .map(|t| (s(t, "pageGuid"), s(t, "text")))
        .collect();
    for nb in &m.notebooks {
        let guid = s(nb, "guid");
        let mut pages: Vec<&Value> = m
            .pages
            .iter()
            .filter(|p| {
                s(p, "notebookGuid") == guid
                    && !texts.get(s(p, "guid")).map(|t| t.trim()).unwrap_or("").is_empty()
            })
            .collect();
        if pages.is_empty() {
            skipped += 1;
            continue;
        }
        pages.sort_by(|a, b| (n(a, "seq") as i64).cmp(&(n(b, "seq") as i64)));

        let title = { let t = s(nb, "title"); if t.is_empty() { "untitled" } else { t } };
        let updated = m
            .page_texts
            .iter()
            .filter(|t| pages.iter().any(|p| s(p, "guid") == s(t, "pageGuid")))
            .map(|t| n(t, "updatedAt"))
            .fold(0.0f64, f64::max);
        let mut body = format!(
            "---\ntitle: {title}\ntype: codex-notebook\nupdated: {}\n---\n\n# {title}\n",
            ymd(updated),
        );
        for p in &pages {
            body.push_str(&format!("\n## Page {}\n\n", n(p, "seq") as i64));
            body.push_str(texts.get(s(p, "guid")).unwrap_or(&"").trim());
            body.push('\n');
        }
        files.push((format!("notebook-{}.md", slug(title)), body));
    }

    (files, skipped)
}

// ---------------------------------------------------------------------------
// WebDAV fetch + sync entry point.
// ---------------------------------------------------------------------------

fn state_url(raw: &str) -> Result<tauri::Url, String> {
    let raw = raw.trim();
    let mut url = tauri::Url::parse(raw).map_err(|_| "Set a valid HTTPS WebDAV state URL in Settings")?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || raw.contains('\\') || raw.chars().any(char::is_whitespace)
        || raw.split("://").nth(1).unwrap_or("").split('/').next().unwrap_or("").contains('@') {
        return Err("WebDAV state URL must use HTTPS without credentials, query or fragment".into());
    }
    if !url.path().ends_with('/') { url.set_path(&format!("{}/", url.path())); }
    Ok(url)
}

fn snapshot_url(base: &tauri::Url, name: &str) -> Result<tauri::Url, String> {
    if !name.ends_with(".json") || name.len() > 255
        || !name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.')) {
        return Err("Snapshot listing contains an unsafe filename".into());
    }
    let url = base.join(name).map_err(|_| "Invalid snapshot filename")?;
    if url.origin() != base.origin() || !url.path().starts_with(base.path()) {
        return Err("Snapshot is outside the configured state directory".into());
    }
    Ok(url)
}

fn dav_get(url: &str) -> Result<(u16, String), String> {
    let agent = ureq::AgentBuilder::new().redirects(0)
        .timeout(std::time::Duration::from_secs(30)).build();
    let response = agent.get(url)
        .set("Authorization", &crate::secrets::resolve_secrets(AUTH_PLACEHOLDER)).call();
    let r = match response {
        Ok(r) | Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("CipherCodex store unreachable: {e}")),
    };
    let status = r.status();
    if status == 401 || status == 403 {
        return Err("WebDAV auth failed — check the ccx password in Settings → CipherCodex reading notes.".into());
    }
    if (300..400).contains(&status) { return Err("WebDAV redirects are not followed; configure the final HTTPS state URL".into()); }
    Ok((status, r.into_string().map_err(|e| e.to_string())?))
}

/// Names of the `*.json` snapshot files in the dufs listing.
fn snapshot_names(base: &tauri::Url) -> Result<Vec<String>, String> {
    let (status, body) = dav_get(&format!("{base}?json"))?;
    if status != 200 {
        return Err(format!("snapshot listing failed (HTTP {status})"));
    }
    let names: Vec<String> = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("paths")?.as_array().map(|a| {
                a.iter()
                    .filter_map(|p| p.get("name").and_then(|x| x.as_str()).map(String::from))
                    .collect()
            })
        })
        // dufs sometimes answers ?json with HTML — fall back to ?simple lines.
        .map(Ok)
        .unwrap_or_else(|| {
            let (st, body) = dav_get(&format!("{base}?simple"))?;
            if st != 200 {
                return Err(format!("snapshot listing failed (HTTP {st})"));
            }
            Ok(body.lines().map(|l| l.trim().to_string()).collect())
        })?;
    Ok(names.into_iter().filter(|n| n.ends_with(".json")).collect())
}

pub fn codex_sync_impl(out_dir: &str, state: &str) -> Result<CodexSyncResult, String> {
    let base = state_url(state)?;
    if !crate::secrets::has_secret(SECRET_ID) {
        return Err("Set the ccx WebDAV password in Settings → CipherCodex reading notes first.".into());
    }
    let out = Path::new(out_dir);
    if !out.is_absolute() {
        return Err("codex output folder must be an absolute path (set the vault folder in Settings)".into());
    }

    let names = snapshot_names(&base)?;
    if names.is_empty() {
        return Err("no CipherCodex snapshots found in the sync store".into());
    }
    let mut snaps = vec![];
    for name in &names {
        let url = snapshot_url(&base, name)?;
        let (status, body) = dav_get(url.as_str())?;
        if status != 200 {
            return Err(format!("snapshot {name} failed (HTTP {status})"));
        }
        snaps.push(
            serde_json::from_str::<Value>(&body)
                .map_err(|e| format!("snapshot {name} is not valid JSON ({e})"))?,
        );
    }

    let merged = merge(&snaps);
    let (files, skipped) = generate(&merged);
    let books = files.iter().filter(|(f, _)| f.starts_with("book-")).count();
    let notebooks = files.len() - books;

    // Regenerate wholesale, but only touch files whose content changed; never
    // touch other files in the folder (stale files from renamed books linger,
    // same as the skill).
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let mut written = vec![];
    let mut unchanged = 0;
    for (name, content) in files {
        let p = out.join(&name);
        if std::fs::read_to_string(&p).ok().as_deref() == Some(content.as_str()) {
            unchanged += 1;
        } else {
            std::fs::write(&p, content).map_err(|e| format!("writing {name}: {e}"))?;
            written.push(name);
        }
    }
    Ok(CodexSyncResult { books, notebooks, written, unchanged, skipped })
}

#[tauri::command]
pub async fn codex_sync(out_dir: String, state_url: String) -> Result<CodexSyncResult, String> {
    tauri::async_runtime::spawn_blocking(move || codex_sync_impl(&out_dir, &state_url))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn configured_state_urls_and_snapshot_names_are_confined() {
        let base = state_url("https://sync.example.com/ccx/state").unwrap();
        assert_eq!(base.as_str(), "https://sync.example.com/ccx/state/");
        assert_eq!(snapshot_url(&base, "device-123.json").unwrap().as_str(), "https://sync.example.com/ccx/state/device-123.json");
        for url in ["", "http://sync.example.com/", "https://user:pass@sync.example.com/", "https://@sync.example.com/", "https://sync.example.com/?json", "https://sync.example.com/#fragment", "https://sync.example.com/a\\b"] {
            assert!(state_url(url).is_err());
        }
        for name in ["../other.json", "/other.json", "//evil.example/a.json", "https://evil.example/a.json", "a\\b.json", "%2e%2e%2fother.json", "a.json?x.json", "a.json#x.json", "a b.json"] {
            assert!(snapshot_url(&base, name).is_err());
        }
    }

    fn fixture() -> Vec<Value> {
        vec![
            json!({
                "books": [
                    {"digest": "b1", "title": "Deep Work", "author": "Cal Newport", "updatedAt": 100},
                    {"digest": "b2", "title": "Unread Book", "updatedAt": 100}
                ],
                "highlights": [
                    {"guid": "h1", "bookDigest": "b1", "spineIndex": 2, "startChar": 5,
                     "text": "focus is rare", "note": "so true", "createdAt": 1752600000000i64, "updatedAt": 100},
                    {"guid": "h2", "bookDigest": "b1", "spineIndex": 1, "startChar": 0,
                     "text": "old text", "updatedAt": 100}
                ],
                "bookmarks": [{"guid": "m1", "bookDigest": "b1", "label": "ch3", "percentage": 0.5, "updatedAt": 100}],
                "progress": [{"bookDigest": "b1", "percentage": 0.42, "updatedAt": 100}],
                "notebooks": [{"guid": "n1", "title": "Ideas", "updatedAt": 100}],
                "pages": [
                    {"guid": "p1", "notebookGuid": "n1", "seq": 2, "updatedAt": 100},
                    {"guid": "p2", "notebookGuid": "n1", "seq": 1, "updatedAt": 100},
                    {"guid": "p3", "notebookGuid": "n1", "seq": 3, "updatedAt": 100}
                ],
                "pageTexts": [
                    {"pageGuid": "p1", "text": "second page", "updatedAt": 100},
                    {"pageGuid": "p2", "text": "first page", "updatedAt": 100},
                    {"pageGuid": "p3", "text": "   ", "updatedAt": 100}
                ]
            }),
            // A newer snapshot from another device: edits h2, deletes m1.
            json!({
                "highlights": [
                    {"guid": "h2", "bookDigest": "b1", "spineIndex": 1, "startChar": 0,
                     "text": "newer text", "updatedAt": 200}
                ],
                "bookmarks": [{"guid": "m1", "bookDigest": "b1", "deleted": 1, "updatedAt": 200}]
            }),
        ]
    }

    #[test]
    fn merge_keeps_newest_and_drops_deleted() {
        let m = merge(&fixture());
        let h2 = m.highlights.iter().find(|h| s(h, "guid") == "h2").unwrap();
        assert_eq!(s(h2, "text"), "newer text");
        assert!(m.bookmarks.is_empty(), "deleted bookmark must be dropped");
        assert_eq!(m.books.len(), 2);
    }

    #[test]
    fn generate_matches_skill_format() {
        let (files, skipped) = generate(&merge(&fixture()));
        assert_eq!(skipped, 1, "annotation-less book is skipped");
        assert_eq!(files.len(), 2);

        let (name, body) = files.iter().find(|(n, _)| n.starts_with("book-")).unwrap();
        assert_eq!(name, "book-deep-work.md");
        assert!(body.contains("type: codex-book"));
        assert!(body.contains("progress: 42%"));
        assert!(body.contains("updated: 2025-07-15") || body.contains("updated: 2025-07-16")); // tz-dependent day
        // Reading order: spine 1 before spine 2; note under its quote.
        let i_new = body.find("> newer text").unwrap();
        let i_focus = body.find("> focus is rare").unwrap();
        assert!(i_new < i_focus);
        assert!(body.contains("> focus is rare\n\nso true\n"));
        // Bookmark was deleted on the newer device → no Bookmarks section.
        assert!(!body.contains("## Bookmarks"));

        let (name, body) = files.iter().find(|(n, _)| n.starts_with("notebook-")).unwrap();
        assert_eq!(name, "notebook-ideas.md");
        assert!(body.contains("type: codex-notebook"));
        // Pages in seq order, blank-text page omitted.
        let i1 = body.find("## Page 1\n\nfirst page").unwrap();
        let i2 = body.find("## Page 2\n\nsecond page").unwrap();
        assert!(i1 < i2);
        assert!(!body.contains("## Page 3"));
    }

    #[test]
    fn slugs_are_safe() {
        assert_eq!(slug("Deep Work: Rules!"), "deep-work-rules");
        assert_eq!(slug("  ---  "), "untitled");
        assert!(slug(&"long ".repeat(30)).len() <= 48);
    }

    /// End-to-end against the real WebDAV store into a temp dir. Run with:
    /// `cargo test -- --ignored --nocapture real_codex_sync`
    #[test]
    #[ignore = "needs the ccx secret + network — run explicitly"]
    fn real_codex_sync() {
        let out = std::env::temp_dir().join("ccx-sync-test");
        let url = std::env::var("CM_CCX_STATE_URL").expect("set CM_CCX_STATE_URL for the explicit network test");
        let r = codex_sync_impl(out.to_str().unwrap(), &url).expect("sync");
        eprintln!("\n=== real codex sync → {} ===", out.display());
        eprintln!(
            "{} book(s), {} notebook(s); {} written, {} unchanged, {} skipped",
            r.books, r.notebooks, r.written.len(), r.unchanged, r.skipped
        );
        for w in &r.written {
            eprintln!("  {w}");
        }
    }
}
