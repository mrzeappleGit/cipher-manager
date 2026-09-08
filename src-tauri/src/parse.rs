//! Parsing Claude Code `.jsonl` transcript files.

use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde_json::Value;

use crate::model::{Message, TokenTotals, ToolCall};
use crate::pricing;

const MAX_TEXT_LEN: usize = 24_000;
const MAX_TOOL_PREVIEW: usize = 400;

/// Pull the token breakdown out of a `message.usage` object.
pub fn extract_usage(usage: &Value) -> TokenTotals {
    let g = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);

    let cache_write_total = g("cache_creation_input_tokens");
    let (mut w5, mut w1) = (0u64, 0u64);
    if let Some(cc) = usage.get("cache_creation") {
        w5 = cc
            .get("ephemeral_5m_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        w1 = cc
            .get("ephemeral_1h_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
    }
    // If no breakdown was present, bill the whole creation total at the 5m rate.
    if w5 == 0 && w1 == 0 {
        w5 = cache_write_total;
    }

    TokenTotals {
        input: g("input_tokens"),
        output: g("output_tokens"),
        cache_read: g("cache_read_input_tokens"),
        cache_write_5m: w5,
        cache_write_1h: w1,
    }
}

/// Run a closure over every JSON event in a file, parsed line by line.
pub fn for_each_event<F: FnMut(&Value)>(file: &Path, mut f: F) {
    let Ok(fh) = fs::File::open(file) else {
        return;
    };
    let reader = BufReader::new(fh);
    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            f(&v);
        }
    }
}

/// Summary metrics computed from a single top-level session file.
#[derive(Default)]
pub struct SessionScan {
    pub tokens: TokenTotals,
    pub cost: f64,
    pub message_count: usize,
    pub user_messages: usize,
    pub assistant_messages: usize,
    pub models: BTreeSet<String>,
    pub first_ts: Option<String>,
    pub last_ts: Option<String>,
    pub title: Option<String>,
    pub first_prompt: Option<String>,
    pub git_branch: Option<String>,
}

fn note_ts(scan: &mut SessionScan, ts: &str) {
    if scan.first_ts.as_deref().map(|f| ts < f).unwrap_or(true) {
        scan.first_ts = Some(ts.to_string());
    }
    if scan.last_ts.as_deref().map(|l| ts > l).unwrap_or(true) {
        scan.last_ts = Some(ts.to_string());
    }
}

/// Scan one top-level session transcript for summary metrics.
pub fn scan_session(file: &Path) -> SessionScan {
    let mut scan = SessionScan::default();
    for_each_event(file, |v| {
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");

        if let Some(ts) = v.get("timestamp").and_then(Value::as_str) {
            note_ts(&mut scan, ts);
        }
        if scan.git_branch.is_none() {
            if let Some(b) = v.get("gitBranch").and_then(Value::as_str) {
                if !b.is_empty() {
                    scan.git_branch = Some(b.to_string());
                }
            }
        }

        match kind {
            "ai-title" => {
                if let Some(t) = v.get("aiTitle").and_then(Value::as_str) {
                    if !t.is_empty() {
                        scan.title = Some(t.to_string());
                    }
                }
            }
            "user" => {
                scan.message_count += 1;
                scan.user_messages += 1;
                // The first *string* user content is the opening prompt;
                // array content is usually a tool result, so skip it.
                if scan.first_prompt.is_none() {
                    if let Some(c) = v.pointer("/message/content").and_then(Value::as_str) {
                        let c = c.trim();
                        if !c.is_empty() {
                            scan.first_prompt = Some(truncate(c, 280));
                        }
                    }
                }
            }
            "assistant" => {
                scan.message_count += 1;
                scan.assistant_messages += 1;
                if let Some(msg) = v.get("message") {
                    let model = msg.get("model").and_then(Value::as_str).unwrap_or("");
                    if !model.is_empty() {
                        scan.models.insert(model.to_string());
                    }
                    if let Some(usage) = msg.get("usage") {
                        let t = extract_usage(usage);
                        scan.tokens.add(&t);
                        scan.cost += pricing::cost(model, &t);
                    }
                }
            }
            _ => {}
        }
    });
    scan
}

/// Accumulate assistant token usage from any transcript file (incl. subagents),
/// reporting each contribution to a sink as (model, day, tokens, cost).
pub fn for_each_usage<F: FnMut(&str, Option<&str>, &TokenTotals, f64)>(file: &Path, mut sink: F) {
    for_each_event(file, |v| {
        if v.get("type").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        let Some(msg) = v.get("message") else { return };
        let Some(usage) = msg.get("usage") else { return };
        let model = msg.get("model").and_then(Value::as_str).unwrap_or("unknown");
        let t = extract_usage(usage);
        let c = pricing::cost(model, &t);
        // `get(..10)` is char-boundary safe (returns None instead of panicking
        // on a malformed/non-ASCII timestamp) and yields the YYYY-MM-DD day key.
        let day = v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|ts| ts.get(..10));
        sink(model, day, &t, c);
    });
}

