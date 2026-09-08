//! Deck data types (calendar events + tasks), ported from CipherDeck. The pure
//! dashboard logic (up-next, buckets, stats) now lives on the frontend so the
//! countdown stays live without refetching — this keeps just the types and the
//! small time helpers the fetch/parse layer needs.

use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};

/// What kind of calendar entry this is — drives the little coloured tag/icon.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum EventKind {
    Video,
    Room,
    Block,
    Other,
}

impl EventKind {
    pub fn from_type_str(s: &str) -> EventKind {
        match s.to_ascii_lowercase().as_str() {
            "video" => EventKind::Video,
            "room" => EventKind::Room,
            "block" => EventKind::Block,
            _ => EventKind::Other,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub title: String,
    pub start: DateTime<Local>,
    pub end: DateTime<Local>,
    pub location: String,
    pub kind: EventKind,
    pub who: String,
    /// Meeting/join URL, if one was found (Zoom/Meet/Teams…).
    #[serde(default)]
    pub url: Option<String>,
    /// Invite body/agenda text (may be empty; capped at parse time).
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// Asana task gid (empty for sample/local tasks).
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub due: DateTime<Local>,
    pub proj: String,
    /// Link to open the task in Asana, if known.
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
    /// Board column the task sits in (from its project membership).
    #[serde(default)]
    pub section: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub num_subtasks: u32,
    /// Custom fields with a non-empty display value (Priority, Status, …).
    #[serde(default)]
    pub fields: Vec<TaskField>,
}

/// A custom field on a task: its name and human-readable display value.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskField {
    pub name: String,
    pub value: String,
}

/// One comment (Asana "story" of type comment) on a task.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckComment {
    pub author: String,
    pub text: String,
    pub created_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckSubtask {
    pub name: String,
    pub completed: bool,
    pub due: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckAttachment {
    pub name: String,
    pub url: Option<String>,
}

/// On-demand detail for a single task (description + comments + subtasks + files).
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub notes: String,
    pub comments: Vec<DeckComment>,
    pub subtasks: Vec<DeckSubtask>,
    pub attachments: Vec<DeckAttachment>,
}

/// The latest comments for one task (used to enrich the day summary).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskComments {
    pub id: String,
    pub comments: Vec<DeckComment>,
}

/// A complete snapshot of everything the Deck renders.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Dashboard {
    pub events: Vec<Event>,
    pub tasks: Vec<Task>,
    /// Human-readable label for the footer (e.g. "Live · Outlook + Asana").
    pub source: String,
    /// True when at least one feed returned real data.
    pub live: bool,
    /// Non-fatal warnings gathered while fetching.
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------------------
// Small time helpers used by the fetch/parse layer.
// ---------------------------------------------------------------------------

/// Convert a naive (timezone-less) datetime into the local timezone, picking a
/// sensible instant across DST folds/gaps instead of panicking.
pub fn local_dt(naive: NaiveDateTime) -> DateTime<Local> {
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => dt,
        chrono::LocalResult::Ambiguous(a, _) => a,
        chrono::LocalResult::None => chrono::Utc.from_utc_datetime(&naive).with_timezone(&Local),
    }
}

pub fn start_of_today() -> DateTime<Local> {
    let now = Local::now();
    local_dt(now.date_naive().and_hms_opt(0, 0, 0).unwrap())
}
