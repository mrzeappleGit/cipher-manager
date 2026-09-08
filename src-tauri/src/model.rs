//! Serializable data structures shared with the frontend.

use serde::{Deserialize, Serialize};

/// Token counts broken down by billing category.
#[derive(Serialize, Deserialize, Clone, Copy, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct TokenTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
}

impl TokenTotals {
    pub fn add(&mut self, other: &TokenTotals) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write_5m += other.cache_write_5m;
        self.cache_write_1h += other.cache_write_1h;
    }

    /// Every token that passed through, for a headline "tokens used" number.
    #[allow(dead_code)]
    pub fn grand_total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write_5m + self.cache_write_1h
    }
}

/// High-level summary of a single Claude Code project directory.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    /// Encoded directory name (stable id).
    pub id: String,
    /// Best-effort real filesystem path of the project.
    pub path: String,
    /// Whether that path still exists on disk.
    pub path_exists: bool,
    /// Last path segment, used as a display name.
    pub name: String,
    pub session_count: usize,
    pub message_count: usize,
    pub size_bytes: u64,
    pub first_activity: Option<String>,
    pub last_activity: Option<String>,
    pub tokens: TokenTotals,
    pub cost_usd: f64,
    pub models: Vec<String>,
    /// Web URL of the git origin remote (GitHub etc.), if the project is a repo.
    pub git_url: Option<String>,
}

/// Summary of one top-level session transcript.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub project_id: String,
    pub title: Option<String>,
    pub first_prompt: Option<String>,
    pub message_count: usize,
    pub user_messages: usize,
    pub assistant_messages: usize,
    pub size_bytes: u64,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub tokens: TokenTotals,
    pub cost_usd: f64,
    pub models: Vec<String>,
    pub git_branch: Option<String>,
    /// Whether this session has a sidecar dir with subagent/workflow transcripts.
    pub has_subagents: bool,
    /// Which CLI produced it: "claude" or "codex".
    pub tool: String,
}

/// A single rendered message from a transcript.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub uuid: Option<String>,
    pub role: String,
    pub kind: String,
    pub timestamp: Option<String>,
    pub model: Option<String>,
    pub text: String,
    pub thinking: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub tokens: Option<TokenTotals>,
    pub cost_usd: f64,
    pub is_sidechain: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub name: String,
    pub input_preview: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub summary: SessionSummary,
    pub messages: Vec<Message>,
}

/// Aggregated usage across everything, for the dashboard.
#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub tokens: TokenTotals,
    pub total_cost: f64,
    pub session_count: usize,
    pub message_count: usize,
    pub project_count: usize,
    pub total_size_bytes: u64,
    pub by_model: Vec<ModelUsage>,
    pub by_project: Vec<ProjectUsage>,
    pub by_day: Vec<DayUsage>,
    pub first_activity: Option<String>,
    pub last_activity: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub tokens: TokenTotals,
    pub cost_usd: f64,
    pub message_count: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub id: String,
    pub name: String,
    pub tokens: TokenTotals,
    pub cost_usd: f64,
}

/// `Deserialize` because these are banked to disk by `ledger.rs` — the scan
/// only ever sees a rolling 30-day window of transcripts.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub day: String,
    pub tokens: TokenTotals,
    pub cost_usd: f64,
    pub message_count: usize,
}

/// One search hit inside a transcript.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub project_id: String,
    pub project_name: String,
    pub session_id: String,
    pub session_title: Option<String>,
    pub role: String,
    pub timestamp: Option<String>,
    pub snippet: String,
    pub chunk_kind: Option<String>,
    pub message_uuid: Option<String>,
    /// Cosine similarity for semantic hits; None on keyword hits.
    pub score: Option<f64>,
}

