//! Read-only scanner for OpenAI Codex CLI history (~/.codex/sessions).
//! Rollout files are JSONL: a session_meta line (id, cwd, timestamps), then
//! response_item events (user/assistant messages, tool calls) and event_msg
//! token_count events whose totals are CUMULATIVE — a session's usage is its
//! last token_count. Everything maps onto the app's existing model types with
//! session ids prefixed "codex-" so the UI dispatches without new surfaces.

use crate::model::{Message, SessionSummary, TokenTotals};
use serde_json::Value;
use std::collections::BTreeSet;
use std::io::BufRead;
use std::path::PathBuf;

pub fn codex_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CIPHER_CODEX_DIR") {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return Some(pb);
        }
        return None; // explicit override that doesn't exist → treat as absent
    }
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    let pb = PathBuf::from(home).join(".codex");
    pb.is_dir().then_some(pb)
}

/// One scanned rollout file.
pub struct CodexSession {
    pub id: String, // "codex-<uuid>"
    pub file: PathBuf,
    pub cwd: String,
    pub summary: SessionSummary,
}

fn rollout_files(root: &PathBuf) -> Vec<PathBuf> {
    // sessions/YYYY/MM/DD/rollout-*.jsonl — walk three fixed levels.
    let mut out = Vec::new();
    let base = root.join("sessions");
    let dirs = |p: &PathBuf| -> Vec<PathBuf> {
        std::fs::read_dir(p)
            .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default()
    };
    for y in dirs(&base) {
        for m in dirs(&y) {
            for d in dirs(&m) {
                if let Ok(rd) = std::fs::read_dir(&d) {
                    out.extend(rd.flatten().map(|e| e.path()).filter(|p| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .map(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
                            .unwrap_or(false)
                    }));
                }
            }
        }
    }
    out
}

fn text_of(content: &Value) -> String {
    content
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|c| c.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn usage_totals(info: &Value) -> TokenTotals {
    let g = |k: &str| info.pointer(&format!("/total_token_usage/{k}")).and_then(Value::as_u64).unwrap_or(0);
    let cached = g("cached_input_tokens");
    TokenTotals {
        input: g("input_tokens").saturating_sub(cached),
        output: g("output_tokens"),
        cache_read: cached,
        cache_write_5m: 0,
        cache_write_1h: 0,
    }
}

/// Scan one rollout. `messages` optionally collects transcript messages
/// (get_session); summaries pass None and stay cheap.
pub fn scan_rollout(file: &PathBuf, mut messages: Option<&mut Vec<Message>>) -> Option<CodexSession> {
    let f = std::fs::File::open(file).ok()?;
    let mut id = String::new();
    let mut cwd = String::new();
    let (mut first_ts, mut last_ts): (Option<String>, Option<String>) = (None, None);
    let mut first_prompt: Option<String> = None;
    let (mut users, mut assistants) = (0usize, 0usize);
    let mut models: BTreeSet<String> = BTreeSet::new();
    let mut tokens = TokenTotals::default();

    for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(ts) = v.get("timestamp").and_then(Value::as_str) {
            if first_ts.is_none() {
                first_ts = Some(ts.to_string());
            }
            last_ts = Some(ts.to_string());
        }
        let p = v.get("payload").unwrap_or(&Value::Null);
        match v.get("type").and_then(Value::as_str).unwrap_or("") {
            "session_meta" => {
                id = p.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                cwd = p.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
            }
            "turn_context" => {
                if let Some(m) = p.get("model").and_then(Value::as_str) {
                    models.insert(m.to_string());
                }
                if cwd.is_empty() {
                    if let Some(c) = p.get("cwd").and_then(Value::as_str) {
                        cwd = c.to_string();
                    }
                }
            }
            "event_msg" => {
                if p.get("type").and_then(Value::as_str) == Some("token_count") {
                    if let Some(info) = p.get("info") {
                        tokens = usage_totals(info); // cumulative → keep last
                    }
                }
            }
            "response_item" => {
                if p.get("type").and_then(Value::as_str) != Some("message") {
                    continue;
                }
                let role = p.get("role").and_then(Value::as_str).unwrap_or("");
                if role != "user" && role != "assistant" {
                    continue; // developer/system scaffolding
                }
                let text = text_of(p.get("content").unwrap_or(&Value::Null));
                // Codex wraps environment/context and AGENTS.md instruction
                // blobs as user input_text too — not real prompts.
                let trimmed = text.trim_start();
                let synthetic = trimmed.starts_with('<')
                    || trimmed.starts_with("# AGENTS.md")
                    || text.contains("</environment_context>")
                    || text.contains("<INSTRUCTIONS");
                if role == "user" && !synthetic {
                    users += 1;
                    if first_prompt.is_none() && !text.trim().is_empty() {
                        first_prompt = Some(text.trim().chars().take(280).collect());
                    }
                } else if role == "assistant" {
                    assistants += 1;
                }
                if let Some(out) = messages.as_deref_mut() {
                    if !text.trim().is_empty() && !(role == "user" && synthetic) {
                        out.push(Message {
                            uuid: None,
                            role: role.to_string(),
                            kind: "message".into(),
                            timestamp: v.get("timestamp").and_then(Value::as_str).map(String::from),
                            model: models.iter().next_back().cloned(),
                            text,
                            thinking: None,
                            tool_calls: vec![],
                            tokens: None,
                            cost_usd: 0.0,
                            is_sidechain: false,
                        });
                    }
                }
            }
            _ => {}
        }
    }
    if id.is_empty() {
        return None;
    }
    let size = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    let sid = format!("codex-{id}");
    Some(CodexSession {
        id: sid.clone(),
        file: file.clone(),
        cwd,
        summary: SessionSummary {
            id: sid,
            project_id: String::new(), // caller fills
            title: None,
            first_prompt,
            message_count: users + assistants,
            user_messages: users,
            assistant_messages: assistants,
            size_bytes: size,
            start_time: first_ts,
            end_time: last_ts,
            tokens,
            cost_usd: 0.0,
            models: models.into_iter().collect(),
            git_branch: None,
            has_subagents: false,
            tool: "codex".into(),
        },
    })
}

