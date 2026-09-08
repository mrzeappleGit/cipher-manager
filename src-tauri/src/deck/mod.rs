//! CipherDeck — calendar + tasks, folded into cipherManager. Fetches published
//! ICS calendar feeds and Asana tasks, falling back to sample data whenever a
//! feed is missing or unreachable. The pure dashboard logic (up-next, buckets,
//! stats) lives on the frontend so the countdown stays live.

pub mod model;

mod asana;
mod ics;
mod recur;
mod sample;

use model::Dashboard;

/// What to fetch — supplied by the frontend (stored in local settings).
#[derive(Default)]
pub struct DeckConfig {
    pub ics_urls: Vec<String>,
    pub asana_token: String,
    pub asana_project: String,
    pub asana_workspace: String,
}

impl DeckConfig {
    /// True when nothing is configured — the caller should show sample data.
    pub fn is_empty(&self) -> bool {
        self.asana_token.trim().is_empty()
            && self.ics_urls.iter().all(|u| u.trim().is_empty())
    }
}

/// A ready-to-show sample dashboard.
pub fn sample_dashboard() -> Dashboard {
    sample::dashboard()
}

/// Full detail for one task (description, comments, subtasks, attachments).
pub fn task_detail(token: &str, gid: &str) -> Result<model::TaskDetail, String> {
    asana::fetch_task_detail(token, gid)
}

/// The latest `per` comments for each of the given task gids.
pub fn task_comments(token: &str, gids: &[String], per: usize) -> Vec<model::TaskComments> {
    asana::fetch_task_comments(token, gids, per)
}

/// Fetch everything the config points at. Always returns a usable dashboard,
/// falling back to sample data per-feed.
pub fn fetch(cfg: &DeckConfig) -> Dashboard {
    let mut notes = Vec::new();

    // ---- Calendar (ICS) ----
    let mut events = Vec::new();
    let mut events_live = false;
    for url in cfg.ics_urls.iter().filter(|u| !u.trim().is_empty()) {
        match ics::fetch_events(url.trim()) {
            Ok(mut evs) => {
                events.append(&mut evs);
                events_live = true;
            }
            Err(e) => notes.push(format!("Calendar feed failed: {e}")),
        }
    }

    // ---- Tasks (Asana) ----
    let mut tasks = Vec::new();
    let mut tasks_live = false;
    if !cfg.asana_token.trim().is_empty() {
        match asana::fetch_tasks(cfg.asana_token.trim(), &cfg.asana_project, &cfg.asana_workspace) {
            Ok(mut ts) => {
                tasks.append(&mut ts);
                tasks_live = true;
            }
            Err(e) => notes.push(format!("Asana fetch failed: {e}")),
        }
    }

    // ---- Fallbacks ----
    if !events_live {
        events = sample::events();
    }
    if !tasks_live {
        tasks = sample::tasks();
    }

    events.sort_by_key(|e| e.start);
    tasks.sort_by_key(|t| t.due);

    let live = events_live || tasks_live;
    let source = match (events_live, tasks_live) {
        (true, true) => "Live · calendar + Asana".to_string(),
        (true, false) => "Live calendar · sample tasks".to_string(),
        (false, true) => "Sample calendar · live tasks".to_string(),
        (false, false) => "Sample data — add a feed in Settings".to_string(),
    };

    Dashboard { events, tasks, source, live, notes }
}
