//! Even Realities G2 plugin facade. The glasses plugin (even-g2/) talks to
//! serve over `/api/g2/*` with its own scoped bearer token — G2 tokens can
//! NEVER reach the general API. This module owns pairing (6-digit code the
//! user approves in desktop Settings), the hashed token store, and the tiny
//! text DTOs shaped for the 576x288 display (20 rows, 64 chars, 400/page).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::commands;
use crate::model::{Job, ProjectSummary, RecentUsage};

const CODE_TTL_MS: u64 = 5 * 60 * 1000; // pairing codes: 5 minutes, single-use
const PAIR_MIN_INTERVAL_MS: u64 = 30_000; // rate limit between pair/start calls
const MAX_PENDING: usize = 3;

pub const MAX_ROWS: usize = 20;
pub const MAX_LABEL: usize = 64;
pub const MAX_PAGE: usize = 400;

// ---------------------------------------------------------------------------
// Store — pending pairings + paired clients, on disk so the desktop app and
// serve (separate processes) share it. Guarded by a lock within each process;
// cross-process races are a non-issue at "one user pairs one device" scale.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Store {
    #[serde(default)]
    pub pending: Vec<Pending>,
    #[serde(default)]
    pub clients: Vec<Client>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Pending {
    pub code: String,
    pub device: String,
    pub created_ms: u64,
    #[serde(default)]
    pub approved: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Client {
    /// sha256 hex of the bearer token — the raw token is never stored.
    pub token_hash: String,
    pub device: String,
    pub created_ms: u64,
    #[serde(default)]
    pub last_used_ms: u64,
}

fn store_lock() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}

fn read_store() -> Store {
    commands::read_app_state("g2-store")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_store(s: &Store) -> Result<(), String> {
    commands::write_app_state("g2-store", &serde_json::to_string_pretty(s).map_err(|e| e.to_string())?)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// OS-entropy random hex (same RandomState trick as ensure_serve_token).
/// Also used by agents.rs for session ids.
pub(crate) fn rand_hex(chunks: u64) -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..chunks {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn purge_expired(s: &mut Store) {
    let now = now_ms();
    s.pending.retain(|p| now.saturating_sub(p.created_ms) < CODE_TTL_MS);
}

// ---------------------------------------------------------------------------
// Pairing flow.
// ---------------------------------------------------------------------------

/// Plugin calls this first; user reads the code off the glasses and approves
/// it in desktop Settings. Rate-limited; returns the code + TTL.
pub fn pair_start(device: &str) -> Result<serde_json::Value, String> {
    let _g = store_lock().lock().map_err(|e| e.to_string())?;
    let mut s = read_store();
    purge_expired(&mut s);
    if s.pending.len() >= MAX_PENDING {
        return Err("too many pending pairings — approve or wait for expiry".into());
    }
    if let Some(newest) = s.pending.iter().map(|p| p.created_ms).max() {
        if now_ms().saturating_sub(newest) < PAIR_MIN_INTERVAL_MS {
            return Err("pairing rate limit — try again in a moment".into());
        }
    }
    // 6 digits from OS entropy.
    let n: u32 = u32::from_str_radix(&rand_hex(1)[..8], 16).unwrap_or(0) % 1_000_000;
    let code = format!("{n:06}");
    let device = clamp(device.trim(), 40);
    let device = if device.is_empty() { "G2".to_string() } else { device };
    s.pending.push(Pending { code: code.clone(), device, created_ms: now_ms(), approved: false });
    write_store(&s)?;
    Ok(serde_json::json!({ "code": code, "expiresInSec": CODE_TTL_MS / 1000 }))
}

/// Plugin polls this until the desktop approves. Single-use: the first poll
/// after approval mints the token and burns the code.
pub fn pair_status(code: &str) -> Result<serde_json::Value, String> {
    let _g = store_lock().lock().map_err(|e| e.to_string())?;
    let mut s = read_store();
    purge_expired(&mut s);
    let Some(idx) = s.pending.iter().position(|p| p.code == code) else {
        return Ok(serde_json::json!({ "status": "expired" }));
    };
    if !s.pending[idx].approved {
        write_store(&s)?; // persist any purge
        return Ok(serde_json::json!({ "status": "pending" }));
    }
    let p = s.pending.remove(idx);
    let token = rand_hex(4); // 64 hex chars
    s.clients.push(Client {
        token_hash: hash_token(&token),
        device: p.device,
        created_ms: now_ms(),
        last_used_ms: 0,
    });
    write_store(&s)?;
    Ok(serde_json::json!({ "status": "approved", "token": token }))
}

/// Desktop Settings: pending codes awaiting approval.
pub fn pair_pending() -> Vec<serde_json::Value> {
    let mut s = read_store();
    purge_expired(&mut s);
    s.pending
        .iter()
        .filter(|p| !p.approved)
        .map(|p| serde_json::json!({ "code": p.code, "device": p.device, "createdMs": p.created_ms }))
        .collect()
}

/// Desktop Settings: approve a code shown on the glasses.
pub fn pair_approve(code: &str) -> Result<(), String> {
    let _g = store_lock().lock().map_err(|e| e.to_string())?;
    let mut s = read_store();
    purge_expired(&mut s);
    match s.pending.iter_mut().find(|p| p.code == code) {
        Some(p) => p.approved = true,
        None => return Err("code not found (expired?)".into()),
    }
    write_store(&s)
}

/// Desktop Settings: paired clients (hash prefix as a display id — no tokens).
pub fn clients() -> Vec<serde_json::Value> {
    read_store()
        .clients
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": &c.token_hash[..12.min(c.token_hash.len())],
                "device": c.device,
                "createdMs": c.created_ms,
                "lastUsedMs": c.last_used_ms,
            })
        })
        .collect()
}