/// Parse a full transcript into renderable messages for the viewer.
pub fn parse_messages(file: &Path) -> Vec<Message> {
    let mut out = Vec::new();
    for_each_event(file, |v| {
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        if !matches!(kind.as_str(), "user" | "assistant" | "system") {
            return;
        }

        let timestamp = v
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        let uuid = v.get("uuid").and_then(Value::as_str).map(str::to_string);
        let is_sidechain = v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false);

        let mut msg = Message {
            uuid,
            role: kind.clone(),
            kind: kind.clone(),
            timestamp,
            model: None,
            text: String::new(),
            thinking: None,
            tool_calls: Vec::new(),
            tokens: None,
            cost_usd: 0.0,
            is_sidechain,
        };

        if kind == "system" {
            if let Some(content) = v.get("content").and_then(Value::as_str) {
                msg.text = truncate(content, MAX_TEXT_LEN);
            } else if let Some(sub) = v.get("subtype").and_then(Value::as_str) {
                msg.text = format!("[system: {sub}]");
            } else {
                msg.text = "[system event]".to_string();
            }
            out.push(msg);
            return;
        }

        if let Some(message) = v.get("message") {
            if let Some(role) = message.get("role").and_then(Value::as_str) {
                msg.role = role.to_string();
            }
            if let Some(model) = message.get("model").and_then(Value::as_str) {
                msg.model = Some(model.to_string());
            }
            if let Some(usage) = message.get("usage") {
                let t = extract_usage(usage);
                msg.cost_usd = pricing::cost(msg.model.as_deref().unwrap_or(""), &t);
                msg.tokens = Some(t);
            }
            render_content(message.get("content"), &mut msg);
        }

        out.push(msg);
    });
    out
}

fn render_content(content: Option<&Value>, msg: &mut Message) {
    let mut text = String::new();
    let mut thinking = String::new();

    match content {
        Some(Value::String(s)) => text.push_str(s),
        Some(Value::Array(blocks)) => {
            for b in blocks {
                let bt = b.get("type").and_then(Value::as_str).unwrap_or("");
                match bt {
                    "text" => {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push_str("\n\n");
                            }
                            text.push_str(t);
                        }
                    }
                    "thinking" => {
                        if let Some(t) = b.get("thinking").and_then(Value::as_str) {
                            if !thinking.is_empty() {
                                thinking.push_str("\n\n");
                            }
                            thinking.push_str(t);
                        }
                    }
                    "tool_use" => {
                        let name = b
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        let input_preview = b
                            .get("input")
                            .map(|i| truncate(&i.to_string(), MAX_TOOL_PREVIEW))
                            .unwrap_or_default();
                        msg.tool_calls.push(ToolCall { name, input_preview });
                    }
                    "tool_result" => {
                        let rendered = render_tool_result(b.get("content"));
                        if !rendered.is_empty() {
                            if !text.is_empty() {
                                text.push_str("\n\n");
                            }
                            text.push_str("[tool result] ");
                            text.push_str(&rendered);
                        }
                    }
                    "image" => {
                        if !text.is_empty() {
                            text.push_str("\n\n");
                        }
                        text.push_str("[image]");
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }

    msg.text = truncate(&text, MAX_TEXT_LEN);
    if !thinking.is_empty() {
        msg.thinking = Some(truncate(&thinking, MAX_TEXT_LEN));
    }
}

fn render_tool_result(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => truncate(s, 600),
        Some(Value::Array(blocks)) => {
            let mut s = String::new();
            for b in blocks {
                if let Some(t) = b.get("text").and_then(Value::as_str) {
                    s.push_str(t);
                } else if b.get("type").and_then(Value::as_str) == Some("image") {
                    s.push_str("[image]");
                }
            }
            truncate(&s, 600)
        }
        _ => String::new(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str(" …[truncated]");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixture: a minimal transcript with one user + two assistant events.
    #[test]
    fn scan_session_fixture() {
        let jsonl = concat!(
            r#"{"type":"ai-title","aiTitle":"Fix the widget"}"#, "\n",
            r#"{"type":"user","timestamp":"2026-07-01T10:00:00Z","gitBranch":"main","message":{"content":"please fix the widget"}}"#, "\n",
            "not json at all\n",
            r#"{"type":"assistant","timestamp":"2026-07-01T10:01:00Z","message":{"model":"claude-fable-5","usage":{"input_tokens":10,"output_tokens":20}}}"#, "\n",
            r#"{"type":"assistant","timestamp":"2026-07-01T10:02:00Z","message":{"model":"claude-fable-5","usage":{"input_tokens":5,"output_tokens":5}}}"#, "\n",
        );
        let path = std::env::temp_dir().join("cm-parse-fixture.jsonl");
        std::fs::write(&path, jsonl).unwrap();
        let scan = scan_session(&path);
        let _ = std::fs::remove_file(&path);

        assert_eq!(scan.title.as_deref(), Some("Fix the widget"));
        assert_eq!(scan.user_messages, 1);
        assert_eq!(scan.assistant_messages, 2);
        assert_eq!(scan.message_count, 3);
        assert_eq!(scan.first_prompt.as_deref(), Some("please fix the widget"));
        assert_eq!(scan.git_branch.as_deref(), Some("main"));
        assert!(scan.models.contains("claude-fable-5"));
        assert_eq!(scan.first_ts.as_deref(), Some("2026-07-01T10:00:00Z"));
        assert_eq!(scan.last_ts.as_deref(), Some("2026-07-01T10:02:00Z"));
        assert_eq!(scan.tokens.input, 15);
        assert_eq!(scan.tokens.output, 25);
    }
}
