//! Locating and walking the `~/.claude` data directory.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// Root of the Claude Code data dir. Honors `CIPHER_CLAUDE_DIR` override.
pub fn claude_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CIPHER_CLAUDE_DIR") {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return Some(pb);
        }
    }
    let root = dirs::home_dir()?.join(".claude");
    if root.is_dir() {
        Some(root)
    } else {
        None
    }
}

pub fn projects_dir() -> Option<PathBuf> {
    claude_root().map(|r| r.join("projects"))
}

/// Where archived (soft-deleted) sessions are moved.
pub fn archive_dir() -> Option<PathBuf> {
    claude_root().map(|r| r.join("cipher-archive"))
}

/// Encode a real path the same way Claude Code names project dirs:
/// every non-alphanumeric character becomes '-'.
pub fn encode_path(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect()
}

/// List the encoded project directory ids.
pub fn list_project_ids() -> Vec<String> {
    let Some(dir) = projects_dir() else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.path().is_dir() {
                if let Some(name) = e.file_name().to_str() {
                    // Skip our own archive dir if it somehow lands here.
                    if name == "cipher-archive" {
                        continue;
                    }
                    ids.push(name.to_string());
                }
            }
        }
    }
    ids.sort();
    ids
}

/// Recursive byte size of a directory (best effort).
pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for e in entries.flatten() {
            let p = e.path();
            match e.file_type() {
                Ok(ft) if ft.is_dir() => total += dir_size(&p),
                Ok(ft) if ft.is_file() => {
                    if let Ok(md) = e.metadata() {
                        total += md.len();
                    }
                }
                _ => {}
            }
        }
    }
    total
}

/// All `*.jsonl` files under a directory, recursively.
pub fn jsonl_files_recursive(path: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(path) {
        for e in entries.flatten() {
            let p = e.path();
            match e.file_type() {
                Ok(ft) if ft.is_dir() => jsonl_files_recursive(&p, out),
                Ok(ft) if ft.is_file() => {
                    if p.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                        out.push(p);
                    }
                }
                _ => {}
            }
        }
    }
}

/// Top-level `*.jsonl` files in a project directory (one per session).
pub fn top_level_sessions(project_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(project_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// Read the first `cwd` value found in a session file (the real project path).
pub fn first_cwd_in_file(file: &Path) -> Option<String> {
    let f = fs::File::open(file).ok()?;
    let reader = BufReader::new(f);
    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() || !line.contains("\"cwd\"") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(cwd) = v.get("cwd").and_then(|c| c.as_str()) {
                if !cwd.is_empty() {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

/// Build a map of encoded-id -> real path by scanning `history.jsonl`.
/// This recovers real paths even for projects whose sessions were deleted.
pub fn history_path_map() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(root) = claude_root() else {
        return map;
    };
    let hist = root.join("history.jsonl");
    let Ok(f) = fs::File::open(&hist) else {
        return map;
    };
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(proj) = v.get("project").and_then(|p| p.as_str()) {
                if !proj.is_empty() {
                    map.entry(encode_path(proj)).or_insert_with(|| proj.to_string());
                }
            }
        }
    }
    map
}

/// Derive a display name (last path segment) from a real path.
pub fn display_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let seg = trimmed
        .rsplit(['/', '\\'])
        .find(|s| !s.is_empty())
        .unwrap_or(trimmed);
    if seg.is_empty() {
        path.to_string()
    } else {
        seg.to_string()
    }
}