/// Desktop Settings: revoke by the id shown in `clients()`.
pub fn revoke(id: &str) -> Result<(), String> {
    if id.len() < 8 {
        return Err("bad client id".into());
    }
    let _g = store_lock().lock().map_err(|e| e.to_string())?;
    let mut s = read_store();
    let before = s.clients.len();
    s.clients.retain(|c| !c.token_hash.starts_with(id));
    if s.clients.len() == before {
        return Err("client not found".into());
    }
    write_store(&s)
}

/// Bearer-token gate for the read endpoints. Updates last-used (best effort).
pub fn authorize(bearer: &str) -> bool {
    if bearer.len() < 32 {
        return false;
    }
    let h = hash_token(bearer);
    let _g = match store_lock().lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    let mut s = read_store();
    match s.clients.iter_mut().find(|c| c.token_hash == h) {
        Some(c) => {
            c.last_used_ms = now_ms();
            let _ = write_store(&s);
            true
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// DTO builders — tiny text payloads shaped for the glasses. Sources: the
// deck-cache app-state (desktop keeps it fresh), local jobs/usage/projects.
// ---------------------------------------------------------------------------

/// Unicode-safe clamp; the G2 firmware font drops unknown glyphs anyway.
pub fn clamp(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('~');
    out
}

fn deck_cache() -> serde_json::Value {
    commands::read_app_state("deck-cache")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

fn parse_ms(v: &serde_json::Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|d| d.timestamp_millis())
}

fn fmt_clock(ms: i64) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_millis_opt(ms) {
        chrono::LocalResult::Single(d) => d.format("%H:%M").to_string(),
        _ => "--:--".into(),
    }
}

fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1e6)
    } else if n >= 1_000 {
        format!("{:.0}K", n as f64 / 1e3)
    } else {
        n.to_string()
    }
}

fn usage_total(u: &crate::model::TokenTotals) -> u64 {
    u.input + u.output + u.cache_read + u.cache_write_5m + u.cache_write_1h
}

/// Events today (start >= local midnight, start < tomorrow), soonest first.
fn today_events(deck: &serde_json::Value) -> Vec<(i64, String, String)> {
    let now = chrono::Local::now();
    let day0 = now.date_naive().and_hms_opt(0, 0, 0).unwrap();
    let start_ms = day0.and_local_timezone(chrono::Local).unwrap().timestamp_millis();
    let end_ms = start_ms + 86_400_000;
    let mut out = vec![];
    for e in deck.get("events").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let Some(ms) = e.get("start").and_then(|s| Some(parse_ms(s)?)) else { continue };
        if ms < start_ms || ms >= end_ms {
            continue;
        }
        let title = e.get("title").and_then(|t| t.as_str()).unwrap_or("(untitled)").to_string();
        let loc = e.get("location").and_then(|l| l.as_str()).unwrap_or("").to_string();
        out.push((ms, title, loc));
    }
    out.sort_by_key(|(ms, ..)| *ms);
    out
}

/// The soonest event today starting at or after `now_ms`.
fn next_event(deck: &serde_json::Value, now_ms: i64) -> Option<(i64, String)> {
    today_events(deck)
        .into_iter()
        .find(|(ms, ..)| *ms >= now_ms)
        .map(|(ms, title, _)| (ms, title))
}