/// All Codex sessions, cheap summary scan (no message collection).
pub fn scan_all_codex() -> Vec<CodexSession> {
    let Some(root) = codex_root() else { return Vec::new() };
    rollout_files(&root)
        .iter()
        .filter_map(|f| scan_rollout(f, None))
        .collect()
}

/// Find one session by its "codex-<uuid>" id and build the full transcript.
pub fn codex_session_detail(session_id: &str) -> Option<(CodexSession, Vec<Message>)> {
    let uuid = session_id.strip_prefix("codex-")?;
    let root = codex_root()?;
    let file = rollout_files(&root).into_iter().find(|f| {
        f.file_name().and_then(|n| n.to_str()).map(|n| n.contains(uuid)).unwrap_or(false)
    })?;
    let mut messages = Vec::new();
    let scan = scan_rollout(&file, Some(&mut messages))?;
    Some((scan, messages))
}

/// Stable project id for a Codex-only folder.
pub fn codex_project_id(cwd: &str) -> String {
    // Must remain a "safe segment" (no ':', '/', '\') — web ids pass through
    // is_safe_segment before touching the filesystem.
    format!("codex--{}", cwd.to_lowercase().replace(['\\', '/', ':'], "-"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        let dir = std::env::temp_dir().join("cm-codex-test/sessions/2026/07/10");
        let _ = std::fs::remove_dir_all(std::env::temp_dir().join("cm-codex-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let jsonl = concat!(
            r#"{"timestamp":"2026-07-10T01:00:00Z","type":"session_meta","payload":{"id":"abc-123","cwd":"G:\\proj\\x","originator":"codex_cli"}}"#, "\n",
            r#"{"timestamp":"2026-07-10T01:00:01Z","type":"turn_context","payload":{"cwd":"G:\\proj\\x","model":"gpt-5.6-sol"}}"#, "\n",
            r#"{"timestamp":"2026-07-10T01:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>stuff</environment_context>"}]}}"#, "\n",
            r#"{"timestamp":"2026-07-10T01:00:03Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix the login bug"}]}}"#, "\n",
            r#"{"timestamp":"2026-07-10T01:00:09Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done — patched auth.ts."}]}}"#, "\n",
            r#"{"timestamp":"2026-07-10T01:00:10Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":50,"total_tokens":150}}}}"#, "\n",
            r#"{"timestamp":"2026-07-10T01:00:20Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":80,"output_tokens":90,"total_tokens":290}}}}"#, "\n",
        );
        let f = dir.join("rollout-2026-07-10T01-00-00-abc-123.jsonl");
        std::fs::write(&f, jsonl).unwrap();
        f
    }

    #[test]
    fn rollout_scan_fixture() {
        let f = fixture();
        let mut msgs = Vec::new();
        let s = scan_rollout(&f, Some(&mut msgs)).unwrap();
        assert_eq!(s.id, "codex-abc-123");
        assert_eq!(s.cwd, "G:\\proj\\x");
        assert_eq!(s.summary.user_messages, 1); // synthetic env blob skipped
        assert_eq!(s.summary.assistant_messages, 1);
        assert_eq!(s.summary.first_prompt.as_deref(), Some("fix the login bug"));
        assert_eq!(s.summary.tool, "codex");
        assert!(s.summary.models.contains(&"gpt-5.6-sol".to_string()));
        // Cumulative usage: LAST token_count wins; cached split out of input.
        assert_eq!(s.summary.tokens.input, 120);
        assert_eq!(s.summary.tokens.cache_read, 80);
        assert_eq!(s.summary.tokens.output, 90);
        assert_eq!(msgs.len(), 2);
        let _ = std::fs::remove_dir_all(std::env::temp_dir().join("cm-codex-test"));
    }
}

/// Digest for semantic indexing: up to 3 ~1200-char chunks of real user
/// messages plus a title (the first prompt) — mirrors brain::session_digest.
pub fn codex_digest(file: &PathBuf) -> (Option<String>, Vec<crate::brain::DigestChunk>) {
    let mut msgs = Vec::new();
    let Some(scan) = scan_rollout(file, Some(&mut msgs)) else {
        return (None, vec![]);
    };
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    for m in msgs.iter().filter(|m| m.role == "user") {
        let t = m.text.trim();
        if t.len() < 20 {
            continue;
        }
        if cur.len() + t.len() > 1200 && !cur.is_empty() {
            chunks.push(cur.clone());
            cur.clear();
            if chunks.len() >= 3 {
                break;
            }
        }
        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(&t.chars().take(1200).collect::<String>());
    }
    if !cur.is_empty() && chunks.len() < 3 {
        chunks.push(cur);
    }
    let digest_chunks: Vec<crate::brain::DigestChunk> = chunks
        .into_iter()
        .map(|text| crate::brain::DigestChunk { text, kind: "intent", uuid: None })
        .collect();
    (scan.summary.first_prompt.clone(), digest_chunks)
}