/// Disk-usage breakdown for the cleanup view.
#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    pub total_bytes: u64,
    pub projects: Vec<DiskProject>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiskProject {
    pub id: String,
    pub name: String,
    pub size_bytes: u64,
    pub session_count: usize,
    pub last_activity: Option<String>,
    pub sessions: Vec<DiskSession>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiskSession {
    pub id: String,
    pub title: Option<String>,
    /// Size of the .jsonl file plus any sidecar subagent directory.
    pub size_bytes: u64,
    pub last_activity: Option<String>,
}

/// One price row for the settings screen.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PriceRow {
    pub family: String,
    pub input: f64,
    pub output: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
    pub cache_read: f64,
}

/// One day's activity recap, grouped by project.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DayRecap {
    pub day: String,
    pub session_count: usize,
    pub message_count: usize,
    pub tokens: TokenTotals,
    pub cost_usd: f64,
    pub projects: Vec<DayRecapProject>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DayRecapProject {
    pub id: String,
    pub name: String,
    pub session_count: usize,
    pub message_count: usize,
    pub tokens: TokenTotals,
    pub sessions: Vec<DayRecapSession>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DayRecapSession {
    pub id: String,
    pub title: Option<String>,
    pub first_prompt: Option<String>,
    pub message_count: usize,
    pub tokens: TokenTotals,
}

/// Result of proxying an HTTP request (used for AI provider calls).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProxyResponse {
    pub status: u16,
    pub body: String,
}

/// Result of proxying a request that returns binary data (e.g. TTS audio).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BinResponse {
    pub status: u16,
    pub body_base64: String,
}

/// Token usage within a recent time window.
#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecentWindow {
    pub tokens: TokenTotals,
    pub message_count: usize,
}

/// Live rolling-window usage (last 5h / 24h).
#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecentUsage {
    pub h5: RecentWindow,
    pub h24: RecentWindow,
}

/// A markdown document on disk (plan or project memory).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DocFile {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified: Option<String>,
    pub kind: String, // "plan" | "memory"
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DocGroup {
    pub title: String,
    pub docs: Vec<DocFile>,
}

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Documents {
    pub plans: Vec<DocFile>,
    pub memory: Vec<DocGroup>,
}

/// A session summary for the "pick up where you left off" list.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecentSession {
    pub project_id: String,
    pub project_name: String,
    pub session_id: String,
    pub title: Option<String>,
    pub first_prompt: Option<String>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub message_count: usize,
    pub models: Vec<String>,
}

/// A Claude Code skill defined on disk (`~/.claude/skills/<id>/SKILL.md`).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    /// Directory name (stable id).
    pub id: String,
    /// Display name from frontmatter, falling back to the id.
    pub name: String,
    pub description: String,
    /// Optional grouping (from an extra `domain:` frontmatter field).
    pub domain: Option<String>,
    /// Default model for runs (from an extra `model:` frontmatter field).
    pub model: Option<String>,
    /// Path to the SKILL.md file.
    pub path: String,
    pub size_bytes: u64,
    pub modified: Option<String>,
}

/// A headless `claude -p` run started from a skill (or a free prompt).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    /// Skill id this run came from (or "prompt" for a free run).
    pub skill: String,
    /// Human-readable label for the jobs list.
    pub label: String,
    /// "running" | "done" | "failed".
    pub status: String,
    /// Accumulated stdout + stderr.
    pub output: String,
    /// Process exit code once finished.
    pub exit_code: Option<i32>,
    /// True only after the configured CLI process has successfully spawned.
    pub launched: bool,
    /// Working directory the run used.
    pub cwd: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

/// A persisted record of one headless run (audit.jsonl line).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    pub skill: String,
    pub label: String,
    pub status: String,
    pub exit_code: Option<i32>,
    /// Older audit records did not distinguish launch failure from run failure.
    #[serde(default)]
    pub launched: Option<bool>,
    pub cwd: Option<String>,
    pub prompt: String,
    pub bin: String,
    pub args: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub output_excerpt: String,
}

/// Environment info for the settings screen.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub claude_root: Option<String>,
    pub projects_dir: Option<String>,
    pub root_exists: bool,
    pub pricing: Vec<PriceRow>,
    pub archive_dir: Option<String>,
    pub audit_path: Option<String>,
}