/// Local-midnight boundary in ms — the deck's bucketing is by calendar day
/// (same day = Today even if the timestamp is past), matching src/lib/deck.ts.
fn start_of_today_ms() -> i64 {
    let d = chrono::Local::now().date_naive().and_hms_opt(0, 0, 0).unwrap();
    d.and_local_timezone(chrono::Local).unwrap().timestamp_millis()
}

/// Tasks bucketed by due date: (overdue, due today).
fn task_counts(deck: &serde_json::Value) -> (usize, usize, Vec<(i64, String, String)>) {
    let day_start = start_of_today_ms();
    let day_end = day_start + 86_400_000;
    let (mut overdue, mut today, mut rows) = (0usize, 0usize, vec![]);
    for t in deck.get("tasks").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let Some(ms) = t.get("due").and_then(|s| Some(parse_ms(s)?)) else { continue };
        let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("(task)").to_string();
        let proj = t.get("proj").and_then(|p| p.as_str()).unwrap_or("").to_string();
        if ms < day_start {
            overdue += 1;
        } else if ms < day_end {
            today += 1;
        }
        rows.push((ms, name, proj));
    }
    rows.sort_by_key(|(ms, ..)| *ms);
    (overdue, today, rows)
}

/// NOW — the glanceable headline: next event, task pressure, jobs, usage.
pub fn now_dto(jobs: &[Job], usage: &RecentUsage) -> serde_json::Value {
    let deck = deck_cache();
    let now_ms = chrono::Local::now().timestamp_millis();
    let next = next_event(&deck, now_ms);
    let event = next.as_ref().map(|(ms, title)| {
        let mins = (ms - now_ms) / 60_000;
        let when = if mins < 60 { format!("in {mins}m") } else { fmt_clock(*ms) };
        clamp(&format!("{} {}", when, title), MAX_LABEL)
    });
    let (overdue, today, _) = task_counts(&deck);
    let running = jobs.iter().filter(|j| j.status == "running").count();
    let live = deck.get("live").and_then(|l| l.as_bool()).unwrap_or(false);
    serde_json::json!({
        "event": event,
        // Raw start + title so a client can run its own countdown. `event`
        // above is formatted at request time and goes stale in any cache.
        "eventMs": next.as_ref().map(|(ms, _)| *ms),
        "eventTitle": next.as_ref().map(|(_, t)| clamp(t, MAX_LABEL)),
        "overdue": overdue,
        "dueToday": today,
        "runningJobs": running,
        "usage5h": format!("{} tok / {} msg", fmt_tokens(usage_total(&usage.h5.tokens)), usage.h5.message_count),
        "deckLive": live,
        "ts": now_ms,
    })
}

/// DECK — today's events + nearest tasks as display-ready rows.
pub fn deck_dto() -> serde_json::Value {
    let deck = deck_cache();
    let events: Vec<String> = today_events(&deck)
        .into_iter()
        .take(MAX_ROWS)
        .map(|(ms, title, loc)| {
            let mut row = format!("{} {}", fmt_clock(ms), title);
            if !loc.is_empty() {
                row.push_str(&format!(" @{loc}"));
            }
            clamp(&row, MAX_LABEL)
        })
        .collect();
    let day_start = start_of_today_ms();
    let (_, _, tasks) = task_counts(&deck);
    let tasks: Vec<String> = tasks
        .into_iter()
        .take(MAX_ROWS)
        .map(|(ms, name, proj)| {
            let mark = if ms < day_start { "!" } else { "-" };
            let tail = if proj.is_empty() { String::new() } else { format!(" ({proj})") };
            clamp(&format!("{mark} {name}{tail}"), MAX_LABEL)
        })
        .collect();
    let live = deck.get("live").and_then(|l| l.as_bool()).unwrap_or(false);
    serde_json::json!({ "events": events, "tasks": tasks, "deckLive": live, "ts": chrono::Local::now().timestamp_millis() })
}

