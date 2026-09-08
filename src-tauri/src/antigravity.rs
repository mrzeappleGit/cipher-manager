//! Read-only scanner for Google Antigravity history (~/.gemini/antigravity-cli).
//! Full agent transcripts live in opaque per-conversation SQLite blobs, but
//! `history.jsonl` records every user prompt with its text, timestamp,
//! workspace (cwd), and conversationId — enough to surface Antigravity
//! conversations as sessions, merge them into projects, and make the prompts
//! searchable + semantically recallable. No token usage is recorded.

use crate::model::{Message, SessionSummary, TokenTotals};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::PathBuf;

pub fn antigravity_root() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CIPHER_ANTIGRAVITY_DIR") {
        let pb = PathBuf::from(p);
        return pb.is_dir().then_some(pb);
    }
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    let pb = PathBuf::from(home).join(".gemini").join("antigravity-cli");
    pb.is_dir().then_some(pb)
}

pub struct AgSession {
    pub id: String, // "antigravity-<convId>"
    pub cwd: String,
    pub prompts: Vec<(String, i64)>, // (text, epoch-ms)
    pub summary: SessionSummary,
}

/// Epoch-ms → RFC3339-ish UTC string (matches the app's timestamp strings well
/// enough for sorting/display). Avoids a chrono dep on the hot path.
fn iso(ms: i64) -> String {
    let secs = ms / 1000;
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default()
}

/// True for a real prompt (not a slash command or empty line).
fn is_prompt(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str) != Some("slash_command")
        && v.get("display")
            .and_then(Value::as_str)
            .map(|d| !d.trim().is_empty() && !d.trim_start().starts_with('/'))
            .unwrap_or(false)
}

/// Parse history.jsonl into one session per conversationId. Prompts without a
/// conversationId are dropped — Antigravity re-logs them with an id once the
/// conversation starts (verified in the on-disk history).
pub fn scan_all_antigravity() -> Vec<AgSession> {
    let Some(root) = antigravity_root() else { return Vec::new() };
    let path = root.join("history.jsonl");
    let Ok(f) = std::fs::File::open(&path) else { return Vec::new() };

    struct Acc {
        cwd: String,
        prompts: Vec<(String, i64)>,
    }
    let mut convs: BTreeMap<String, Acc> = BTreeMap::new();

    for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if !is_prompt(&v) {
            continue;
        }
        let Some(conv) = v.get("conversationId").and_then(Value::as_str) else { continue };
        let text = v.get("display").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let ts = v.get("timestamp").and_then(Value::as_i64).unwrap_or(0);
        let cwd = v.get("workspace").and_then(Value::as_str).unwrap_or("").to_string();
        let acc = convs.entry(conv.to_string()).or_insert_with(|| Acc {
            cwd: cwd.clone(),
            prompts: Vec::new(),
        });
        if acc.cwd.is_empty() {
            acc.cwd = cwd;
        }
        // Antigravity double-logs a prompt (once without a conv id, once with);
        // dedupe identical consecutive texts.
        if acc.prompts.last().map(|(t, _)| t != &text).unwrap_or(true) {
            acc.prompts.push((text, ts));
        }
    }

    convs
        .into_iter()
        .filter(|(_, a)| !a.prompts.is_empty())
        .map(|(conv, a)| {
            let first = a.prompts.first().map(|(t, _)| t.clone());
            let start = a.prompts.first().map(|(_, ms)| iso(*ms));
            let end = a.prompts.last().map(|(_, ms)| iso(*ms));
            let id = format!("antigravity-{conv}");
            AgSession {
                id: id.clone(),
                cwd: a.cwd.clone(),
                prompts: a.prompts.clone(),
                summary: SessionSummary {
                    id,
                    project_id: String::new(),
                    title: None,
                    first_prompt: first.map(|t| t.chars().take(280).collect()),
                    message_count: a.prompts.len(),
                    user_messages: a.prompts.len(),
                    assistant_messages: 0, // responses live in opaque SQLite blobs
                    size_bytes: 0,
                    start_time: start,
                    end_time: end,
                    tokens: TokenTotals::default(),
                    cost_usd: 0.0,
                    models: vec![],
                    git_branch: None,
                    has_subagents: false,
                    tool: "antigravity".into(),
                },
            }
        })
        .collect()
}

/// Stable project id for an Antigravity-only workspace.
pub fn antigravity_project_id(cwd: &str) -> String {
    format!("antigravity--{}", cwd.to_lowercase().replace(['\\', '/', ':'], "-"))
}

/// Full "transcript" = the user's prompts (assistant side is not recoverable
/// from history.jsonl). Makes an Antigravity session clickable.
pub fn antigravity_session_detail(session_id: &str) -> Option<(AgSession, Vec<Message>)> {
    let s = scan_all_antigravity().into_iter().find(|s| s.id == session_id)?;
    let messages = s
        .prompts
        .iter()
        .map(|(text, ms)| Message {
            uuid: None,
            role: "user".into(),
            kind: "message".into(),
            timestamp: Some(iso(*ms)),
            model: None,
            text: text.clone(),
            thinking: None,
            tool_calls: vec![],
            tokens: None,
            cost_usd: 0.0,
            is_sidechain: false,
        })
        .collect();
    Some((s, messages))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_groups_by_conversation() {
        let dir = std::env::temp_dir().join("cm-ag-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let jsonl = concat!(
            r#"{"display":"/model","timestamp":1,"workspace":"G:\\x","type":"slash_command"}"#, "\n",
            r#"{"display":"fix the login bug","timestamp":1783657008827,"workspace":"G:\\x"}"#, "\n",
            r#"{"display":"fix the login bug","timestamp":1783657008900,"workspace":"G:\\x","conversationId":"c1"}"#, "\n",
            r#"{"display":"now add tests","timestamp":1783657100000,"workspace":"G:\\x","conversationId":"c1"}"#, "\n",
        );
        std::fs::write(dir.join("history.jsonl"), jsonl).unwrap();
        std::env::set_var("CIPHER_ANTIGRAVITY_DIR", &dir);

        let sessions = scan_all_antigravity();
        std::env::remove_var("CIPHER_ANTIGRAVITY_DIR");
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.id, "antigravity-c1");
        assert_eq!(s.cwd, "G:\\x");
        assert_eq!(s.summary.user_messages, 2); // slash command skipped, dupe merged
        assert_eq!(s.summary.first_prompt.as_deref(), Some("fix the login bug"));
        assert_eq!(s.summary.tool, "antigravity");
    }
}

/// Digest for semantic indexing: the conversation's prompts as chunks
/// (mirrors brain::session_digest). Title = first prompt.
pub fn antigravity_digest(session_id: &str) -> (Option<String>, Vec<crate::brain::DigestChunk>) {
    let Some((s, _)) = antigravity_session_detail(session_id) else {
        return (None, vec![]);
    };
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    for (text, _) in &s.prompts {
        let t = text.trim();
        if t.len() < 15 {
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
    (s.summary.first_prompt.clone(), digest_chunks)
}