/// BRIEF — the day condensed into <=400-char pages.
pub fn brief_dto(usage: &RecentUsage, recaps: &[crate::model::DayRecap]) -> serde_json::Value {
    let deck = deck_cache();
    let mut pages: Vec<String> = vec![];

    // Page 1: agenda.
    let events = today_events(&deck);
    let mut p = String::from("TODAY\n");
    if events.is_empty() {
        p.push_str("No events on the calendar.\n");
    }
    for (ms, title, _) in events.iter().take(6) {
        p.push_str(&clamp(&format!("{} {}\n", fmt_clock(*ms), title), MAX_LABEL));
    }
    let (overdue, today, _) = task_counts(&deck);
    p.push_str(&format!("\nTasks: {overdue} overdue, {today} due today"));
    pages.push(clamp(&p, MAX_PAGE));

    // Page 2: usage now + latest day recap.
    let mut p = String::from("USAGE\n");
    p.push_str(&format!(
        "5h: {} tok / {} msg\n24h: {} tok / {} msg\n",
        fmt_tokens(usage_total(&usage.h5.tokens)),
        usage.h5.message_count,
        fmt_tokens(usage_total(&usage.h24.tokens)),
        usage.h24.message_count
    ));
    if let Some(r) = recaps.first() {
        p.push_str(&format!("\n{}: {} sessions, {} msgs\n", r.day, r.session_count, r.message_count));
        for pr in r.projects.iter().take(4) {
            p.push_str(&clamp(&format!("- {} ({})\n", pr.name, fmt_tokens(usage_total(&pr.tokens))), MAX_LABEL));
        }
    }
    pages.push(clamp(&p, MAX_PAGE));

    serde_json::json!({ "pages": pages, "ts": chrono::Local::now().timestamp_millis() })
}

/// PROJECTS — recent activity, newest first.
pub fn projects_dto(projects: &[ProjectSummary]) -> serde_json::Value {
    let mut rows: Vec<(String, String)> = projects
        .iter()
        .filter_map(|p| p.last_activity.clone().map(|la| (la, p)))
        .map(|(la, p)| {
            (la.clone(), clamp(&format!("{} — {} — {}", p.name, &la[..10.min(la.len())], fmt_tokens(usage_total(&p.tokens))), MAX_LABEL))
        })
        .collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    let rows: Vec<String> = rows.into_iter().take(5).map(|(_, r)| r).collect();
    serde_json::json!({ "projects": rows, "ts": chrono::Local::now().timestamp_millis() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_round_trip_rate_limit_and_revoke() {
        let _g = commands::state_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let d = tempfile::tempdir().unwrap();
        std::env::set_var("CIPHER_STATE_DIR", d.path());

        let started = pair_start("test-g2").unwrap();
        let code = started["code"].as_str().unwrap().to_string();
        assert_eq!(code.len(), 6);

        // Rate limit: a second start inside the 30s window is refused.
        assert!(pair_start("another").is_err());

        // Pending until approved.
        assert_eq!(pair_status(&code).unwrap()["status"], "pending");
        assert_eq!(pair_pending().len(), 1);

        pair_approve(&code).unwrap();
        let ok = pair_status(&code).unwrap();
        assert_eq!(ok["status"], "approved");
        let token = ok["token"].as_str().unwrap().to_string();
        assert!(token.len() >= 32);

        // Single-use: the code is burned.
        assert_eq!(pair_status(&code).unwrap()["status"], "expired");

        // Token authorizes; garbage doesn't; revoked stops working.
        assert!(authorize(&token));
        assert!(!authorize("nope-nope-nope-nope-nope-nope-nope"));
        let id = clients()[0]["id"].as_str().unwrap().to_string();
        revoke(&id).unwrap();
        assert!(!authorize(&token));

        std::env::remove_var("CIPHER_STATE_DIR");
    }

    /// The soonest event today that hasn't started yet. Fixtures are built off
    /// local midnight so the test can't flake on the day-window filter in
    /// `today_events`, and the hours are small enough to survive a DST day.
    #[test]
    fn next_event_picks_the_soonest_still_ahead() {
        use chrono::TimeZone;
        let day = start_of_today_ms();
        let hour = 3_600_000i64;
        let at = |ms: i64| chrono::Local.timestamp_millis_opt(ms).unwrap().to_rfc3339();
        let deck = serde_json::json!({
            "events": [
                { "start": at(day + 10 * hour), "title": "Retro" },
                { "start": at(day + hour), "title": "Standup" },
            ]
        });
        assert_eq!(next_event(&deck, day), Some((day + hour, "Standup".to_string())));
        assert_eq!(next_event(&deck, day + 2 * hour), Some((day + 10 * hour, "Retro".to_string())));
        assert_eq!(next_event(&deck, day + 11 * hour), None);
        assert_eq!(next_event(&serde_json::json!({}), day), None);
    }

    #[test]
    fn clamp_is_unicode_safe() {
        assert_eq!(clamp("abc", 64), "abc");
        let long = "é".repeat(100);
        let c = clamp(&long, 64);
        assert!(c.chars().count() <= 64);
        assert!(c.ends_with('~'));
    }
}
