//! Tauri command handlers exposed to the frontend.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::State;

use crate::claude;
use crate::model::*;
use crate::parse;
use crate::pricing;

/// In-memory cache so the dashboard and project list load instantly after
/// the first (expensive) scan of `~/.claude`.
#[derive(Default)]
pub struct AppState {
    inner: Mutex<Cached>,
}

#[derive(Default)]
struct Cached {
    projects: Option<Vec<ProjectSummary>>,
    usage: Option<UsageStats>,
    recaps: Option<Vec<DayRecap>>,
}

// ---------------------------------------------------------------------------
// Full scan (projects + aggregated usage) — the heavy operation, cached.
// ---------------------------------------------------------------------------

/// Web URL of the project's git `origin` remote, read straight from
/// `.git/config` (no git subprocess). None when not a repo or no origin.
fn git_remote_web_url(project_path: &str) -> Option<String> {
    let cfg = std::fs::read_to_string(Path::new(project_path).join(".git").join("config")).ok()?;
    let mut in_origin = false;
    for line in cfg.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_origin = line == "[remote \"origin\"]";
        } else if in_origin {
            if let Some(rest) = line.strip_prefix("url") {
                if let Some(v) = rest.trim_start().strip_prefix('=') {
                    return remote_to_web_url(v.trim());
                }
            }
        }
    }
    None
}

/// `git@host:user/repo.git` / `ssh://git@host/user/repo.git` / `https://…` → browsable https URL.
fn remote_to_web_url(u: &str) -> Option<String> {
    let u = u.strip_suffix(".git").unwrap_or(u);
    if u.starts_with("http://") || u.starts_with("https://") {
        return Some(u.to_string());
    }
    let rest = u.strip_prefix("ssh://").unwrap_or(u).strip_prefix("git@")?;
    let (host, path) = rest.split_once([':', '/'])?;
    Some(format!("https://{host}/{path}"))
}

pub fn scan_all() -> (Vec<ProjectSummary>, UsageStats) {
    let ids = claude::list_project_ids();
    let hist = claude::history_path_map();
    let projects_dir = claude::projects_dir();

    let mut summaries: Vec<ProjectSummary> = Vec::new();
    let mut by_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut by_day: HashMap<String, DayUsage> = HashMap::new();
    let mut usage = UsageStats::default();

    for id in ids {
        let Some(base) = projects_dir.as_ref() else { break };
        let pd = base.join(&id);
        if !pd.is_dir() {
            continue;
        }

        let session_files = claude::top_level_sessions(&pd);

        // Resolve the real project path.
        let real_path = session_files
            .iter()
            .find_map(|f| claude::first_cwd_in_file(f))
            .or_else(|| hist.get(&id).cloned())
            .unwrap_or_else(|| id.clone());
        let name = claude::display_name(&real_path);
        let path_exists = Path::new(&real_path).is_dir();
        let size_bytes = claude::dir_size(&pd);

        // Counts, timestamps, models from top-level session files.
        let mut msg_count = 0usize;
        let mut first_ts: Option<String> = None;
        let mut last_ts: Option<String> = None;
        let mut proj_models: BTreeSet<String> = BTreeSet::new();
        for sf in &session_files {
            let scan = parse::scan_session(sf);
            msg_count += scan.message_count;
            for m in &scan.models {
                proj_models.insert(m.clone());
            }
            merge_ts(&mut first_ts, &mut last_ts, &scan.first_ts, &scan.last_ts);
        }

        // Tokens/cost from ALL jsonl (incl. subagent/workflow transcripts).
        let mut all_jsonl = Vec::new();
        claude::jsonl_files_recursive(&pd, &mut all_jsonl);
        let mut proj_tokens = TokenTotals::default();
        let mut proj_cost = 0.0f64;
        for f in &all_jsonl {
            parse::for_each_usage(f, |model, day, t, c| {
                proj_tokens.add(t);
                proj_cost += c;
                proj_models.insert(model.to_string());

                let m = by_model.entry(model.to_string()).or_insert_with(|| ModelUsage {
                    model: model.to_string(),
                    tokens: TokenTotals::default(),
                    cost_usd: 0.0,
                    message_count: 0,
                });
                m.tokens.add(t);
                m.cost_usd += c;
                m.message_count += 1;

                if let Some(day) = day {
                    let d = by_day.entry(day.to_string()).or_insert_with(|| DayUsage {
                        day: day.to_string(),
                        tokens: TokenTotals::default(),
                        cost_usd: 0.0,
                        message_count: 0,
                    });
                    d.tokens.add(t);
                    d.cost_usd += c;
                    d.message_count += 1;
                }
            });
        }

        let git_url = git_remote_web_url(&real_path);
        summaries.push(ProjectSummary {
            id: id.clone(),
            path: real_path,
            path_exists,
            name,
            session_count: session_files.len(),
            message_count: msg_count,
            size_bytes,
            first_activity: first_ts.clone(),
            last_activity: last_ts.clone(),
            tokens: proj_tokens,
            cost_usd: proj_cost,
            models: proj_models.into_iter().collect(),
            git_url,
        });

        usage.tokens.add(&proj_tokens);
        usage.total_cost += proj_cost;
        usage.session_count += session_files.len();
        usage.message_count += msg_count;
        usage.total_size_bytes += size_bytes;
        merge_ts(
            &mut usage.first_activity,
            &mut usage.last_activity,
            &first_ts,
            &last_ts,
        );
    }

    // ---- Codex sessions fold into the same projects + usage ----------------
    for cs in crate::codex::scan_all_codex() {
        let sm = &cs.summary;
        let day = sm.end_time.as_deref().map(|t| t[..10.min(t.len())].to_string());
        if let Some(p) = summaries.iter_mut().find(|p| p.path.eq_ignore_ascii_case(&cs.cwd)) {
            p.session_count += 1;
            p.message_count += sm.message_count;
            p.size_bytes += sm.size_bytes;
            p.tokens.add(&sm.tokens);
            for m in &sm.models {
                if !p.models.contains(m) {
                    p.models.push(m.clone());
                }
            }
            merge_ts(&mut p.first_activity, &mut p.last_activity, &sm.start_time, &sm.end_time);
        } else {
            summaries.push(ProjectSummary {
                id: crate::codex::codex_project_id(&cs.cwd),
                path: cs.cwd.clone(),
                path_exists: Path::new(&cs.cwd).is_dir(),
                name: claude::display_name(&cs.cwd),
                session_count: 1,
                message_count: sm.message_count,
                size_bytes: sm.size_bytes,
                first_activity: sm.start_time.clone(),
                last_activity: sm.end_time.clone(),
                tokens: sm.tokens,
                cost_usd: 0.0,
                models: sm.models.clone(),
                git_url: git_remote_web_url(&cs.cwd),
            });
        }
        usage.tokens.add(&sm.tokens);
        usage.session_count += 1;
        usage.message_count += sm.message_count;
        usage.total_size_bytes += sm.size_bytes;
        merge_ts(&mut usage.first_activity, &mut usage.last_activity, &sm.start_time, &sm.end_time);
        for model in &sm.models {
            let m = by_model.entry(model.clone()).or_insert_with(|| ModelUsage {
                model: model.clone(),
                tokens: TokenTotals::default(),
                cost_usd: 0.0,
                message_count: 0,
            });
            m.tokens.add(&sm.tokens);
            m.message_count += sm.assistant_messages;
        }
        if let Some(day) = day {
            let d = by_day.entry(day.clone()).or_insert_with(|| DayUsage {
                day,
                tokens: TokenTotals::default(),
                cost_usd: 0.0,
                message_count: 0,
            });
            d.tokens.add(&sm.tokens);
            d.message_count += sm.message_count;
        }
    }

    // ---- Antigravity sessions: presence + project merge (no token data) ----
    for ags in crate::antigravity::scan_all_antigravity() {
        let sm = &ags.summary;
        if let Some(p) = summaries.iter_mut().find(|p| p.path.eq_ignore_ascii_case(&ags.cwd)) {
            p.session_count += 1;
            p.message_count += sm.message_count;
            merge_ts(&mut p.first_activity, &mut p.last_activity, &sm.start_time, &sm.end_time);
        } else if !ags.cwd.is_empty() {
            summaries.push(ProjectSummary {
                id: crate::antigravity::antigravity_project_id(&ags.cwd),
                path: ags.cwd.clone(),
                path_exists: Path::new(&ags.cwd).is_dir(),
                name: claude::display_name(&ags.cwd),
                session_count: 1,
                message_count: sm.message_count,
                size_bytes: 0,
                first_activity: sm.start_time.clone(),
                last_activity: sm.end_time.clone(),
                tokens: TokenTotals::default(),
                cost_usd: 0.0,
                models: vec![],
                git_url: git_remote_web_url(&ags.cwd),
            });
        }
        usage.session_count += 1;
        usage.message_count += sm.message_count;
        merge_ts(&mut usage.first_activity, &mut usage.last_activity, &sm.start_time, &sm.end_time);
    }

    usage.project_count = summaries.iter().filter(|p| p.session_count > 0).count();

    // Finalize by_model (sorted by cost desc).
    let mut model_vec: Vec<ModelUsage> = by_model.into_values().collect();
    model_vec.sort_by(|a, b| b.cost_usd.total_cmp(&a.cost_usd));
    usage.by_model = model_vec;

    // Claude Code prunes transcripts past `cleanupPeriodDays` (default 30), so
    // everything above is a rolling window. Fold in the days we banked before
    // they aged off disk, and re-bank the merged set.
    crate::ledger::merge_and_bank(&mut by_day, &mut usage);

    // Finalize by_day (sorted chronologically).
    let mut day_vec: Vec<DayUsage> = by_day.into_values().collect();
    day_vec.sort_by(|a, b| a.day.cmp(&b.day));
    usage.by_day = day_vec;

    // Finalize by_project (sorted by cost desc).
    let mut proj_vec: Vec<ProjectUsage> = summaries
        .iter()
        .map(|p| ProjectUsage {
            id: p.id.clone(),
            name: p.name.clone(),
            tokens: p.tokens,
            cost_usd: p.cost_usd,
        })
        .collect();
    proj_vec.sort_by(|a, b| b.cost_usd.total_cmp(&a.cost_usd));
    usage.by_project = proj_vec;

    // Present projects most-recently-active first.
    summaries.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));

    (summaries, usage)
}

fn merge_ts(
    first: &mut Option<String>,
    last: &mut Option<String>,
    new_first: &Option<String>,
    new_last: &Option<String>,
) {
    if let Some(nf) = new_first {
        if first.as_deref().map(|f| nf < &f.to_string()).unwrap_or(true) {
            *first = Some(nf.clone());
        }
    }
    if let Some(nl) = new_last {
        if last.as_deref().map(|l| nl > &l.to_string()).unwrap_or(true) {
            *last = Some(nl.clone());
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectSummary>, String> {
    {
        let g = state.inner.lock().unwrap();
        if let Some(p) = &g.projects {
            return Ok(p.clone());
        }
    }
    let (projects, usage) = tauri::async_runtime::spawn_blocking(scan_all)
        .await
        .map_err(|e| e.to_string())?;
    let mut g = state.inner.lock().unwrap();
    g.projects = Some(projects.clone());
    g.usage = Some(usage);
    Ok(projects)
}

#[tauri::command]
pub async fn get_usage_stats(state: State<'_, AppState>) -> Result<UsageStats, String> {
    {
        let g = state.inner.lock().unwrap();
        if let Some(u) = &g.usage {
            return Ok(u.clone());
        }
    }
    let (projects, usage) = tauri::async_runtime::spawn_blocking(scan_all)
        .await
        .map_err(|e| e.to_string())?;
    let mut g = state.inner.lock().unwrap();
    g.projects = Some(projects);
    g.usage = Some(usage.clone());
    Ok(usage)
}

#[tauri::command]
pub async fn refresh(state: State<'_, AppState>) -> Result<UsageStats, String> {
    {
        let mut g = state.inner.lock().unwrap();
        g.projects = None;
        g.usage = None;
        g.recaps = None;
    }
    get_usage_stats(state).await
}

#[tauri::command]
pub async fn list_sessions(project_id: String) -> Result<Vec<SessionSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || sessions_for_project(&project_id))
        .await
        .map_err(|e| e.to_string())
}

/// True if `s` is a single, safe path segment (no traversal, separators, drive
/// letters, or NUL). Guards against path-traversal via untrusted ids from the
/// web API.
pub fn is_safe_segment(s: &str) -> bool {
    !s.is_empty()
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains(':')
        && !s.contains('\0')
        && !s.contains("..")
}

pub fn sessions_for_project(project_id: &str) -> Vec<SessionSummary> {
    if !is_safe_segment(project_id) {
        return Vec::new();
    }
    let Some(base) = claude::projects_dir() else {
        return Vec::new();
    };
    let pd = base.join(project_id);
    let mut out = Vec::new();

    for sf in claude::top_level_sessions(&pd) {
        let Some(stem) = sf.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let scan = parse::scan_session(&sf);
        let mut tokens = scan.tokens;
        let mut cost = scan.cost;
        let mut models: BTreeSet<String> = scan.models.iter().cloned().collect();

        // Fold in subagent/workflow transcripts stored in the sidecar dir.
        let sidecar = pd.join(stem);
        let has_subagents = sidecar.is_dir();
        let mut size_bytes = fs::metadata(&sf).map(|m| m.len()).unwrap_or(0);
        if has_subagents {
            size_bytes += claude::dir_size(&sidecar);
            let mut sub = Vec::new();
            claude::jsonl_files_recursive(&sidecar, &mut sub);
            for f in &sub {
                parse::for_each_usage(f, |model, _day, t, c| {
                    tokens.add(t);
                    cost += c;
                    models.insert(model.to_string());
                });
            }
        }

        out.push(SessionSummary {
            id: stem.to_string(),
            project_id: project_id.to_string(),
            title: scan.title,
            first_prompt: scan.first_prompt,
            message_count: scan.message_count,
            user_messages: scan.user_messages,
            assistant_messages: scan.assistant_messages,
            size_bytes,
            start_time: scan.first_ts,
            end_time: scan.last_ts,
            tokens,
            cost_usd: cost,
            models: models.into_iter().collect(),
            git_branch: scan.git_branch,
            has_subagents,
            tool: "claude".into(),
        });
    }

    // Codex sessions that ran in this folder (or a codex-only project id).
    let real = claude::top_level_sessions(&pd)
        .iter()
        .find_map(|f| claude::first_cwd_in_file(f));
    for cs in crate::codex::scan_all_codex() {
        let matches = match &real {
            Some(rp) => cs.cwd.eq_ignore_ascii_case(rp),
            None => crate::codex::codex_project_id(&cs.cwd) == project_id,
        };
        if matches {
            let mut sm = cs.summary;
            sm.project_id = project_id.to_string();
            out.push(sm);
        }
    }
    for ags in crate::antigravity::scan_all_antigravity() {
        let matches = match &real {
            Some(rp) => ags.cwd.eq_ignore_ascii_case(rp),
            None => crate::antigravity::antigravity_project_id(&ags.cwd) == project_id,
        };
        if matches {
            let mut sm = ags.summary;
            sm.project_id = project_id.to_string();
            out.push(sm);
        }
    }

    out.sort_by(|a, b| b.start_time.cmp(&a.start_time));
    out
}

pub fn session_detail(project_id: &str, session_id: &str) -> Result<SessionDetail, String> {
    if !is_safe_segment(project_id) || !is_safe_segment(session_id) {
        return Err("Invalid id".to_string());
    }
    if session_id.starts_with("codex-") {
        let (scan, messages) = crate::codex::codex_session_detail(session_id)
            .ok_or_else(|| "Codex session not found".to_string())?;
        let mut summary = scan.summary;
        summary.project_id = project_id.to_string();
        return Ok(SessionDetail { summary, messages });
    }
    if session_id.starts_with("antigravity-") {
        let (scan, messages) = crate::antigravity::antigravity_session_detail(session_id)
            .ok_or_else(|| "Antigravity session not found".to_string())?;
        let mut summary = scan.summary;
        summary.project_id = project_id.to_string();
        return Ok(SessionDetail { summary, messages });
    }
    let base = claude::projects_dir().ok_or_else(|| "No ~/.claude/projects dir".to_string())?;
    let pd = base.join(project_id);
    let file = pd.join(format!("{session_id}.jsonl"));
    if !file.is_file() {
        return Err("Session file not found".to_string());
    }
    let messages = parse::parse_messages(&file);

    // Reuse the per-project session summary for consistent metrics.
    let summary = sessions_for_project(project_id)
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| "Session summary not found".to_string())?;

    Ok(SessionDetail { summary, messages })
}

#[tauri::command]
pub async fn get_session(
    project_id: String,
    session_id: String,
) -> Result<SessionDetail, String> {
    tauri::async_runtime::spawn_blocking(move || session_detail(&project_id, &session_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search(query: String, limit: Option<usize>) -> Result<Vec<SearchResult>, String> {
    let limit = limit.unwrap_or(200);
    tauri::async_runtime::spawn_blocking(move || run_search(&query, limit))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_any(
    terms: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    let limit = limit.unwrap_or(12);
    tauri::async_runtime::spawn_blocking(move || run_search_any(&terms, limit))
        .await
        .map_err(|e| e.to_string())
}

/// Retrieval for RAG: match ANY of the terms, ranked by how many matched.
pub fn run_search_any(terms: &[String], limit: usize) -> Vec<SearchResult> {
    let needles: Vec<String> = terms
        .iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| t.len() >= 2)
        .collect();
    if needles.is_empty() {
        return Vec::new();
    }
    let Some(base) = claude::projects_dir() else {
        return Vec::new();
    };
    let hist = claude::history_path_map();
    let mut scored: Vec<(usize, SearchResult)> = Vec::new();

    'outer: for id in claude::list_project_ids() {
        let pd = base.join(&id);
        let sessions = claude::top_level_sessions(&pd);
        let real_path = sessions
            .iter()
            .find_map(|f| claude::first_cwd_in_file(f))
            .or_else(|| hist.get(&id).cloned())
            .unwrap_or_else(|| id.clone());
        let project_name = claude::display_name(&real_path);

        for sf in &sessions {
            let Some(stem) = sf.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let mut title: Option<String> = None;
            parse::for_each_event(sf, |v| {
                if scored.len() >= 500 {
                    return;
                }
                let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
                if kind == "ai-title" {
                    if let Some(t) = v.get("aiTitle").and_then(Value::as_str) {
                        title = Some(t.to_string());
                    }
                    return;
                }
                if kind != "user" && kind != "assistant" {
                    return;
                }
                let text = event_text(v);
                if text.is_empty() {
                    return;
                }
                let low = text.to_lowercase();
                let mut score = 0usize;
                let mut best: Option<(usize, usize)> = None; // (byte pos, term byte len)
                for t in &needles {
                    if let Some(p) = low.find(t.as_str()) {
                        score += 1;
                        if best.map(|(bp, _)| p < bp).unwrap_or(true) {
                            best = Some((p, t.len()));
                        }
                    }
                }
                if score == 0 {
                    return;
                }
                let (bp, tl) = best.unwrap();
                let cp = low[..bp].chars().count();
                scored.push((
                    score,
                    SearchResult {
                        project_id: id.clone(),
                        project_name: project_name.clone(),
                        session_id: stem.to_string(),
                        session_title: title.clone(),
                        role: kind.to_string(),
                        timestamp: v.get("timestamp").and_then(Value::as_str).map(str::to_string),
                        snippet: snippet(&text, cp, tl),
                        ..Default::default()
                    },
                ));
            });
            if scored.len() >= 500 {
                break 'outer;
            }
        }
    }

    // ---- Codex rollouts, same scoring ---------------------------------------
    if scored.len() < 500 {
        for cs in crate::codex::scan_all_codex() {
            let mut msgs = Vec::new();
            if crate::codex::scan_rollout(&cs.file, Some(&mut msgs)).is_none() {
                continue;
            }
            let project_name = claude::display_name(&cs.cwd);
            for m in msgs {
                let low = m.text.to_lowercase();
                let mut score = 0usize;
                let mut best: Option<(usize, usize)> = None;
                for t in &needles {
                    if let Some(p) = low.find(t.as_str()) {
                        score += 1;
                        if best.map(|(bp, _)| p < bp).unwrap_or(true) {
                            best = Some((p, t.len()));
                        }
                    }
                }
                if score == 0 {
                    continue;
                }
                let (bp, tl) = best.unwrap();
                let cp = low[..bp].chars().count();
                scored.push((
                    score,
                    SearchResult {
                        project_id: crate::codex::codex_project_id(&cs.cwd),
                        project_name: project_name.clone(),
                        session_id: cs.id.clone(),
                        session_title: cs.summary.first_prompt.clone(),
                        role: m.role.clone(),
                        timestamp: m.timestamp.clone(),
                        snippet: snippet(&m.text, cp, tl),
                        ..Default::default()
                    },
                ));
                if scored.len() >= 500 {
                    break;
                }
            }
        }
    }

    // ---- Antigravity prompts ------------------------------------------------
    if scored.len() < 500 {
        for ags in crate::antigravity::scan_all_antigravity() {
            let project_name = claude::display_name(&ags.cwd);
            for (text, ms) in &ags.prompts {
                let low = text.to_lowercase();
                let mut score = 0usize;
                let mut best: Option<(usize, usize)> = None;
                for t in &needles {
                    if let Some(p) = low.find(t.as_str()) {
                        score += 1;
                        if best.map(|(bp, _)| p < bp).unwrap_or(true) {
                            best = Some((p, t.len()));
                        }
                    }
                }
                if score == 0 {
                    continue;
                }
                let (bp, tl) = best.unwrap();
                let cp = low[..bp].chars().count();
                scored.push((
                    score,
                    SearchResult {
                        project_id: crate::antigravity::antigravity_project_id(&ags.cwd),
                        project_name: project_name.clone(),
                        session_id: ags.id.clone(),
                        session_title: ags.summary.first_prompt.clone(),
                        role: "user".into(),
                        timestamp: Some(chrono::DateTime::<chrono::Utc>::from_timestamp(ms / 1000, 0).map(|d| d.to_rfc3339()).unwrap_or_default()),
                        snippet: snippet(text, cp, tl),
                        ..Default::default()
                    },
                ));
                if scored.len() >= 500 {
                    break;
                }
            }
        }
    }

    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.into_iter().take(limit).map(|(_, r)| r).collect()
}

pub fn run_search(query: &str, limit: usize) -> Vec<SearchResult> {
    let query = query.trim();
    let mut out = Vec::new();
    if query.is_empty() {
        return out;
    }
    let needle = query.to_lowercase();

    let Some(base) = claude::projects_dir() else {
        return out;
    };
    let hist = claude::history_path_map();

    'projects: for id in claude::list_project_ids() {
        let pd = base.join(&id);
        let sessions = claude::top_level_sessions(&pd);
        let real_path = sessions
            .iter()
            .find_map(|f| claude::first_cwd_in_file(f))
            .or_else(|| hist.get(&id).cloned())
            .unwrap_or_else(|| id.clone());
        let project_name = claude::display_name(&real_path);

        for sf in &sessions {
            let Some(stem) = sf.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let mut title: Option<String> = None;

            parse::for_each_event(sf, |v| {
                if out.len() >= limit {
                    return;
                }
                let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
                if kind == "ai-title" {
                    if let Some(t) = v.get("aiTitle").and_then(Value::as_str) {
                        title = Some(t.to_string());
                    }
                    return;
                }
                if kind != "user" && kind != "assistant" {
                    return;
                }
                let text = event_text(v);
                if text.is_empty() {
                    return;
                }
                let lower = text.to_lowercase();
                if let Some(bpos) = lower.find(&needle) {
                    // `bpos` is a byte offset into the *lowercased* string; convert
                    // to a char index so we can slice the original text safely.
                    let char_pos = lower[..bpos].chars().count();
                    out.push(SearchResult {
                        project_id: id.clone(),
                        project_name: project_name.clone(),
                        session_id: stem.to_string(),
                        session_title: title.clone(),
                        role: kind.to_string(),
                        timestamp: v.get("timestamp").and_then(Value::as_str).map(str::to_string),
                        snippet: snippet(&text, char_pos, needle.chars().count()),
                        ..Default::default()
                    });
                }
            });

            if out.len() >= limit {
                break 'projects;
            }
        }
    }

    out
}

/// Flatten an event's message content into a plain-text haystack.
pub(crate) fn event_text(v: &Value) -> String {
    let Some(content) = v.pointer("/message/content") else {
        return String::new();
    };
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
            let mut s = String::new();
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            s.push_str(t);
                            s.push(' ');
                        }
                    }
                    Some("tool_result") => {
                        if let Some(t) = b.get("content").and_then(Value::as_str) {
                            s.push_str(t);
                            s.push(' ');
                        }
                    }
                    _ => {}
                }
            }
            s
        }
        _ => String::new(),
    }
}

fn snippet(text: &str, char_pos: usize, needle_char_len: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let start = char_pos.saturating_sub(60);
    let end = (char_pos + needle_char_len + 120).min(chars.len());
    let mut s = String::new();
    if start > 0 {
        s.push('…');
    }
    s.extend(chars[start..end].iter());
    if end < chars.len() {
        s.push('…');
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------
// Disk / cleanup
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_disk_stats() -> Result<DiskStats, String> {
    tauri::async_runtime::spawn_blocking(disk_stats)
        .await
        .map_err(|e| e.to_string())
}

pub fn disk_stats() -> DiskStats {
    let mut stats = DiskStats::default();
    let hist = claude::history_path_map();
    let Some(base) = claude::projects_dir() else {
        return stats;
    };

    for id in claude::list_project_ids() {
        let pd = base.join(&id);
        let session_files = claude::top_level_sessions(&pd);
        let real_path = session_files
            .iter()
            .find_map(|f| claude::first_cwd_in_file(f))
            .or_else(|| hist.get(&id).cloned())
            .unwrap_or_else(|| id.clone());
        let name = claude::display_name(&real_path);
        let size_bytes = claude::dir_size(&pd);
        stats.total_bytes += size_bytes;

        let mut sessions = Vec::new();
        let mut last_activity: Option<String> = None;
        for sf in &session_files {
            let Some(stem) = sf.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let scan = parse::scan_session(sf);
            let mut sz = fs::metadata(sf).map(|m| m.len()).unwrap_or(0);
            let sidecar = pd.join(stem);
            if sidecar.is_dir() {
                sz += claude::dir_size(&sidecar);
            }
            if let Some(ts) = &scan.last_ts {
                if last_activity.as_deref().map(|l| ts > &l.to_string()).unwrap_or(true) {
                    last_activity = Some(ts.clone());
                }
            }
            sessions.push(DiskSession {
                id: stem.to_string(),
                title: scan.title,
                size_bytes: sz,
                last_activity: scan.last_ts,
            });
        }
        sessions.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));

        stats.projects.push(DiskProject {
            id,
            name,
            size_bytes,
            session_count: session_files.len(),
            last_activity,
            sessions,
        });
    }

    stats.projects.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    stats
}

// ---------------------------------------------------------------------------
// Daily recaps
// ---------------------------------------------------------------------------

/// Group sessions into per-day recaps.
///
/// Note: a session is attributed in full to its **start day** (a deliberately
/// coarser view than the dashboard's per-message `by_day`), so a session that
/// crosses UTC midnight counts entirely on the day it began. Only sessions with
/// a live top-level transcript are included.
pub fn daily_recaps() -> Vec<DayRecap> {
    struct ProjAcc {
        name: String,
        session_count: usize,
        message_count: usize,
        tokens: TokenTotals,
        cost: f64,
        sessions: Vec<DayRecapSession>,
    }

    let Some(base) = claude::projects_dir() else {
        return Vec::new();
    };
    let hist = claude::history_path_map();

    // day -> project_id -> accumulator
    let mut days: BTreeMap<String, HashMap<String, ProjAcc>> = BTreeMap::new();

    for id in claude::list_project_ids() {
        let pd = base.join(&id);
        let real_path = claude::top_level_sessions(&pd)
            .iter()
            .find_map(|f| claude::first_cwd_in_file(f))
            .or_else(|| hist.get(&id).cloned())
            .unwrap_or_else(|| id.clone());
        let name = claude::display_name(&real_path);

        for s in sessions_for_project(&id) {
            let day = s
                .start_time
                .as_deref()
                .and_then(|t| t.get(..10))
                .unwrap_or("unknown")
                .to_string();

            let proj = days
                .entry(day)
                .or_default()
                .entry(id.clone())
                .or_insert_with(|| ProjAcc {
                    name: name.clone(),
                    session_count: 0,
                    message_count: 0,
                    tokens: TokenTotals::default(),
                    cost: 0.0,
                    sessions: Vec::new(),
                });
            proj.session_count += 1;
            proj.message_count += s.message_count;
            proj.tokens.add(&s.tokens);
            proj.cost += s.cost_usd;
            proj.sessions.push(DayRecapSession {
                id: s.id,
                title: s.title,
                first_prompt: s.first_prompt,
                message_count: s.message_count,
                tokens: s.tokens,
            });
        }
    }

    let mut out: Vec<DayRecap> = days
        .into_iter()
        .map(|(day, projmap)| {
            let mut projects: Vec<DayRecapProject> = Vec::new();
            let mut cost = 0.0;
            for (id, acc) in projmap {
                cost += acc.cost;
                projects.push(DayRecapProject {
                    id,
                    name: acc.name,
                    session_count: acc.session_count,
                    message_count: acc.message_count,
                    tokens: acc.tokens,
                    sessions: acc.sessions,
                });
            }
            projects.sort_by(|a, b| b.tokens.grand_total().cmp(&a.tokens.grand_total()));

            let mut tokens = TokenTotals::default();
            let mut session_count = 0;
            let mut message_count = 0;
            for p in &projects {
                tokens.add(&p.tokens);
                session_count += p.session_count;
                message_count += p.message_count;
            }
            DayRecap {
                day,
                session_count,
                message_count,
                tokens,
                cost_usd: cost,
                projects,
            }
        })
        .collect();

    // Newest day first, with the "unknown" (undated) bucket always last.
    out.sort_by(|a, b| match (a.day.as_str(), b.day.as_str()) {
        ("unknown", "unknown") => std::cmp::Ordering::Equal,
        ("unknown", _) => std::cmp::Ordering::Greater,
        (_, "unknown") => std::cmp::Ordering::Less,
        (x, y) => y.cmp(x),
    });
    out
}

#[tauri::command]
pub async fn get_daily_recaps(state: State<'_, AppState>) -> Result<Vec<DayRecap>, String> {
    {
        let g = state.inner.lock().unwrap();
        if let Some(r) = &g.recaps {
            return Ok(r.clone());
        }
    }
    let recaps = tauri::async_runtime::spawn_blocking(daily_recaps)
        .await
        .map_err(|e| e.to_string())?;
    state.inner.lock().unwrap().recaps = Some(recaps.clone());
    Ok(recaps)
}

// ---------------------------------------------------------------------------
// Mutations (delete / archive) — path-validated
// ---------------------------------------------------------------------------

/// Resolve and validate the paths for a session, guarding against traversal.
fn resolve_session(project_id: &str, session_id: &str) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    if !is_safe_segment(project_id) || !is_safe_segment(session_id) {
        return Err("Invalid id".into());
    }
    let base = claude::projects_dir().ok_or("No projects dir")?;
    let pd = base.join(project_id);
    let canonical_base = base.canonicalize().map_err(|e| e.to_string())?;
    let canonical_pd = pd.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_pd.starts_with(&canonical_base) {
        return Err("Path escapes projects dir".into());
    }
    let file = pd.join(format!("{session_id}.jsonl"));
    let sidecar = pd.join(session_id);
    Ok((pd, file, sidecar))
}

fn clear_cache(state: &State<'_, AppState>) {
    let mut g = state.inner.lock().unwrap();
    g.projects = None;
    g.usage = None;
    g.recaps = None;
}

#[tauri::command]
pub fn delete_session(
    state: State<'_, AppState>,
    project_id: String,
    session_id: String,
) -> Result<(), String> {
    let (_pd, file, sidecar) = resolve_session(&project_id, &session_id)?;
    if file.is_file() {
        fs::remove_file(&file).map_err(|e| e.to_string())?;
    }
    if sidecar.is_dir() {
        fs::remove_dir_all(&sidecar).map_err(|e| e.to_string())?;
    }
    clear_cache(&state);
    Ok(())
}

#[tauri::command]
pub fn archive_session(
    state: State<'_, AppState>,
    project_id: String,
    session_id: String,
) -> Result<(), String> {
    let (_pd, file, sidecar) = resolve_session(&project_id, &session_id)?;
    let archive = claude::archive_dir().ok_or("No archive dir")?;
    let dest_dir = archive.join(&project_id);
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    if file.is_file() {
        let dest = unique_dest(&dest_dir, &format!("{session_id}.jsonl"));
        move_file(&file, &dest)?;
    }
    if sidecar.is_dir() {
        let dest = unique_dest(&dest_dir, &session_id);
        move_dir(&sidecar, &dest)?;
    }
    clear_cache(&state);
    Ok(())
}

/// A destination path in `dir` for `name` that does not already exist.
fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    let mut candidate = dir.join(name);
    let mut i = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{name}.{i}"));
        i += 1;
    }
    candidate
}

/// Move a file, falling back to copy+delete across volumes.
fn move_file(src: &Path, dst: &Path) -> Result<(), String> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    fs::copy(src, dst).map_err(|e| e.to_string())?;
    fs::remove_file(src).map_err(|e| e.to_string())?;
    Ok(())
}

/// Move a directory, falling back to recursive copy+delete across volumes.
fn move_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    copy_dir_recursive(src, dst)?;
    fs::remove_dir_all(src).map_err(|e| e.to_string())?;
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Opening things in the OS
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    open_os(&path, OpenMode::Folder)
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    open_os(&path, OpenMode::Reveal)
}

/// On Windows, stop a console child from popping a window out of the GUI app.
pub(crate) fn no_window(cmd: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
    }
}

// ---------------------------------------------------------------------------
// Vault git sync — the vault is a git repo backed up to GitHub. Commit local
// changes (matching the user's "vault backup: …" message style), rebase on
// the remote, push. Fired after skill runs write reports, or manually.
// ---------------------------------------------------------------------------

fn git_in(dir: &Path, args: &[&str]) -> Result<(bool, String), String> {
    let mut c = std::process::Command::new("git");
    c.arg("-C").arg(dir).args(args);
    no_window(&mut c);
    let out = c.output().map_err(|e| format!("git not available: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok((out.status.success(), text))
}

pub fn sync_vault_git_impl(dir: &str) -> Result<String, String> {
    let vault = Path::new(dir)
        .canonicalize()
        .map_err(|_| "vault folder not found".to_string())?;
    // The vault dir may be a subfolder of the repo (e.g. MainVault\Projects\…\
    // Generated inside the MainVault repo) — walk up to the actual git root
    // and back up the whole vault repo, obsidian-git style.
    let Some(base) = vault
        .ancestors()
        .find(|p| p.join(".git").exists())
        .map(Path::to_path_buf)
    else {
        return Ok("vault isn't inside a git repo — nothing to sync".into());
    };
    git_in(&base, &["add", "-A"])?;
    let (clean, _) = git_in(&base, &["diff", "--cached", "--quiet"])?;
    if !clean {
        let msg = format!("vault backup: {}", now_iso());
        let (ok, t) = git_in(&base, &["commit", "-m", &msg])?;
        if !ok {
            return Err(format!("commit failed: {}", t.trim()));
        }
    }
    let (ok, t) = git_in(&base, &["pull", "--rebase"])?;
    if !ok {
        // Never leave the vault wedged mid-rebase.
        let _ = git_in(&base, &["rebase", "--abort"]);
        return Err(format!("pull --rebase failed (aborted): {}", t.trim()));
    }
    // Push to the configured upstream explicitly — plain `git push` refuses
    // when the local and upstream branch names differ (e.g. master →
    // obsidian/obsidianNotes, as in this user's vault).
    let (has_up, up) = git_in(
        &base,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )?;
    let up = up.trim().to_string();
    let refspec;
    let push_args: Vec<&str> = match (has_up, up.split_once('/')) {
        (true, Some((remote, branch))) => {
            refspec = format!("HEAD:{branch}");
            vec!["push", remote, refspec.as_str()]
        }
        _ => vec!["push"],
    };
    let (ok, t) = git_in(&base, &push_args)?;
    if !ok {
        return Err(format!("push failed: {}", t.trim()));
    }
    Ok(if clean {
        "vault already committed — pulled & pushed".into()
    } else {
        "vault committed & pushed".into()
    })
}

#[tauri::command]
pub async fn sync_vault_git(dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || sync_vault_git_impl(&dir))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Publish to an explicitly configured SSH destination. Write then rename so
// readers never see a half-written file. SSH credentials stay in ~/.ssh/config.
// ---------------------------------------------------------------------------

pub fn push_schedule_site_impl(json: &str, ssh_host: &str, remote_path: &str) -> Result<(), String> {
    // Validate the shape before it can reach the live site.
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("bad schedule JSON: {e}"))?;
    if !v.is_array() {
        return Err("schedule JSON must be a top-level array".into());
    }
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;

    ssh_pipe_to_file(ssh_host, remote_path, pretty.as_bytes())
}

/// Allow only simple SSH host/config aliases and absolute POSIX file paths.
/// These values become SSH arguments and remote shell syntax, so fail closed.
pub(crate) fn validate_publish_target(ssh_host: &str, remote_path: &str) -> Result<(), String> {
    let parts: Vec<_> = ssh_host.split('@').collect();
    if parts.len() > 2 || parts.iter().any(|part| {
        !part.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
            || !part.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    }) {
        return Err("configure a valid SSH host or alias (optionally user@host) in Settings".into());
    }
    if !remote_path.starts_with('/') || remote_path.ends_with('/')
        || !remote_path.bytes().all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
        || remote_path[1..].split('/').any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("remote destination must be an absolute file path using letters, numbers, /, ., _, or - (no dot segments)".into());
    }
    Ok(())
}

pub(crate) fn ssh_pipe_to_file(ssh_host: &str, remote_path: &str, body: &[u8]) -> Result<(), String> {
    validate_publish_target(ssh_host, remote_path)?;
    let parent = remote_path.rsplit_once('/').map(|(p, _)| p).filter(|p| !p.is_empty()).unwrap_or("/");
    let remote_sh = format!("mkdir -p {parent} && cat > {remote_path}.new && mv {remote_path}.new {remote_path}");
    let mut c = std::process::Command::new("ssh");
    c.args([
        "-o",
        "BatchMode=yes", // never hang on an interactive prompt
        "-o",
        "ConnectTimeout=10",
        ssh_host,
        &remote_sh,
    ]);
    c.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    no_window(&mut c);
    let mut child = c.spawn().map_err(|e| format!("couldn't run ssh: {e}"))?;
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().ok_or("ssh stdin unavailable")?;
        stdin
            .write_all(body)
            .map_err(|e| format!("writing to ssh: {e}"))?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let short: String = err.trim().chars().take(300).collect();
        return Err(format!(
            "push failed ({}): {}",
            out.status,
            if short.is_empty() { "no error output — check the SSH host and key authentication" } else { &short }
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn push_schedule_site(json: String, ssh_host: String, remote_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || push_schedule_site_impl(&json, &ssh_host, &remote_path))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Remote access info — everything the Settings card needs to pair the phone:
// serve health, Tailscale IP, tokened URL, and a QR of it.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub serve_up: bool,
    pub tailscale_ip: Option<String>,
    pub url: String,
    pub qr_svg: String,
}

#[tauri::command]
pub async fn remote_info() -> Result<RemoteInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let serve_up = ureq::get("http://127.0.0.1:4600/api/health")
            .timeout(std::time::Duration::from_secs(2))
            .call()
            .is_ok();
        let tailscale_ip = {
            let mut c = std::process::Command::new("tailscale");
            c.args(["ip", "-4"]);
            no_window(&mut c);
            c.output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .next()
                        .map(|s| s.trim().to_string())
                })
                .filter(|s| !s.is_empty())
        };
        let token = ensure_serve_token()?;
        let host = tailscale_ip.clone().unwrap_or_else(|| "localhost".into());
        let url = format!("http://{host}:4600/?token={token}");
        let qr = qrcode::QrCode::new(url.as_bytes()).map_err(|e| e.to_string())?;
        let qr_svg = qr
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(200, 200)
            .quiet_zone(true)
            .build();
        Ok(RemoteInfo { serve_up, tailscale_ip, url, qr_svg })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Home Assistant conversation — free text to HA's own intent engine, which
// already knows the user's entities/areas. Returns the spoken reply.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HaReply {
    pub speech: String,
    /// Pass back on the next call for follow-ups ("and the kitchen too").
    pub conversation_id: Option<String>,
}

pub fn ha_conversation_impl(
    url: &str,
    token: &str,
    text: &str,
    conversation_id: Option<&str>,
) -> Result<HaReply, String> {
    let base = url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Set the Home Assistant URL in Settings first.".into());
    }
    let token = crate::secrets::resolve_secrets(token);
    let token = token.as_str();
    let mut body = serde_json::json!({ "text": text, "language": "en" });
    if let Some(id) = conversation_id.filter(|s| !s.is_empty()) {
        body["conversation_id"] = serde_json::json!(id);
    }
    let resp = ureq::request("POST", &format!("{base}/api/conversation/process"))
        .set("Authorization", &format!("Bearer {}", token.trim()))
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send_string(&body.to_string())
        .map_err(|e| format!("Home Assistant unreachable: {e}"))?;
    let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    let speech = v
        .pointer("/response/speech/plain/speech")
        .and_then(|s| s.as_str())
        .unwrap_or("Done.");
    Ok(HaReply {
        speech: speech.to_string(),
        conversation_id: v
            .get("conversation_id")
            .and_then(|s| s.as_str())
            .map(String::from),
    })
}

#[tauri::command]
pub async fn ha_conversation(
    url: String,
    token: String,
    text: String,
    conversation_id: Option<String>,
) -> Result<HaReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ha_conversation_impl(&url, &token, &text, conversation_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- Home Assistant states + service calls (the Deck "Home" card) ----------

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HaEntity {
    pub id: String,
    pub name: String,
    pub state: String,
    pub unit: String,
    pub domain: String,
}

/// Map HA's /api/states array; empty `entity_ids` = all, else filter keeping
/// the request order (the picker's order is the card's order).
fn ha_entities_from_states(v: &serde_json::Value, entity_ids: &[String]) -> Vec<HaEntity> {
    let all: Vec<HaEntity> = v
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let id = e.get("entity_id")?.as_str()?.to_string();
                    let name = e
                        .pointer("/attributes/friendly_name")
                        .and_then(|s| s.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    Some(HaEntity {
                        domain: id.split('.').next().unwrap_or("").to_string(),
                        name,
                        state: e.get("state").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                        unit: e
                            .pointer("/attributes/unit_of_measurement")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string(),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if entity_ids.is_empty() {
        return all;
    }
    entity_ids
        .iter()
        .filter_map(|want| all.iter().find(|e| &e.id == want).cloned())
        .collect()
}

fn ha_base(url: &str) -> Result<String, String> {
    let base = url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Set the Home Assistant URL in Settings first.".into());
    }
    Ok(base.to_string())
}

pub fn ha_states_impl(url: &str, token: &str, entity_ids: &[String]) -> Result<Vec<HaEntity>, String> {
    let base = ha_base(url)?;
    let token = crate::secrets::resolve_secrets(token);
    let resp = ureq::request("GET", &format!("{base}/api/states"))
        .set("Authorization", &format!("Bearer {}", token.trim()))
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| format!("Home Assistant unreachable: {e}"))?;
    let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    Ok(ha_entities_from_states(&v, entity_ids))
}

pub fn ha_call_service_impl(
    url: &str,
    token: &str,
    domain: &str,
    service: &str,
    entity_id: &str,
) -> Result<(), String> {
    // domain/service become URL path segments — lock them down.
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c == '_');
    if !ok(domain) || !ok(service) {
        return Err("bad service name".into());
    }
    let base = ha_base(url)?;
    let token = crate::secrets::resolve_secrets(token);
    ureq::request("POST", &format!("{base}/api/services/{domain}/{service}"))
        .set("Authorization", &format!("Bearer {}", token.trim()))
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(15))
        .send_string(&serde_json::json!({ "entity_id": entity_id }).to_string())
        .map_err(|e| format!("Home Assistant unreachable: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn ha_states(
    url: String,
    token: String,
    entity_ids: Vec<String>,
) -> Result<Vec<HaEntity>, String> {
    tauri::async_runtime::spawn_blocking(move || ha_states_impl(&url, &token, &entity_ids))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ha_call_service(
    url: String,
    token: String,
    domain: String,
    service: String,
    entity_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        ha_call_service_impl(&url, &token, &domain, &service, &entity_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// User scripts — .bat/.cmd/.ps1 files dropped into ~/.claude/cipher-manager/
// scripts/, runnable from the app including the phone via serve ("close my
// work programs" from the couch). Execution is confined to that folder and
// names are validated — the web endpoint must never run an arbitrary path.
// ---------------------------------------------------------------------------

fn scripts_dir() -> Result<PathBuf, String> {
    let root = claude::claude_root().ok_or("No ~/.claude directory")?;
    let dir = root.join("cipher-manager").join("scripts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn list_user_scripts_impl() -> Result<Vec<String>, String> {
    let mut out: Vec<String> = fs::read_dir(scripts_dir()?)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            let l = n.to_lowercase();
            (l.ends_with(".bat") || l.ends_with(".cmd") || l.ends_with(".ps1")).then_some(n)
        })
        .collect();
    out.sort();
    Ok(out)
}

/// A plain filename inside the scripts dir — no separators, no traversal.
fn valid_script_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
}

pub fn run_user_script_impl(name: &str) -> Result<String, String> {
    require_acting_mode()?;
    if !valid_script_name(name) {
        return Err("bad script name".into());
    }
    let path = scripts_dir()?.join(name);
    if !path.is_file() {
        return Err(format!("script not found: {name}"));
    }
    let lower = name.to_lowercase();
    let mut c = if lower.ends_with(".ps1") {
        let mut c = std::process::Command::new("powershell");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(&path);
        c
    } else if lower.ends_with(".bat") || lower.ends_with(".cmd") {
        let mut c = std::process::Command::new("cmd");
        c.arg("/c").arg(&path);
        c
    } else {
        return Err("only .bat/.cmd/.ps1 scripts are supported".into());
    };
    no_window(&mut c);
    let out = c.output().map_err(|e| e.to_string())?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        Ok(text.trim().to_string())
    } else {
        Err(format!("script exited {}: {}", out.status, text.trim()))
    }
}

#[tauri::command]
pub fn list_user_scripts() -> Result<Vec<String>, String> {
    list_user_scripts_impl()
}

#[tauri::command]
pub async fn run_user_script(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_user_script_impl(&name))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Shared app state — small JSON blobs (settings, automations, todos) persisted
// under ~/.claude/cipher-manager/ so the desktop app and the web server (and
// thus a phone) share one config. localStorage stays the in-browser cache.
// ---------------------------------------------------------------------------

pub(crate) fn app_state_dir() -> Result<std::path::PathBuf, String> {
    // Tests (and portable setups) can pin the state root explicitly so the
    // suite never touches the real ~/.claude.
    let dir = match std::env::var("CIPHER_STATE_DIR") {
        Ok(p) if !p.trim().is_empty() => std::path::PathBuf::from(p),
        _ => dirs::home_dir().ok_or("No home directory")?.join(".claude").join("cipher-manager"),
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Serializes tests that re-point CIPHER_STATE_DIR (the env var is
/// process-global, so parallel test threads would clobber each other).
#[cfg(test)]
pub(crate) fn state_env_lock() -> &'static std::sync::Mutex<()> {
    static L: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &L
}

/// Scoped unit-test profile. Callers hold state_env_lock; both overrides are
/// restored even if an assertion unwinds, and no real home directory is read.
#[cfg(test)]
pub(crate) struct TestProfile {
    root: tempfile::TempDir,
    previous: [(String, Option<std::ffi::OsString>); 2],
}

#[cfg(test)]
impl TestProfile {
    pub(crate) fn new(prefix: &str, acting: bool) -> Self {
        let root = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
        fs::create_dir(root.path().join("projects")).unwrap();
        let previous = ["CIPHER_STATE_DIR", "CIPHER_CLAUDE_DIR"].map(|key| (key.to_string(), std::env::var_os(key)));
        std::env::set_var("CIPHER_STATE_DIR", root.path().join("state"));
        std::env::set_var("CIPHER_CLAUDE_DIR", root.path());
        let profile = Self { root, previous };
        write_app_state("settings", &format!("{{\"actingMode\":{acting}}}")).unwrap();
        profile
    }
}

#[cfg(test)]
impl std::ops::Deref for TestProfile {
    type Target = Path;
    fn deref(&self) -> &Path { self.root.path() }
}

#[cfg(test)]
impl Drop for TestProfile {
    fn drop(&mut self) {
        for (key, value) in &self.previous {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

fn valid_state_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 40 && k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn read_app_state(key: &str) -> Result<Option<String>, String> {
    if !valid_state_key(key) {
        return Err("bad state key".into());
    }
    let path = app_state_dir()?.join(format!("{key}.json"));
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn write_app_state(key: &str, json: &str) -> Result<(), String> {
    if !valid_state_key(key) {
        return Err("bad state key".into());
    }
    // Must be valid JSON — this file is trusted by every client.
    serde_json::from_str::<serde_json::Value>(json).map_err(|e| format!("not JSON: {e}"))?;
    // ponytail: one in-process lock for these small blobs; per-key locks only
    // if state-save contention becomes measurable. Atomic replacement also
    // protects readers and writers in the other desktop/server process.
    static WRITES: Mutex<()> = Mutex::new(());
    let _guard = WRITES.lock().map_err(|_| "state write lock poisoned")?;
    atomic_write(&app_state_dir()?.join(format!("{key}.json")), json.as_bytes())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("missing parent")?)
        .map_err(|e| e.to_string())?;
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Every execution entry point uses the same persisted, fail-closed switch.
pub fn require_acting_mode() -> Result<(), String> {
    let enabled = read_app_state("settings").ok().flatten()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("actingMode").and_then(|b| b.as_bool()))
        .unwrap_or(false);
    if enabled { Ok(()) } else { Err("Acting mode is disabled; enable it in Settings first.".into()) }
}

// --- Even G2 pairing (desktop Settings only — approval must stay local) ---

#[tauri::command]
pub fn g2_pair_pending() -> Vec<serde_json::Value> {
    crate::g2::pair_pending()
}

#[tauri::command]
pub fn g2_pair_approve(code: String) -> Result<(), String> {
    crate::g2::pair_approve(&code)
}

#[tauri::command]
pub fn g2_clients() -> Vec<serde_json::Value> {
    crate::g2::clients()
}

#[tauri::command]
pub fn g2_revoke(id: String) -> Result<(), String> {
    crate::g2::revoke(&id)
}

#[tauri::command]
pub async fn load_app_state(key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_app_state(&key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_app_state(key: String, json: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_app_state(&key, &json))
        .await
        .map_err(|e| e.to_string())?
}

/// Read (or mint) the web server's access token. ponytail: entropy comes from
/// std's RandomState (OS-seeded SipHash keys) — plenty for a LAN token; swap
/// in a real RNG crate if this ever guards more than the home network.
pub fn ensure_serve_token() -> Result<String, String> {
    let path = app_state_dir()?.join("serve-token.txt");
    load_or_create_serve_token(&path)
}

fn load_or_create_serve_token(path: &Path) -> Result<String, String> {
    if let Ok(t) = fs::read_to_string(&path) {
        let t = t.trim().to_string();
        if t.len() >= 32 {
            return Ok(t);
        }
        return Err("Stored server token is invalid; remove serve-token.txt while the app and server are stopped.".into());
    }
    use std::hash::{BuildHasher, Hasher};
    let mut token = String::new();
    for i in 0..4u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i);
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        token.push_str(&format!("{:016x}", h.finish()));
    }
    use std::io::Write;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("missing parent")?).map_err(|e| e.to_string())?;
    temp.write_all(token.as_bytes()).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    match temp.persist_noclobber(path) {
        Ok(_) => Ok(token),
        Err(error) => {
            // Another process won initial creation; use its complete token.
            // Never replace an existing token during startup.
            fs::read_to_string(path).ok().map(|s| s.trim().to_string())
                .filter(|s| s.len() >= 32).ok_or_else(|| error.to_string())
        }
    }
}

/// Frontend (Tauri mode) needs the serve token to call the agent-session
/// endpoints on localhost:4600 with an Authorization header.
#[tauri::command]
pub fn get_serve_token() -> Result<String, String> {
    ensure_serve_token()
}

// ---------------------------------------------------------------------------
// System automations launch this application with a checked task slug.
// Prompts/options stay in JSON, never in a generated shell script.
// ---------------------------------------------------------------------------

fn task_files_dir() -> Result<std::path::PathBuf, String> {
    let dir = if std::env::var("CIPHER_STATE_DIR").is_ok() {
        app_state_dir()?.join("tasks")
    } else {
        dirs::home_dir().ok_or("No home directory")?.join(".claude/cipher-jobs/tasks")
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn valid_task_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 60
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SystemTask {
    prompt: String,
    bin: String,
    extra: Vec<String>,
    cwd: Option<String>,
}

fn save_task_config(path: &Path, bytes: &[u8], schedule: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    use std::io::Write;
    let mut pending = tempfile::NamedTempFile::new_in(path.parent().ok_or("missing parent")?).map_err(|e| e.to_string())?;
    pending.write_all(bytes).map_err(|e| e.to_string())?;
    pending.as_file().sync_all().map_err(|e| e.to_string())?;
    // The checked runner cannot see staged options until registration succeeds.
    schedule()?;
    pending.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Called before Tauri starts; waiting here keeps Task Scheduler's run status
/// accurate and prevents its next trigger overlapping the same invocation.
pub fn run_system_task(slug: &str) -> Result<(), String> {
    require_acting_mode()?;
    if !valid_task_slug(slug) { return Err("bad task slug".into()); }
    let raw = fs::read(task_files_dir()?.join(format!("{slug}.json"))).map_err(|e| e.to_string())?;
    let task: SystemTask = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    if task.prompt.trim().is_empty() { return Err("Prompt is empty".into()); }
    validate_job_command(&task.bin, &task.extra)?;
    let cwd = resolve_cwd(task.cwd)?;
    let id = job_new(slug, slug, cwd.clone());
    // Synchronous here so the audit is flushed before this process exits.
    run_child(id.clone(), task.prompt, task.bin, task.extra, cwd, None);
    let job = jobs().lock().map_err(|_| "job lock poisoned")?.get(&id).cloned().ok_or("job missing")?;
    if job.status == "done" { Ok(()) } else { Err("Scheduled job failed; inspect the job audit.".into()) }
}

/// Disable the old generated launchers before touching Task Scheduler. Even
/// if schtasks refuses the update, their existing actions can no longer run
/// an unchecked agent. JSON tasks are unaffected and can be recreated in UI.
#[tauri::command]
pub fn migrate_legacy_system_tasks() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        migrate_legacy_tasks_in(&task_files_dir()?, |slug| {
            schtasks(&["/Change", "/TN", &format!("CipherManager-{slug}"), "/DISABLE"])
        })
    }
    #[cfg(not(windows))]
    Ok(Vec::new())
}

#[cfg(any(windows, test))]
fn migrate_legacy_tasks_in(dir: &Path, disable: impl Fn(&str) -> Result<(), String>) -> Result<Vec<String>, String> {
    let mut disabled = Vec::new();
    let mut failures = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("cmd") { continue; }
        let Some(slug) = path.file_stem().and_then(|s| s.to_str()).filter(|s| valid_task_slug(s)) else { continue };
        atomic_write(&path, b"@echo off\r\nrem Legacy automation disabled; recreate it in cipherManager.\r\nexit /b 1\r\n")?;
        // A recreated task has a checked JSON action; don't disable it.
        if !dir.join(format!("{slug}.json")).is_file() {
            if disable(slug).is_err() {
                failures.push(slug.to_string());
                continue;
            }
            disabled.push(slug.to_string());
        }
        // The old action now points to a missing/inert file even if manually
        // reenabled; completed migrations are not repeated next startup.
        fs::rename(&path, path.with_extension("legacy-disabled")).map_err(|e| e.to_string())?;
    }
    if !failures.is_empty() {
        return Err(format!("Legacy launchers were blocked, but Task Scheduler could not disable: {}. Update or delete these automations.", failures.join(", ")));
    }
    Ok(disabled)
}

#[cfg(target_os = "windows")]
fn schtasks(args: &[&str]) -> Result<(), String> {
    let mut c = std::process::Command::new("schtasks");
    c.args(args);
    no_window(&mut c);
    let out = c.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[tauri::command]
#[allow(unused_variables)]
pub async fn create_system_task(
    slug: String,
    time: String,
    days: Vec<String>,
    prompt: String,
    bin: Option<String>,
    args: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    return Err("System automations are Windows-only".into());
    #[cfg(target_os = "windows")]
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_task_slug(&slug) {
            return Err("Automation name must reduce to a simple slug".into());
        }
        let time_ok = time.len() == 5
            && time.as_bytes()[2] == b':'
            && time[..2].parse::<u32>().map(|h| h < 24).unwrap_or(false)
            && time[3..].parse::<u32>().map(|m| m < 60).unwrap_or(false);
        if !time_ok {
            return Err("time must be HH:MM".into());
        }
        const DAY_OK: [&str; 7] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
        if !days.iter().all(|d| DAY_OK.contains(&d.as_str())) {
            return Err("invalid day token".into());
        }

        let dir = task_files_dir()?;
        let bin = bin
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "claude".into());
        require_acting_mode()?;
        let extra = split_args(&args.unwrap_or_default());
        validate_job_command(&bin, &extra)?;
        let config = SystemTask { prompt, bin, extra, cwd: resolve_cwd(cwd)? };
        let json = serde_json::to_vec(&config).map_err(|e| e.to_string())?;
        let tn = format!("CipherManager-{slug}");
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let tr = format!("\"{}\" --run-system-task {}", exe.display(), slug);
        let mut a: Vec<&str> = vec!["/Create", "/TN", &tn, "/TR", &tr, "/ST", &time, "/F"];
        let day_list = days.join(",");
        if days.is_empty() {
            a.extend(["/SC", "DAILY"]);
        } else {
            a.extend(["/SC", "WEEKLY", "/D", &day_list]);
        }
        save_task_config(&dir.join(format!("{slug}.json")), &json, || schtasks(&a))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(unused_variables)]
pub async fn delete_system_task(slug: String) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    return Err("System automations are Windows-only".into());
    #[cfg(target_os = "windows")]
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_task_slug(&slug) {
            return Err("bad slug".into());
        }
        let r = schtasks(&["/Delete", "/TN", &format!("CipherManager-{slug}"), "/F"]);
        if let Ok(dir) = task_files_dir() {
            for ext in ["cmd", "prompt.txt", "log", "json"] {
                let _ = fs::remove_file(dir.join(format!("{slug}.{ext}")));
            }
        }
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(unused_variables)]
pub async fn set_system_task_enabled(slug: String, enabled: bool) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    return Err("System automations are Windows-only".into());
    #[cfg(target_os = "windows")]
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_task_slug(&slug) {
            return Err("bad slug".into());
        }
        if enabled {
            require_acting_mode()?;
            if !task_files_dir()?.join(format!("{slug}.json")).is_file() {
                return Err("Legacy automation: update this task before enabling it.".into());
            }
        }
        schtasks(&[
            "/Change",
            "/TN",
            &format!("CipherManager-{slug}"),
            if enabled { "/ENABLE" } else { "/DISABLE" },
        ])
    })
    .await
    .map_err(|e| e.to_string())?
}

// Launch-at-login via a Startup-folder .lnk shortcut. The HKCU Run key is the
// "correct" place, but security software (Bitdefender's anti-persistence shield)
// blocks writes to it — `reg add` returns Access Denied even for the user's own
// hive. We used a .vbs launcher here before, but Bitdefender quarantines Startup
// scripts too; a plain shortcut is left alone.
#[cfg(target_os = "windows")]
fn startup_path(name: &str) -> Result<PathBuf, String> {
    // dirs::config_dir() == %APPDATA% (Roaming) on Windows.
    let base = dirs::config_dir().ok_or("no APPDATA")?;
    Ok(base
        .join(r"Microsoft\Windows\Start Menu\Programs\Startup")
        .join(name))
}

#[tauri::command]
pub fn get_autostart() -> bool {
    #[cfg(target_os = "windows")]
    {
        // The .vbs is the pre-migration launcher; still counts as "on".
        ["cipherManager.lnk", "cipherManager.vbs"]
            .iter()
            .any(|n| startup_path(n).map(|p| p.exists()).unwrap_or(false))
    }
    #[cfg(not(target_os = "windows"))]
    false
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let lnk = startup_path("cipherManager.lnk")?;
        let vbs = startup_path("cipherManager.vbs")?;
        if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            if let Some(dir) = lnk.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            // std can't write .lnk files; a one-shot hidden PowerShell drives
            // the WScript.Shell COM object. Single-quoted PS strings — Windows
            // paths can't contain quotes.
            let ps = format!(
                "$l=(New-Object -ComObject WScript.Shell).CreateShortcut('{}'); $l.TargetPath='{}'; $l.Save()",
                lnk.display(),
                exe.display()
            );
            let mut c = std::process::Command::new("powershell");
            c.args(["-NoProfile", "-Command", &ps]);
            no_window(&mut c);
            let out = c.output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            let _ = fs::remove_file(&vbs); // migrate off the flagged launcher
        } else {
            for p in [lnk, vbs] {
                if p.exists() {
                    fs::remove_file(&p).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("autostart is Windows-only for now".to_string())
    }
}

/// Open a terminal window at `path`, optionally running a command in it
/// (e.g. `claude --continue` to resume a project in Claude Code).
#[tauri::command]
pub fn open_terminal(path: String, run: Option<String>) -> Result<(), String> {
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        // `start` inherits the cwd; /k keeps the window open so errors are visible.
        let mut args = vec!["/c".to_string(), "start".to_string(), "cmd".to_string()];
        match run.filter(|r| !r.trim().is_empty()) {
            Some(r) => {
                args.push("/k".to_string());
                args.extend(r.split_whitespace().map(str::to_string));
            }
            None => {}
        }
        Command::new("cmd")
            .args(&args)
            .current_dir(&path)
            .spawn()
            .map_err(|e| format!("couldn't open terminal: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let _ = run; // ponytail: command-on-open is Windows-only for now
        Command::new("open")
            .args(["-a", "Terminal", &path])
            .spawn()
            .map_err(|e| format!("couldn't open terminal: {e}"))?;
        Ok(())
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = run;
        Err("open_terminal is not supported on this platform yet".to_string())
    }
}

#[tauri::command]
pub fn open_in_editor(path: String) -> Result<(), String> {
    open_os(&path, OpenMode::Editor)
}

/// Open an external URL in the user's default handler (for Deck join / task
/// links). Allows http(s) plus the desktop-app deep-link schemes for Asana
/// (`asanadesktop://`), Zoom (`zoommtg://`), and Teams (`msteams:`). URLs never
/// resolve to a real path, so `open_os` can't be used.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    use std::process::Command;
    let u = url.trim();
    const ALLOWED: [&str; 5] = [
        "https://",
        "http://",
        "asanadesktop://", // Asana desktop app
        "zoommtg://",      // Zoom desktop app
        "msteams:",        // Microsoft Teams desktop app
    ];
    if !ALLOWED.iter().any(|p| u.starts_with(p)) {
        return Err("URL scheme is not allowed".into());
    }
    if u.chars().any(char::is_control) {
        return Err("URL contains control characters".into());
    }
    // Each launcher is invoked directly (no shell), so query-string `&` etc. in
    // the URL are passed as a single safe argument.
    #[cfg(target_os = "windows")]
    {
        // explorer.exe mangles URLs with query strings (the `&` params make it
        // open a file window instead of the browser). FileProtocolHandler hands
        // the URL to its default handler reliably, custom schemes included.
        Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(u)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(u).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(u).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

// --- Bookmarks (Brave) -----------------------------------------------------
// Read-only view over Brave's own Bookmarks JSON — Brave stays the source of
// truth, so there's no CRUD here; edit bookmarks in Brave itself.

#[derive(serde::Serialize)]
pub struct BookmarkNode {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<BookmarkNode>>,
}

#[derive(serde::Serialize)]
pub struct BookmarkProfile {
    pub profile: String,
    pub roots: Vec<BookmarkNode>,
}

fn bookmark_node(v: &serde_json::Value) -> Option<BookmarkNode> {
    let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
    match v.get("type")?.as_str()? {
        "url" => Some(BookmarkNode {
            name,
            url: Some(v.get("url")?.as_str()?.to_string()),
            children: None,
        }),
        "folder" => Some(BookmarkNode {
            name,
            url: None,
            children: Some(
                v.get("children")?.as_array()?.iter().filter_map(bookmark_node).collect(),
            ),
        }),
        _ => None,
    }
}

fn brave_user_data() -> Result<std::path::PathBuf, String> {
    Ok(dirs::data_local_dir()
        .ok_or("no local data dir")?
        .join("BraveSoftware")
        .join("Brave-Browser")
        .join("User Data"))
}

/// All Brave bookmarks across every profile, parsed from disk on each call
/// (the files are small; no caching, no watching).
#[tauri::command]
pub fn list_bookmarks() -> Result<Vec<BookmarkProfile>, String> {
    let user_data = brave_user_data()?;
    // Human profile names ("Personal", "Work") live in Local State's cache.
    let names: serde_json::Value = std::fs::read_to_string(user_data.join("Local State"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    let mut found: Vec<(String, String, Vec<BookmarkNode>)> = Vec::new();
    let entries = std::fs::read_dir(&user_data)
        .map_err(|e| format!("Brave profiles not found at {}: {e}", user_data.display()))?;
    for entry in entries.flatten() {
        let file = entry.path().join("Bookmarks");
        let Ok(txt) = std::fs::read_to_string(&file) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else { continue };
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let profile = names
            .pointer(&format!("/profile/info_cache/{dir_name}/name"))
            .and_then(|n| n.as_str())
            .unwrap_or(&dir_name)
            .to_string();
        let mut roots = Vec::new();
        for (key, label) in [
            ("bookmark_bar", "Bookmarks bar"),
            ("other", "Other bookmarks"),
            ("synced", "Mobile bookmarks"),
        ] {
            if let Some(mut node) = v.pointer(&format!("/roots/{key}")).and_then(bookmark_node) {
                if node.children.as_ref().is_some_and(|c| !c.is_empty()) {
                    node.name = label.to_string();
                    roots.push(node);
                }
            }
        }
        if !roots.is_empty() {
            found.push((profile, dir_name, roots));
        }
    }
    // Brave's display names can collide ("Profile 2" twice) — disambiguate
    // duplicates with the profile directory.
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (name, _, _) in &found {
        *counts.entry(name.clone()).or_insert(0) += 1;
    }
    let mut out: Vec<BookmarkProfile> = found
        .into_iter()
        .map(|(name, dir, roots)| BookmarkProfile {
            profile: if counts[&name] > 1 { format!("{name} ({dir})") } else { name },
            roots,
        })
        .collect();
    out.sort_by(|a, b| a.profile.to_lowercase().cmp(&b.profile.to_lowercase()));
    Ok(out)
}

/// Open a web URL specifically in Brave (not the default browser).
#[tauri::command]
pub fn open_in_brave(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("URL scheme is not allowed".into());
    }
    if u.chars().any(char::is_control) {
        return Err("URL contains control characters".into());
    }
    #[cfg(target_os = "windows")]
    {
        // Direct spawn, no shell — the URL rides as one argument.
        std::process::Command::new(brave_exe()?)
            .arg(u)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        // ponytail: non-Windows falls back to the default browser.
        open_url(url)
    }
}

#[cfg(target_os = "windows")]
fn brave_exe() -> Result<std::path::PathBuf, String> {
    let candidates = [
        std::path::PathBuf::from(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"),
        std::path::PathBuf::from(r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe"),
        dirs::data_local_dir()
            .unwrap_or_default()
            .join(r"BraveSoftware\Brave-Browser\Application\brave.exe"),
    ];
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| "brave.exe not found — is Brave installed?".into())
}

/// Native folder picker for bookmarking a file-explorer folder. None = cancelled.
#[tauri::command]
pub async fn pick_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(rfd::FileDialog::new()
            .set_title("Bookmark a folder")
            .pick_folder()
            .map(|p| p.display().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

// Brave hangs in headless mode (tested — never exits), so thumbnails render
// with headless Edge, which ships with Windows. Links still OPEN in Brave.
#[cfg(target_os = "windows")]
fn headless_browser_exe() -> Result<std::path::PathBuf, String> {
    let candidates = [
        std::path::PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        std::path::PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    ];
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| "msedge.exe not found (needed to render page snapshots)".into())
}

// Snapshots run one at a time — parallel headless browsers would fight over
// the same --user-data-dir profile lock. ponytail: global lock; per-URL
// profiles if grid loads ever feel slow.
static SNAPSHOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Cache file for a url's snapshot. Always .png-named; the frontend sniffs
/// the actual format from the bytes (user-picked images may be jpg/webp).
fn thumb_path(url: &str) -> Result<std::path::PathBuf, String> {
    let dir = app_state_dir()?.join("bookmark-thumbs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let hash: String = {
        use sha2::Digest;
        sha2::Sha256::digest(url.as_bytes()).iter().take(12).map(|b| format!("{b:02x}")).collect()
    };
    Ok(dir.join(format!("{hash}.png")))
}

/// Pick an image file and use it as the cached snapshot for `url` — the
/// manual override for pages headless rendering can't capture (logins,
/// cookie walls): interact with the page yourself, screenshot it, pick the
/// file. Returns false when the dialog is cancelled.
#[tauri::command]
pub async fn pick_snapshot_image(url: String) -> Result<bool, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose an image for this bookmark")
            .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
            .pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(src) = picked else { return Ok(false) };
    let bytes = fs::read(&src).map_err(|e| e.to_string())?;
    if bytes.len() > 8_000_000 {
        return Err("Image is too large (8 MB max)".into());
    }
    fs::write(thumb_path(url.trim())?, &bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Screenshot of a webpage via headless Edge, cached on disk under the app
/// state dir. Returns base64 image bytes. `generate: false` = cached-only
/// (the web server has a small worker pool; a ~15s headless render must
/// never pin a request worker).
pub fn snapshot_url_impl(url: &str, refresh: bool, generate: bool) -> Result<String, String> {
    let u = url.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("URL scheme is not allowed".into());
    }
    if u.chars().any(char::is_control) {
        return Err("URL contains control characters".into());
    }
    let file = thumb_path(u)?;
    if refresh && generate {
        let _ = fs::remove_file(&file);
    }
    if !file.is_file() {
        if !generate {
            return Err("No cached snapshot — open the desktop app to generate it".into());
        }
        #[cfg(not(target_os = "windows"))]
        return Err("Snapshots are Windows-only for now".into());
        #[cfg(target_os = "windows")]
        {
            let _guard = SNAPSHOT_LOCK.lock().map_err(|_| "snapshot lock poisoned")?;
            if !file.is_file() {
                // A dedicated profile dir: headless can't share a running
                // browser's (locked) profile.
                let profile = file.with_file_name(".headless-profile");
                let mut child = std::process::Command::new(headless_browser_exe()?)
                    .arg("--headless=new")
                    .arg("--disable-gpu")
                    .arg("--no-first-run")
                    .arg(format!("--user-data-dir={}", profile.display()))
                    .arg("--window-size=800,500")
                    .arg("--hide-scrollbars")
                    .arg(format!("--screenshot={}", file.display()))
                    .arg("--virtual-time-budget=8000")
                    .arg("--timeout=15000")
                    .arg(u)
                    .spawn()
                    .map_err(|e| format!("couldn't run edge: {e}"))?;
                // Hard 30s cap — a hung renderer must not wedge the command.
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                loop {
                    match child.try_wait().map_err(|e| e.to_string())? {
                        Some(_) => break,
                        None if std::time::Instant::now() > deadline => {
                            let _ = child.kill();
                            return Err("Snapshot timed out".into());
                        }
                        None => std::thread::sleep(std::time::Duration::from_millis(200)),
                    }
                }
                if !file.is_file() {
                    return Err("Snapshot failed — the page didn't render".into());
                }
            }
        }
    }
    Ok(base64_encode(&fs::read(&file).map_err(|e| e.to_string())?))
}

#[tauri::command]
pub fn snapshot_url(url: String, refresh: Option<bool>) -> Result<String, String> {
    snapshot_url_impl(&url, refresh.unwrap_or(false), true)
}

/// Reveal a session's transcript file in the OS file manager.
#[tauri::command]
pub fn reveal_session(project_id: String, session_id: String) -> Result<(), String> {
    let (_pd, file, _sidecar) = resolve_session(&project_id, &session_id)?;
    if !file.is_file() {
        return Err("Session file not found".into());
    }
    open_os(&file.to_string_lossy(), OpenMode::Reveal)
}

enum OpenMode {
    Folder,
    Reveal,
    Editor,
}

fn open_os(path: &str, mode: OpenMode) -> Result<(), String> {
    use std::process::Command;

    // Security: `path` can originate from data on disk (a session's recorded
    // `cwd`, or a `project` value in history.jsonl), not just the UI. Before
    // handing it to any OS launcher we require it to canonicalize to an existing
    // file/dir — this rejects crafted command-injection strings, which never
    // resolve to a real path — and we forbid control characters.
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Empty path".into());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("Path contains control characters".into());
    }
    let canonical = Path::new(trimmed)
        .canonicalize()
        .map_err(|_| "Path does not exist".to_string())?;
    if !(canonical.is_dir() || canonical.is_file()) {
        return Err("Path does not exist".into());
    }
    // Launch with the caller's normal path (not the \\?\ verbatim canonical form,
    // which Explorer and some editors reject).
    let path = trimmed;

    let spawn = |mut c: Command| -> Result<(), String> {
        c.spawn().map(|_| ()).map_err(|e| e.to_string())
    };

    #[cfg(target_os = "windows")]
    {
        match mode {
            OpenMode::Folder => {
                // explorer.exe is invoked directly (no shell), so the path arg is
                // safe even with metacharacters in a legitimate folder name.
                let mut c = Command::new("explorer");
                c.arg(path);
                let _ = c.spawn(); // explorer often returns non-zero even on success
                Ok(())
            }
            OpenMode::Reveal => {
                let mut c = Command::new("explorer");
                c.arg(format!("/select,{path}"));
                let _ = c.spawn();
                Ok(())
            }
            OpenMode::Editor => {
                // The VS Code launcher is `code.cmd`, which requires cmd.exe, and
                // cmd re-parses its command line. The existence check above blocks
                // injection strings; additionally refuse shell metacharacters so a
                // (rare) real folder whose name contains them can't inject either.
                if path.contains(['&', '|', '<', '>', '^', '"', '%', '`']) {
                    return Err("Path contains characters unsafe to pass to the shell".into());
                }
                let mut c = Command::new("cmd");
                c.args(["/C", "code", path]);
                spawn(c)
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        match mode {
            OpenMode::Folder => {
                let mut c = Command::new("open");
                c.arg(path);
                spawn(c)
            }
            OpenMode::Reveal => {
                let mut c = Command::new("open");
                c.args(["-R", path]);
                spawn(c)
            }
            OpenMode::Editor => {
                let mut c = Command::new("code");
                c.arg(path);
                spawn(c)
            }
        }
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        match mode {
            OpenMode::Folder | OpenMode::Reveal => {
                let mut c = Command::new("xdg-open");
                c.arg(path);
                spawn(c)
            }
            OpenMode::Editor => {
                let mut c = Command::new("code");
                c.arg(path);
                spawn(c)
            }
        }
    }
}

pub(crate) fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok((c - b'A') as u32),
            b'a'..=b'z' => Ok((c - b'a' + 26) as u32),
            b'0'..=b'9' => Ok((c - b'0' + 52) as u32),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("invalid base64".to_string()),
        }
    }
    let bytes: Vec<u8> = s
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
        .collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        if chunk.len() < 2 {
            return Err("invalid base64".to_string());
        }
        let mut n = 0u32;
        for i in 0..4 {
            n = (n << 6) | if i < chunk.len() { val(chunk[i])? } else { 0 };
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

pub(crate) fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Proxy a request that returns binary data (e.g. ElevenLabs TTS audio),
/// returning the body base64-encoded. Same allowlist as `http_proxy`.
pub fn http_proxy_bytes(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
) -> Result<BinResponse, String> {
    if !proxy_allowed(&url) {
        return Err("This URL isn't allowed (use https://, or http:// only on localhost).".into());
    }
    let mut req = ureq::request(&method, &url);
    for (k, v) in &headers {
        req = req.set(k, &crate::secrets::resolve_secrets(v));
    }
    let body = crate::secrets::resolve_secrets(&body);
    let resp = if body.is_empty() {
        req.call()
    } else {
        req.send_string(&body)
    };
    let (status, reader) = match resp {
        Ok(r) => (r.status(), r.into_reader()),
        Err(ureq::Error::Status(code, r)) => (code, r.into_reader()),
        Err(e) => return Err(e.to_string()),
    };
    let mut buf = Vec::new();
    reader
        .take(20 * 1024 * 1024)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(BinResponse {
        status,
        body_base64: base64_encode(&buf),
    })
}

#[tauri::command]
pub async fn tts_proxy(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
) -> Result<BinResponse, String> {
    tauri::async_runtime::spawn_blocking(move || http_proxy_bytes(url, method, headers, body))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// App info / settings
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ha_states_map_filter_and_order() {
        let v: serde_json::Value = serde_json::json!([
            { "entity_id": "light.office",
              "state": "on",
              "attributes": { "friendly_name": "Office Light" } },
            { "entity_id": "sensor.temp",
              "state": "21.5",
              "attributes": { "friendly_name": "Temp", "unit_of_measurement": "°C" } },
            { "entity_id": "switch.fan", "state": "off", "attributes": {} }
        ]);
        // empty filter = everything, mapped
        let all = ha_entities_from_states(&v, &[]);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].name, "Office Light");
        assert_eq!(all[0].domain, "light");
        assert_eq!(all[1].unit, "°C");
        assert_eq!(all[2].name, "switch.fan"); // friendly_name fallback = id
        // filter keeps request order and drops unknowns
        let picked = ha_entities_from_states(
            &v,
            &["sensor.temp".into(), "light.office".into(), "light.gone".into()],
        );
        assert_eq!(
            picked.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["sensor.temp", "light.office"]
        );
    }

    #[test]
    fn ha_service_names_are_validated() {
        assert!(ha_call_service_impl("http://x", "t", "light;rm", "toggle", "light.a").is_err());
        assert!(ha_call_service_impl("http://x", "t", "light", "turn on", "light.a").is_err());
        // valid names pass validation and fail later on the unreachable host
        let e = ha_call_service_impl("http://127.0.0.1:1", "t", "homeassistant", "toggle", "light.a")
            .unwrap_err();
        assert!(e.contains("unreachable"), "{e}");
    }

    /// Live probe against the real Home Assistant once the token exists:
    /// `CM_HA_URL=http://... CM_HA_TOKEN=... cargo test -- --ignored --nocapture real_ha_states`
    #[test]
    #[ignore = "hits the real Home Assistant instance"]
    fn real_ha_states() {
        let url = std::env::var("CM_HA_URL").expect("set CM_HA_URL");
        let token = std::env::var("CM_HA_TOKEN").expect("set CM_HA_TOKEN");
        let all = ha_states_impl(&url, &token, &[]).expect("states failed");
        assert!(!all.is_empty());
        println!("{} entities; first: {} = {}", all.len(), all[0].id, all[0].state);
    }

    #[test]
    fn script_names_are_confined() {
        assert!(valid_script_name("endWork.bat"));
        assert!(valid_script_name("start work 2.ps1"));
        assert!(!valid_script_name(""));
        assert!(!valid_script_name("..\\evil.bat"));
        assert!(!valid_script_name("../evil.bat"));
        assert!(!valid_script_name("C:\\evil.bat"));
        assert!(!valid_script_name("sub/dir.bat"));
    }

    #[test]
    fn remote_urls_normalize() {
        assert_eq!(
            remote_to_web_url("git@github.com:user/repo.git").as_deref(),
            Some("https://github.com/user/repo")
        );
        assert_eq!(
            remote_to_web_url("ssh://git@github.com/user/repo.git").as_deref(),
            Some("https://github.com/user/repo")
        );
        assert_eq!(
            remote_to_web_url("https://github.com/user/repo.git").as_deref(),
            Some("https://github.com/user/repo")
        );
        assert_eq!(remote_to_web_url("/some/local/path"), None);
    }

    #[test]
    fn stream_line_rendering() {
        // non-JSON passes through
        assert_eq!(render_stream_line("plain text").unwrap(), "plain text\n");
        // only the init system event prints
        assert!(render_stream_line(r#"{"type":"system","subtype":"hook_started"}"#).is_none());
        assert!(render_stream_line(r#"{"type":"system","subtype":"init","model":"m1"}"#)
            .unwrap()
            .contains("m1"));
        // assistant text and tool_use render; empty thinking blocks don't
        let a = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}"#;
        let r = render_stream_line(a).unwrap();
        assert!(r.contains("hi") && r.contains("▸ Bash ls -la"));
        assert!(render_stream_line(
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""}]}}"#
        )
        .is_none());
        // success result is silent, error result shows
        assert!(render_stream_line(r#"{"type":"result","subtype":"success","result":"ok"}"#).is_none());
        assert!(render_stream_line(r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"boom"}"#)
            .unwrap()
            .contains("boom"));
    }

    #[test]
    fn base64_round_trip() {
        for data in [&b""[..], &b"a"[..], &b"ab"[..], &b"abc"[..], &[0u8, 255, 128, 7, 42][..]] {
            assert_eq!(base64_decode(&base64_encode(data)).unwrap(), data);
        }
        assert!(base64_decode("not base64!!").is_err());
    }

    #[test]
    fn schedule_push_validates_before_ssh() {
        // Both reject before any ssh spawn — safe to run offline.
        assert!(push_schedule_site_impl("not json", "", "").unwrap_err().contains("bad schedule JSON"));
        assert!(push_schedule_site_impl("{\"day\":\"TUE\"}", "", "")
            .unwrap_err()
            .contains("top-level array"));
    }

    #[test]
    fn publishing_targets_reject_shell_injection_and_missing_configuration() {
        for host in ["", "-oProxyCommand=bad", "user@-host", "a@b@c", "user name", "a\nb", "host;id", "$(id)"] {
            assert!(validate_publish_target(host, "/srv/site/index.html").is_err(), "accepted host {host:?}");
        }
        for path in ["", "/", "relative.json", "/a/", "/a//b", "/a/../b", "/a/./b", "/a b", "/a;id", "/$(id)", "/a\nb"] {
            assert!(validate_publish_target("publish", path).is_err(), "accepted path {path:?}");
        }
        for host in ["publish", "192.0.2.1", "user@server.example.com", "user_name@host-alias"] {
            assert!(validate_publish_target(host, "/srv/site-1/index.html").is_ok());
        }
        assert!(validate_publish_target("publish", "/schedule.json").is_ok());
        assert!(ssh_pipe_to_file("", "/index.html", b"private").is_err());
        assert!(push_schedule_site_impl("[]", "publish", "/bad;id").is_err());
    }

    #[test]
    fn vault_guards() {
        let dir = std::env::temp_dir().join("cm-vault-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::create_dir_all(dir.join(".obsidian")).unwrap();
        fs::write(dir.join("a.md"), "# a").unwrap();
        fs::write(dir.join("sub").join("b.md"), "# b").unwrap();
        fs::write(dir.join("c.txt"), "no").unwrap();
        fs::write(dir.join(".obsidian").join("hidden.md"), "no").unwrap();

        let base = dir.canonicalize().unwrap();
        let mut out = Vec::new();
        walk_vault(&base, &base, &mut out);
        let mut names: Vec<&str> = out.iter().map(|d| d.name.as_str()).collect();
        names.sort();
        // .md only, recursive, dot-dirs skipped
        assert_eq!(names, vec!["a.md", &format!("sub{}b.md", std::path::MAIN_SEPARATOR)[..]]);

        // read must refuse paths outside the vault and non-markdown inside it
        let outside = std::env::temp_dir().join("cm-vault-outside.md");
        fs::write(&outside, "secret").unwrap();
        let d = dir.to_str().unwrap();
        assert_eq!(read_vault(d, dir.join("a.md").to_str().unwrap()).unwrap(), "# a");
        assert!(read_vault(d, outside.to_str().unwrap()).is_err());
        assert!(read_vault(d, dir.join("c.txt").to_str().unwrap()).is_err());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&outside);
    }

    /// Live probe: actually launches the configured CLI through the job
    /// engine. Catches what no unit test can -- a bin that resolves in a shell
    /// but not from a bare Rust spawn (npm installs claude as a .cmd shim, so
    /// `Command::new("claude")` finds nothing).
    /// `cargo test --lib -- --ignored --nocapture real_job_launch`
    #[test]
    #[ignore]
    fn real_job_launch() {
        let id = start_job(
            "probe".into(),
            "probe".into(),
            "Reply with the single word PONG and nothing else.".into(),
            "claude".into(),
            vec![],
            Some(std::env::temp_dir().display().to_string()),
        )
        .expect("start_job");
        let mut job = read_job(&id).expect("job exists");
        for _ in 0..120 {
            if job.status != "running" {
                break;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
            job = read_job(&id).expect("job exists");
        }
        eprintln!("status={} exit={:?}\n{}", job.status, job.exit_code, job.output);
        assert_eq!(job.status, "done", "job did not succeed: {}", job.output);
        assert!(job.output.to_uppercase().contains("PONG"), "no reply in output");
    }

    #[test]
    fn job_flags_never_carry_the_prompt() {
        // Claude must ask for -p + stream-json (the renderer parses nothing
        // else); Codex and Gemini get their own headless modes.
        assert_eq!(job_flags("claude"), ["-p", "--output-format", "stream-json", "--verbose"]);
        assert_eq!(job_flags("codex")[0], "exec");
        assert_eq!(job_flags("gemini"), ["--yolo"]);
        // The prompt travels on stdin, so no flag list may hold user text --
        // a multi-line prompt in argv is unquotable for a Windows .cmd shim.
        for bin in ["claude", "codex", "gemini", "C:\\npm\\claude.cmd"] {
            assert!(job_flags(bin).iter().all(|f| f.starts_with('-') || !f.contains(' ')));
        }
    }

    #[test]
    fn app_state_round_trip() {
        let _g = state_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        // Injected temp root — the suite must not touch the real ~/.claude.
        let tmp = std::env::temp_dir().join("cm-state-test");
        let _ = fs::remove_dir_all(&tmp);
        std::env::set_var("CIPHER_STATE_DIR", &tmp);
        assert!(write_app_state("Bad/Key", "{}").is_err());
        assert!(write_app_state("ok-key".repeat(20).as_str(), "{}").is_err());
        assert!(write_app_state("cm-test-state", "not json").is_err());
        write_app_state("cm-test-state", r#"{"a":1}"#).unwrap();
        assert_eq!(read_app_state("cm-test-state").unwrap().unwrap(), r#"{"a":1}"#);
        let _ = fs::remove_file(tmp.join("cm-test-state.json"));
        assert!(read_app_state("cm-test-state").unwrap().is_none());
        std::env::remove_var("CIPHER_STATE_DIR");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn release_safety_acting_gate() {
        let _g = state_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CIPHER_STATE_DIR", tmp.path());
        let denied = start_job("test".into(), "test".into(), "test".into(),
            "missing-release-test-cli".into(), vec![], None);
        assert!(run_user_script_impl("missing-test.ps1").unwrap_err().contains("Acting"));
        assert!(run_system_task("test").unwrap_err().contains("Acting"));
        for json in ["{}", "{\"actingMode\":false}", "{\"actingMode\":\"true\"}"] {
            write_app_state("settings", json).unwrap();
            assert!(require_acting_mode().is_err());
        }
        write_app_state("settings", "{\"actingMode\":true}").unwrap();
        assert!(require_acting_mode().is_ok());
        fs::write(tmp.path().join("settings.json"), "broken").unwrap();
        assert!(require_acting_mode().is_err());
        std::env::remove_var("CIPHER_STATE_DIR");
        assert!(denied.is_err(), "missing Acting setting must reject before spawning");
    }

    #[test]
    fn release_safety_missing_cli_is_not_accepted() {
        let _guard = state_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CIPHER_STATE_DIR", tmp.path());
        write_app_state("settings", "{\"actingMode\":true}").unwrap();
        let accepted = start_job("missing-cli-test".into(), "test".into(), "test".into(),
            "cipher-release-test-cli-that-does-not-exist".into(), vec![], Some(tmp.path().display().to_string()));
        for _ in 0..100 {
            if !has_running_jobs().unwrap() { break; }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let audit = read_audit(10);
        assert_eq!(audit.first().and_then(|a| a.launched), Some(false));
        std::env::remove_var("CIPHER_STATE_DIR");
        assert!(accepted.is_err(), "missing CLI must fail before accepting the job");
    }

    #[test]
    #[cfg(windows)]
    fn release_safety_cmd_shim_launch_is_acknowledged() {
        let _guard = state_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CIPHER_STATE_DIR", tmp.path());
        write_app_state("settings", "{\"actingMode\":true}").unwrap();
        let shim = tmp.path().join("test cli Ω.cmd");
        fs::write(&shim, "@echo off\r\necho ready\r\nexit /b 0\r\n").unwrap();
        let id = start_job("shim-test".into(), "test".into(), "test".into(),
            shim.display().to_string(), vec![], Some(tmp.path().display().to_string())).unwrap();
        for _ in 0..100 {
            if !has_running_jobs().unwrap() { break; }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(read_job(&id).unwrap().launched);
        assert_eq!(read_audit(10).first().and_then(|a| a.launched), Some(true));
        std::env::remove_var("CIPHER_STATE_DIR");
    }

    #[test]
    #[ignore = "child process helper, invoked only by the concurrent audit test"]
    fn release_safety_audit_append_child() {
        let Some(path) = std::env::var_os("CIPHER_TEST_AUDIT_PATH") else { return };
        let path = PathBuf::from(path);
        for n in 0..12 {
            let line = serde_json::json!({"pid":std::process::id(), "n":n, "output":"x".repeat(32768)}).to_string();
            append_audit_line(&path, &line).unwrap();
        }
    }

    #[test]
    fn release_safety_audit_appends_across_processes() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("audit.jsonl");
        let mut children: Vec<_> = (0..4).map(|_| {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", "commands::tests::release_safety_audit_append_child", "--ignored"])
                .env("CIPHER_TEST_AUDIT_PATH", &path).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            no_window(&mut command);
            command.spawn().unwrap()
        }).collect();
        for child in &mut children { assert!(child.wait().unwrap().success()); }
        let content = fs::read_to_string(path).unwrap();
        let records: Vec<serde_json::Value> = content.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(records.len(), 48);
        let identities: HashSet<_> = records.iter().map(|v| (v["pid"].as_u64().unwrap(), v["n"].as_u64().unwrap())).collect();
        assert_eq!(identities.len(), 48);
    }

    #[test]
    fn release_safety_atomic_state() {
        let _g = state_env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("CIPHER_STATE_DIR", tmp.path().join("new-account/state"));
        write_app_state("settings", "{\"actingMode\":false}").unwrap();
        let before = read_app_state("settings").unwrap();
        assert!(write_app_state("settings", "invalid").is_err());
        assert_eq!(read_app_state("settings").unwrap(), before);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let locked = fs::OpenOptions::new().read(true).share_mode(0)
                .open(app_state_dir().unwrap().join("settings.json")).unwrap();
            assert!(write_app_state("settings", "{\"actingMode\":true}").is_err());
            drop(locked);
            assert_eq!(read_app_state("settings").unwrap(), before);
        }
        write_app_state("settings", "{\"actingMode\":true}").unwrap();
        assert!(require_acting_mode().is_ok());
        std::env::remove_var("CIPHER_STATE_DIR");
    }

    #[test]
    fn release_safety_server_token_race() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("serve-token.txt");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
        let workers: Vec<_> = (0..16).map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || { barrier.wait(); load_or_create_serve_token(&path).unwrap() })
        }).collect();
        let tokens: Vec<_> = workers.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(tokens.iter().all(|t| t == &tokens[0]));
        assert_eq!(fs::read_to_string(path).unwrap(), tokens[0]);
    }

    #[test]
    fn release_safety_job_redaction() {
        let secret = "release-mock-secret-value";
        let id = job_new(secret, secret, Some(secret.into()));
        append_output(&id, &format!("first half: {}", &secret[..10]));
        append_output(&id, &secret[10..]);
        let shown = read_job(&id).unwrap();
        assert!(!serde_json::to_string(&shown).unwrap().contains(secret));
        assert!(!serde_json::to_string(&read_jobs()).unwrap().contains(secret));
        assert!(jobs().lock().unwrap().get(&id).unwrap().output.contains(secret), "redaction works on clones");
        let mut audit = serde_json::json!({"prompt":secret,"bin":secret,"args":[secret],"cwd":secret,"label":secret,"outputExcerpt":secret});
        crate::secrets::Redactor::load().value(&mut audit);
        assert!(!audit.to_string().contains(secret));
        jobs().lock().unwrap().remove(&id);
    }

    #[test]
    fn release_safety_task_config_and_flags() {
        assert_eq!(job_flags(r"C:\Program Files\codex.cmd")[0], "exec");
        assert_eq!(job_flags(r"C:\Program Files\gemini.cmd"), ["--yolo"]);
        assert!(valid_task_slug("morning-brief"));
        assert!(!valid_task_slug("../escape"));
        assert!(!valid_task_slug("task & calc"));
        let task = SystemTask { prompt: "hello\n& echo this is prompt text".into(),
            bin: "codex".into(), extra: vec!["--model".into(), "example".into()], cwd: None };
        let roundtrip: SystemTask = serde_json::from_str(&serde_json::to_string(&task).unwrap()).unwrap();
        assert_eq!(roundtrip.prompt, task.prompt);
        assert!(validate_job_command(&task.bin, &task.extra).is_ok());
        #[cfg(windows)]
        for arg in ["x & calc", "%COMSPEC%", "x\ncalc", "x|calc", "x>file"] {
            assert!(validate_job_command("codex", &[arg.into()]).is_err());
        }
    }

    #[test]
    fn release_safety_legacy_task_migration() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("old-task.cmd");
        fs::write(&script, "echo unchecked-launch").unwrap();
        assert!(migrate_legacy_tasks_in(tmp.path(), |_| Err("mock refusal".into())).is_err());
        let stub = fs::read_to_string(&script).unwrap();
        assert!(stub.contains("exit /b 1") && !stub.contains("unchecked-launch"));
        assert_eq!(migrate_legacy_tasks_in(tmp.path(), |_| Ok(())).unwrap(), ["old-task"]);
        assert!(migrate_legacy_tasks_in(tmp.path(), |_| panic!("must not repeat")).unwrap().is_empty());
        assert!(!script.exists());
    }

    #[test]
    fn release_safety_failed_task_update_preserves_config() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("task.json");
        fs::write(&path, b"old config").unwrap();
        assert!(save_task_config(&path, b"new config", || Err("mock scheduler failure".into())).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old config");
        let missing = tmp.path().join("new-task.json");
        assert!(save_task_config(&missing, b"new config", || Err("mock scheduler failure".into())).is_err());
        assert!(!missing.exists());
        save_task_config(&path, b"new config", || Ok(())).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new config");
    }

    #[test]
    fn release_safety_finished_worker_blocks_shutdown_until_audit() {
        let worker = JobWorker::new();
        // No running metadata is needed: a finished worker may still write its audit.
        assert!(has_running_jobs().unwrap());
        drop(worker);
    }

    #[test]
    fn release_safety_vault_link_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("vault");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let link = base.join("linked");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd").args(["/c", "mklink", "/J"])
            .arg(&link).arg(&outside).output().unwrap().status.success());
        let result = write_vault(base.to_str().unwrap(), "linked/new/note.md", "private");
        #[cfg(windows)]
        fs::remove_dir(&link).unwrap();
        assert!(result.is_err());
        assert!(!outside.join("new").exists(), "must reject before creating outside directories");
        let target_link = base.join("note.md");
        let outside_note = outside.join("note.md");
        fs::write(&outside_note, "original").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_note, &target_link).unwrap();
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd").args(["/c", "mklink", "/J"])
            .arg(&target_link).arg(&outside).output().unwrap().status.success());
        let result = write_vault(base.to_str().unwrap(), "note.md", "changed");
        #[cfg(windows)]
        fs::remove_dir(&target_link).unwrap();
        assert!(result.unwrap_err().contains("links"));
        assert_eq!(fs::read_to_string(outside_note).unwrap(), "original");
    }

    #[test]
    fn write_vault_guards() {
        let dir = std::env::temp_dir().join("cm-vault-write-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let d = dir.to_str().unwrap();

        // Plain relative .md paths write (creating parents)…
        write_vault(d, "output/briefs/b.md", "hi").unwrap();
        assert_eq!(fs::read_to_string(dir.join("output/briefs/b.md")).unwrap(), "hi");
        // …but escapes, absolute paths, and non-markdown are refused.
        assert!(write_vault(d, "../escape.md", "no").is_err());
        assert!(write_vault(d, "a/../../escape.md", "no").is_err());
        assert!(write_vault(d, "C:\\Windows\\pwn.md", "no").is_err());
        assert!(write_vault(d, "note.txt", "no").is_err());
        assert!(write_vault(d, "", "no").is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_skill_guards() {
        // Must refuse to write anywhere outside ~/.claude/skills.
        let outside = std::env::temp_dir().join("cm-skill-outside.md");
        fs::write(&outside, "x").unwrap();
        assert!(write_skill_file(outside.to_str().unwrap(), "pwn").is_err());
        let _ = fs::remove_file(&outside);
        // And refuse files that don't exist yet (editing only).
        let missing = std::env::temp_dir().join("cm-skill-missing.md");
        assert!(write_skill_file(missing.to_str().unwrap(), "x").is_err());
    }

    /// Smoke-test the scanner against the real ~/.claude on this machine.
    /// Run with: `cargo test -- --ignored --nocapture real_scan`
    #[test]
    #[ignore = "reads the real ~/.claude — run explicitly"]
    fn real_scan() {
        let (projects, usage) = scan_all();
        eprintln!("\n=== cipherManager real-data scan ===");
        eprintln!("project folders : {}", projects.len());
        eprintln!("active projects : {}", usage.project_count);
        eprintln!("sessions        : {}", usage.session_count);
        eprintln!("messages        : {}", usage.message_count);
        eprintln!("total tokens    : {}", usage.tokens.grand_total());
        eprintln!("total est. cost : ${:.2}", usage.total_cost);
        eprintln!("transcript size : {} bytes", usage.total_size_bytes);
        eprintln!("days w/ activity: {}", usage.by_day.len());
        eprintln!("range           : {:?} .. {:?}", usage.first_activity, usage.last_activity);

        eprintln!("\nby model:");
        for m in &usage.by_model {
            eprintln!("  {:<28} ${:>9.2}  ({} msgs)", m.model, m.cost_usd, m.message_count);
        }

        eprintln!("\ntop projects by est. cost:");
        for p in usage.by_project.iter().take(6) {
            eprintln!("  {:<26} ${:>9.2}", p.name, p.cost_usd);
        }

        if let Some(p) = projects.iter().find(|p| p.session_count > 0) {
            let sessions = sessions_for_project(&p.id);
            eprintln!("\nsessions for '{}': {}", p.name, sessions.len());
            if let Some(s) = sessions.first() {
                eprintln!(
                    "  first: title={:?} msgs={} cost=${:.2} subagents={}",
                    s.title, s.message_count, s.cost_usd, s.has_subagents
                );
            }
        }

        let hits = run_search("plan", 10);
        eprintln!("\nsearch 'plan' -> {} hits (cap 10)", hits.len());

        assert!(!projects.is_empty(), "expected at least one project dir");
    }
}

// ---------------------------------------------------------------------------
// Live rolling-window usage (last 5h / 24h)
// ---------------------------------------------------------------------------

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// UTC timestamp `hours` ago as an ISO prefix (`YYYY-MM-DDTHH:MM:SS`).
/// ISO-8601 UTC strings compare correctly lexicographically.
fn utc_iso_minus_hours(hours: u64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let secs = now.saturating_sub(hours * 3600);
    let (y, m, d) = civil_from_days((secs / 86400) as i64);
    let rem = secs % 86400;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

pub fn recent_usage() -> RecentUsage {
    let mut out = RecentUsage::default();
    let Some(base) = claude::projects_dir() else {
        return out;
    };
    let now = SystemTime::now();
    let file_cutoff = now.checked_sub(Duration::from_secs(24 * 3600)).unwrap_or(now);
    let c5 = utc_iso_minus_hours(5);
    let c24 = utc_iso_minus_hours(24);

    for id in claude::list_project_ids() {
        let pd = base.join(&id);
        let mut files = Vec::new();
        claude::jsonl_files_recursive(&pd, &mut files);
        for f in &files {
            // Fast path: skip files not modified in the last 24h.
            if let Ok(md) = fs::metadata(f) {
                if let Ok(mt) = md.modified() {
                    if mt < file_cutoff {
                        continue;
                    }
                }
            }
            parse::for_each_event(f, |v| {
                if v.get("type").and_then(Value::as_str) != Some("assistant") {
                    return;
                }
                let Some(ts) = v.get("timestamp").and_then(Value::as_str) else {
                    return;
                };
                if ts < c24.as_str() {
                    return;
                }
                let Some(usage) = v.pointer("/message/usage") else {
                    return;
                };
                let t = parse::extract_usage(usage);
                out.h24.tokens.add(&t);
                out.h24.message_count += 1;
                if ts >= c5.as_str() {
                    out.h5.tokens.add(&t);
                    out.h5.message_count += 1;
                }
            });
        }
    }
    out
}

#[tauri::command]
pub async fn get_recent_usage() -> Result<RecentUsage, String> {
    tauri::async_runtime::spawn_blocking(recent_usage)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Documents (plans + project memory) & recent sessions
// ---------------------------------------------------------------------------

fn utc_iso_from_secs(secs: u64) -> String {
    let (y, m, d) = civil_from_days((secs / 86400) as i64);
    let rem = secs % 86400;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn mtime_iso(md: &fs::Metadata) -> Option<String> {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| utc_iso_from_secs(d.as_secs()))
}

fn list_md(dir: &Path, kind: &str) -> Vec<DocFile> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("md") {
                let md = e.metadata().ok();
                out.push(DocFile {
                    name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    path: p.display().to_string(),
                    size_bytes: md.as_ref().map(|m| m.len()).unwrap_or(0),
                    modified: md.as_ref().and_then(mtime_iso),
                    kind: kind.to_string(),
                });
            }
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

fn resolve_name(id: &str, pd: &Path, hist: &HashMap<String, String>) -> String {
    let real = claude::top_level_sessions(pd)
        .iter()
        .find_map(|f| claude::first_cwd_in_file(f))
        .or_else(|| hist.get(id).cloned())
        .unwrap_or_else(|| id.to_string());
    claude::display_name(&real)
}

pub fn list_documents() -> Documents {
    let mut docs = Documents::default();
    let Some(root) = claude::claude_root() else {
        return docs;
    };
    docs.plans = list_md(&root.join("plans"), "plan");

    let Some(base) = claude::projects_dir() else {
        return docs;
    };
    let hist = claude::history_path_map();
    for id in claude::list_project_ids() {
        let pd = base.join(&id);
        let mem = pd.join("memory");
        if !mem.is_dir() {
            continue;
        }
        let files = list_md(&mem, "memory");
        if files.is_empty() {
            continue;
        }
        docs.memory.push(DocGroup {
            title: resolve_name(&id, &pd, &hist),
            docs: files,
        });
    }
    docs.memory.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    docs
}

pub fn read_document(path: &str) -> Result<String, String> {
    let root = claude::claude_root().ok_or("No ~/.claude directory")?;
    let canon_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canon = Path::new(path)
        .canonicalize()
        .map_err(|_| "File not found".to_string())?;
    if !canon.starts_with(&canon_root) {
        return Err("Path is outside ~/.claude".into());
    }
    let ext = canon.extension().and_then(|s| s.to_str()).unwrap_or("");
    if !matches!(ext, "md" | "txt" | "json" | "jsonl") {
        return Err("Unsupported file type".into());
    }
    let content = fs::read_to_string(&canon).map_err(|e| e.to_string())?;
    if content.chars().count() > 200_000 {
        Ok(content.chars().take(200_000).collect::<String>() + "\n\n…[truncated]")
    } else {
        Ok(content)
    }
}

// ---------------------------------------------------------------------------
// Vault browser — read-only view over a markdown vault folder (any location;
// the path comes from frontend settings, so reads are guarded to stay inside).
// ---------------------------------------------------------------------------

const VAULT_MAX_FILES: usize = 2000;

pub(crate) fn walk_vault(dir: &Path, base: &Path, out: &mut Vec<DocFile>) {
    if out.len() >= VAULT_MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // .obsidian, .git, …
        }
        let p = e.path();
        if p.is_dir() {
            walk_vault(&p, base, out);
        } else if p.extension().and_then(|s| s.to_str()) == Some("md") {
            let md = e.metadata().ok();
            out.push(DocFile {
                name: p
                    .strip_prefix(base)
                    .map(|r| r.display().to_string())
                    .unwrap_or(name),
                path: p.display().to_string(),
                size_bytes: md.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: md.as_ref().and_then(mtime_iso),
                kind: "vault".to_string(),
            });
        }
        if out.len() >= VAULT_MAX_FILES {
            return;
        }
    }
}

pub fn list_vault_impl(dir: &str) -> Result<Vec<DocFile>, String> {
    let base = Path::new(dir)
        .canonicalize()
        .map_err(|_| format!("vault folder not found: {dir}"))?;
    let mut out = Vec::new();
    walk_vault(&base, &base, &mut out);
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[tauri::command]
pub async fn list_vault(dir: String) -> Result<Vec<DocFile>, String> {
    tauri::async_runtime::spawn_blocking(move || list_vault_impl(&dir))
        .await
        .map_err(|e| e.to_string())?
}

pub fn read_vault(dir: &str, path: &str) -> Result<String, String> {
    let base = Path::new(dir)
        .canonicalize()
        .map_err(|_| "vault folder not found".to_string())?;
    let canon = Path::new(path)
        .canonicalize()
        .map_err(|_| "file not found".to_string())?;
    if !canon.starts_with(&base) {
        return Err("path is outside the vault".to_string());
    }
    if canon.extension().and_then(|s| s.to_str()) != Some("md") {
        return Err("unsupported file type".to_string());
    }
    let content = fs::read_to_string(&canon).map_err(|e| e.to_string())?;
    Ok(if content.chars().count() > 200_000 {
        content.chars().take(200_000).collect::<String>() + "\n\n…[truncated]"
    } else {
        content
    })
}

#[tauri::command]
pub async fn read_vault_file(dir: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_vault(&dir, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// Write a markdown file at `rel` (relative path) under the vault. Creates
/// parent folders. `rel` must be plain descending components — no `..`, no
/// absolute paths or links/reparse points within the configured vault.
pub fn write_vault(dir: &str, rel: &str, content: &str) -> Result<(), String> {
    let base = Path::new(dir)
        .canonicalize()
        .map_err(|_| "vault folder not found".to_string())?;
    let rel_path = Path::new(rel);
    let plain = rel_path
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)));
    if !plain || rel.trim().is_empty() {
        return Err("path must be a plain relative path inside the vault".to_string());
    }
    if rel_path.extension().and_then(|s| s.to_str()) != Some("md") {
        return Err("unsupported file type".to_string());
    }
    let target = base.join(rel_path);
    let mut checked = base.clone();
    for part in rel_path.components() {
        checked.push(part);
        match fs::symlink_metadata(&checked) {
            Ok(meta) => {
                #[cfg(windows)]
                let linked = {
                    use std::os::windows::fs::MetadataExt;
                    meta.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
                };
                #[cfg(not(windows))]
                let linked = meta.file_type().is_symlink();
                if linked || !checked.canonicalize().map_err(|e| e.to_string())?.starts_with(&base) {
                    return Err("vault paths must not contain links or reparse points".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if checked != target { fs::create_dir(&checked).map_err(|e| e.to_string())?; }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    if !target.parent().ok_or("missing parent")?.canonicalize().map_err(|e| e.to_string())?.starts_with(&base) {
        return Err("path outside vault".into());
    }
    atomic_write(&target, content.as_bytes())
}

#[tauri::command]
pub async fn write_vault_file(dir: String, rel: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_vault(&dir, &rel, &content))
        .await
        .map_err(|e| e.to_string())?
}

pub fn recent_sessions(limit: usize) -> Vec<RecentSession> {
    let Some(base) = claude::projects_dir() else {
        return Vec::new();
    };
    let hist = claude::history_path_map();
    let mut all = Vec::new();

    for id in claude::list_project_ids() {
        let pd = base.join(&id);
        let sessions = claude::top_level_sessions(&pd);
        if sessions.is_empty() {
            continue;
        }
        let name = resolve_name(&id, &pd, &hist);
        for sf in &sessions {
            let Some(stem) = sf.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let scan = parse::scan_session(sf);
            all.push(RecentSession {
                project_id: id.clone(),
                project_name: name.clone(),
                session_id: stem.to_string(),
                title: scan.title,
                first_prompt: scan.first_prompt,
                start_time: scan.first_ts,
                end_time: scan.last_ts,
                message_count: scan.message_count,
                models: scan.models.into_iter().collect(),
            });
        }
    }
    all.sort_by(|a, b| b.end_time.cmp(&a.end_time));
    all.truncate(limit);
    all
}

#[tauri::command]
pub async fn get_documents() -> Result<Documents, String> {
    tauri::async_runtime::spawn_blocking(list_documents)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_document_cmd(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_document(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_recent_sessions(limit: Option<usize>) -> Result<Vec<RecentSession>, String> {
    let n = limit.unwrap_or(8);
    tauri::async_runtime::spawn_blocking(move || recent_sessions(n))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Skills registry — the on-disk skills the agentic OS can run.
// ---------------------------------------------------------------------------

/// Pull `name`, `description`, and optional `domain`/`model` out of a SKILL.md's
/// leading YAML frontmatter block (best-effort, no YAML dependency).
fn parse_skill_front(content: &str) -> (String, String, Option<String>, Option<String>) {
    let mut name = String::new();
    let mut description = String::new();
    let mut domain = None;
    let mut model = None;

    let trimmed = content.trim_start_matches(['\u{feff}', ' ', '\n', '\r']);
    let Some(rest) = trimmed.strip_prefix("---") else {
        return (name, description, domain, model);
    };
    let Some(end) = rest.find("\n---") else {
        return (name, description, domain, model);
    };
    for line in rest[..end].lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let val = v.trim().trim_matches(['"', '\'']).to_string();
        match k.trim().to_lowercase().as_str() {
            "name" => name = val,
            "description" => description = val,
            "domain" if !val.is_empty() => domain = Some(val),
            "model" if !val.is_empty() => model = Some(val),
            _ => {}
        }
    }
    (name, description, domain, model)
}

pub fn list_skills() -> Vec<Skill> {
    let Some(root) = claude::claude_root() else {
        return Vec::new();
    };
    let dir = root.join("skills");
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let Some(id) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // Claude Code uses SKILL.md; accept lowercase too.
        let mut sf = p.join("SKILL.md");
        if !sf.is_file() {
            sf = p.join("skill.md");
        }
        if !sf.is_file() {
            continue;
        }
        let content = fs::read_to_string(&sf).unwrap_or_default();
        let (name, description, domain, model) = parse_skill_front(&content);
        let md = sf.metadata().ok();
        out.push(Skill {
            id: id.to_string(),
            name: if name.is_empty() { id.to_string() } else { name },
            description,
            domain,
            model,
            path: sf.display().to_string(),
            size_bytes: md.as_ref().map(|m| m.len()).unwrap_or(0),
            modified: md.as_ref().and_then(mtime_iso),
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[tauri::command]
pub async fn get_skills() -> Result<Vec<Skill>, String> {
    tauri::async_runtime::spawn_blocking(list_skills)
        .await
        .map_err(|e| e.to_string())
}

/// Overwrite an existing skill markdown file. Confined to `~/.claude/skills`
/// (canonicalized, so symlinks/`..` can't escape); editing only, no creation.
pub fn write_skill_file(path: &str, content: &str) -> Result<(), String> {
    let root = claude::claude_root().ok_or("No ~/.claude directory")?;
    let skills = root
        .join("skills")
        .canonicalize()
        .map_err(|_| "No skills directory".to_string())?;
    let canon = Path::new(path)
        .canonicalize()
        .map_err(|_| "File not found".to_string())?;
    if !canon.starts_with(&skills) {
        return Err("Path is outside ~/.claude/skills".into());
    }
    if !canon
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
    {
        return Err("Only markdown files can be edited".into());
    }
    fs::write(&canon, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_skill(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_skill_file(&path, &content))
        .await
        .map_err(|e| e.to_string())?
}

/// Persist the app's deck snapshot to a fixed path (`~/.claude/cipher-deck/today.md`)
/// so headless skill runs (morning-brief) can read today's calendar + tasks.
pub fn save_deck_snapshot_file(content: &str) -> Result<(), String> {
    let root = claude::claude_root().ok_or("No ~/.claude directory")?;
    let dir = root.join("cipher-deck");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("today.md"), content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_deck_snapshot(content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_deck_snapshot_file(&content))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Execution engine — run a skill/prompt via headless `claude -p`.
//
// Jobs run in a background thread; their streamed output accumulates in a
// process-global store that the frontend polls. This works uniformly for the
// desktop app (Tauri invoke) and the local web server (its own process).
// ---------------------------------------------------------------------------

use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

/// Cap a single job's captured output so a runaway process can't exhaust memory.
const MAX_JOB_OUTPUT: usize = 512 * 1024; // 512 KiB
/// How much output to persist per run in the on-disk audit log.
const AUDIT_EXCERPT: usize = 4000;

static JOBS: OnceLock<Mutex<HashMap<String, Job>>> = OnceLock::new();
static ACTIVE_JOB_WORKERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

struct JobWorker;
impl JobWorker {
    fn new() -> Self { ACTIVE_JOB_WORKERS.fetch_add(1, Ordering::SeqCst); Self }
}
impl Drop for JobWorker {
    fn drop(&mut self) { ACTIVE_JOB_WORKERS.fetch_sub(1, Ordering::SeqCst); }
}
/// Seeded from wall-clock seconds: job ids must stay unique across app
/// restarts because sizzle job folders persist on disk — a reused "job-1"
/// silently inherits a previous run's downloaded source video.
static JOB_SEQ: OnceLock<AtomicU64> = OnceLock::new();

fn next_job_id() -> String {
    let seq = JOB_SEQ.get_or_init(|| {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(1);
        AtomicU64::new(secs)
    });
    format!("job-{}", seq.fetch_add(1, Ordering::SeqCst))
}
/// Live child processes, keyed by job id, so a run can be canceled.
static CHILDREN: OnceLock<Mutex<HashMap<String, Arc<Mutex<Child>>>>> = OnceLock::new();
/// Job ids the user asked to cancel (so the runner records "canceled").
static CANCELED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn jobs() -> &'static Mutex<HashMap<String, Job>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn children() -> &'static Mutex<HashMap<String, Arc<Mutex<Child>>>> {
    CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn canceled() -> &'static Mutex<HashSet<String>> {
    CANCELED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    utc_iso_from_secs(secs)
}

/// Split an extra-args string into tokens, honoring simple double quotes.
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for c in s.chars() {
        match c {
            '"' => in_quote = !in_quote,
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Resolve the working directory: a valid provided dir, else the ~/.claude root.
fn resolve_cwd(cwd: Option<String>) -> Result<Option<String>, String> {
    if let Some(d) = cwd.filter(|s| !s.trim().is_empty()) {
        if Path::new(&d).is_dir() {
            return Ok(Some(d));
        }
        return Err(format!("Working directory does not exist: {d}"));
    }
    Ok(claude::claude_root().map(|p| p.display().to_string()))
}

fn append_output(id: &str, text: &str) {
    if let Ok(mut g) = jobs().lock() {
        if let Some(j) = g.get_mut(id) {
            if j.output.len() >= MAX_JOB_OUTPUT {
                return;
            }
            j.output.push_str(text);
            if j.output.len() >= MAX_JOB_OUTPUT {
                j.output.push_str("\n…[output truncated]\n");
            }
        }
    }
}

fn finish_job(id: &str, status: &str, code: Option<i32>, extra: &str) {
    let redactor = crate::secrets::Redactor::load();
    if let Ok(mut g) = jobs().lock() {
        if let Some(j) = g.get_mut(id) {
            if !extra.is_empty() {
                j.output.push_str(extra);
                j.output.push('\n');
            }
            // Scrub any stored secret that echoed into the run output before
            // it's persisted to the audit log or shown.
            j.output = redactor.text(&j.output);
            j.status = status.to_string();
            j.exit_code = code;
            j.finished_at = Some(now_iso());
        }
    }
}

// --- Job engine reused by other modules (e.g. sizzle) for staged background
// work. These wrap the private job maps so a sibling module can create a job,
// log stage progress, and finish it without touching the raw statics. ---

/// Create a "running" job and return its id (shows in the Jobs panel + get_job).
pub(crate) fn job_new(skill: &str, label: &str, cwd: Option<String>) -> String {
    let id = next_job_id();
    let job = Job {
        id: id.clone(),
        skill: skill.into(),
        label: label.into(),
        status: "running".into(),
        output: String::new(),
        exit_code: None,
        launched: false,
        cwd,
        started_at: now_iso(),
        finished_at: None,
    };
    jobs().lock().unwrap().insert(id.clone(), job);
    id
}

/// Append one progress line to a job's output.
pub(crate) fn job_log(id: &str, line: &str) {
    append_output(id, &format!("{line}\n"));
}

/// Mark a job done/failed with a closing message.
pub(crate) fn job_done(id: &str, ok: bool, extra: &str) {
    finish_job(id, if ok { "done" } else { "failed" }, None, extra);
}

/// Turn a `--output-format stream-json` event line into a compact, readable
/// progress line for the Jobs panel. `claude -p` in plain-text mode prints
/// nothing until the very end (minutes of silence on real skills), so jobs
/// run in stream-json mode and are rendered as they happen. Non-JSON lines
/// pass through unchanged.
fn render_stream_line(line: &str) -> Option<String> {
    use serde_json::Value;
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Some(format!("{line}\n"));
    };
    match v.get("type").and_then(Value::as_str) {
        Some("system") => {
            if v.get("subtype").and_then(Value::as_str) != Some("init") {
                return None; // hook chatter etc.
            }
            let model = v.get("model").and_then(Value::as_str).unwrap_or("claude");
            Some(format!("· session started ({model})\n"))
        }
        Some("assistant") => {
            let mut out = String::new();
            if let Some(items) = v["message"]["content"].as_array() {
                for c in items {
                    match c.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let t = c.get("text").and_then(Value::as_str).unwrap_or("");
                            if !t.trim().is_empty() {
                                out.push_str(t);
                                out.push('\n');
                            }
                        }
                        Some("tool_use") => {
                            let name = c.get("name").and_then(Value::as_str).unwrap_or("tool");
                            let hint = c["input"]["command"]
                                .as_str()
                                .or_else(|| c["input"]["file_path"].as_str())
                                .or_else(|| c["input"]["pattern"].as_str())
                                .unwrap_or("");
                            let hint: String = hint.chars().take(80).collect();
                            out.push_str(&format!("▸ {name} {hint}\n"));
                        }
                        _ => {}
                    }
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        Some("result") => {
            let is_err = v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
                || v.get("subtype").and_then(Value::as_str) != Some("success");
            if is_err {
                let msg = v
                    .get("result")
                    .and_then(Value::as_str)
                    .or_else(|| v.get("error").and_then(Value::as_str))
                    .unwrap_or("unknown error");
                Some(format!("\n✗ {msg}\n"))
            } else {
                None // final text already streamed via assistant events
            }
        }
        _ => None, // tool results / user events are noise for this panel
    }
}

/// A job's runtime is Claude unless the bin is the Codex or Gemini CLI.
fn is_codex(bin: &str) -> bool {
    let b = bin.to_lowercase();
    b.rsplit(['/', '\\']).next().unwrap_or(&b).trim_end_matches(".exe").trim_end_matches(".cmd") == "codex"
}

fn is_gemini(bin: &str) -> bool {
    let b = bin.to_lowercase();
    b.rsplit(['/', '\\']).next().unwrap_or(&b).trim_end_matches(".exe").trim_end_matches(".cmd") == "gemini"
}

/// Flags for a headless run. Every CLI takes its prompt on stdin, so nothing
/// here ever carries user text into argv.
fn job_flags(bin: &str) -> &'static [&'static str] {
    if is_codex(bin) {
        // workspace-write so it can act like `claude -p`; git guard skipped
        // because jobs often run in scratch dirs.
        &["exec", "--sandbox", "workspace-write", "--skip-git-repo-check"]
    } else if is_gemini(bin) {
        // --yolo is its only approval mode that never prompts (a headless run
        // has no one to answer).
        &["--yolo"]
    } else {
        // Stream events as they happen (--verbose is required alongside -p).
        &["-p", "--output-format", "stream-json", "--verbose"]
    }
}

fn validate_job_command(bin: &str, extra: &[String]) -> Result<(), String> {
    if bin.trim().is_empty() { return Err("CLI executable is empty".into()); }
    #[cfg(windows)]
    if std::iter::once(bin).chain(extra.iter().map(String::as_str))
        .any(|s| s.contains(['&', '|', '<', '>', '^', '%', '!', '"', '\r', '\n'])) {
        return Err("CLI executable and arguments cannot contain Windows shell control characters.".into());
    }
    #[cfg(not(windows))]
    let _ = extra;
    Ok(())
}

fn spawn_job_child(bin: &str, extra: &[String], cwd: Option<&str>) -> Result<Child, String> {
    use std::process::{Command, Stdio};
    require_acting_mode()?;
    // Resolve npm shims explicitly: spawning cmd.exe alone reports success
    // even when the requested CLI is missing. Native paths preserve Unicode.
    #[cfg(windows)]
    let mut cmd = {
        let current = cwd.map(PathBuf::from).unwrap_or(std::env::current_dir().map_err(|e| e.to_string())?);
        let mut dirs = vec![current];
        dirs.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
        if let Some(appdata) = dirs::data_dir() { dirs.push(appdata.join("npm")); }
        if let Some(home) = dirs::home_dir() { dirs.push(home.join(".local/bin")); }
        let path = dirs.iter().flat_map(|dir| {
            ["", ".exe", ".cmd", ".bat", ".com"].into_iter().map(move |suffix| dir.join(format!("{bin}{suffix}")))
        }).find(|path| path.is_file()).ok_or_else(|| format!("CLI not found: {bin}. Install it or configure its executable path."))?;
        validate_job_command(&path.to_string_lossy(), extra)?;
        let mut c = Command::new(path);
        c.env("PATH", std::env::join_paths(&dirs).map_err(|e| e.to_string())?);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new(bin);
    cmd.args(job_flags(bin)).args(extra);
    cmd.stdin(Stdio::piped());
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    cmd.spawn().map_err(|e| format!("Failed to launch '{bin}': {e}"))
}

fn run_child(id: String, prompt: String, bin: String, extra: Vec<String>, cwd: Option<String>, launched: Option<std::sync::mpsc::Sender<Result<(), String>>>) {
    let _worker = JobWorker::new();
    let plain = is_codex(&bin) || is_gemini(&bin);

    let mut child = match spawn_job_child(&bin, &extra, cwd.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            finish_job(
                &id,
                "failed",
                None,
                &e,
            );
            write_audit(&id, &prompt, &bin, &extra);
            if let Some(sender) = launched { let _ = sender.send(Err(crate::secrets::redact(&e))); }
            return;
        }
    };
    if let Some(job) = jobs().lock().unwrap().get_mut(&id) { job.launched = true; }
    if let Some(sender) = launched { let _ = sender.send(Ok(())); }

    // Feed the prompt on stdin, then close it (EOF) so the run starts.
    if let Some(mut si) = child.stdin.take() {
        use std::io::Write;
        let _ = si.write_all(prompt.as_bytes());
        // dropped here → EOF
    }

    // Take the pipes out before sharing the Child, so reading never holds the
    // lock that cancel() needs to kill the process.
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let shared = Arc::new(Mutex::new(child));
    children().lock().unwrap().insert(id.clone(), shared.clone());

    // Drain stderr on its own thread so it interleaves with stdout.
    let err_id = id.clone();
    let err_thread = std::thread::spawn(move || {
        if let Some(se) = stderr {
            let reader = std::io::BufReader::new(se);
            for line in reader.lines().map_while(Result::ok) {
                append_output(&err_id, &format!("{line}\n"));
            }
        }
    });

    if let Some(so) = stdout {
        let reader = std::io::BufReader::new(so);
        for line in reader.lines().map_while(Result::ok) {
            // Codex/Gemini print plain text; Claude emits stream-json to render.
            if plain {
                append_output(&id, &format!("{line}\n"));
            } else if let Some(rendered) = render_stream_line(&line) {
                append_output(&id, &rendered);
            }
        }
    }
    let _ = err_thread.join();

    // Killing closes the pipes (EOF above); by now the process has exited.
    let waited = shared.lock().unwrap().wait();
    children().lock().unwrap().remove(&id);

    let was_canceled = canceled().lock().map(|mut c| c.remove(&id)).unwrap_or(false);
    if was_canceled {
        finish_job(&id, "canceled", None, "\n[canceled]");
    } else {
        match waited {
            Ok(s) => finish_job(
                &id,
                if s.success() { "done" } else { "failed" },
                s.code(),
                "",
            ),
            Err(e) => finish_job(&id, "failed", None, &format!("wait error: {e}")),
        }
    }
    write_audit(&id, &prompt, &bin, &extra);
}

/// Request cancellation of a running job. Returns Ok only if a live process was
/// actually signaled.
pub fn cancel_job(id: &str) -> Result<(), String> {
    let handle = children().lock().ok().and_then(|g| g.get(id).cloned());
    let Some(child) = handle else {
        return Err("Job is not running".into());
    };
    canceled().lock().unwrap().insert(id.to_string());
    let kill_result = {
        let mut guard = child.lock().unwrap();
        // Kill the tree: on Windows the direct child is cmd.exe and the real
        // CLI is a grandchild still holding the pipes, so killing only cmd.exe
        // would leave the reader loop blocked on a stdout that never EOFs.
        #[cfg(windows)]
        let r = {
            let mut c = std::process::Command::new("taskkill");
            c.args(["/T", "/F", "/PID", &guard.id().to_string()]);
            no_window(&mut c);
            match c.status() {
                Ok(st) if st.success() => Ok(()),
                _ => guard.kill(),
            }
        };
        #[cfg(not(windows))]
        let r = guard.kill();
        r
    };
    match kill_result {
        Ok(()) => Ok(()),
        Err(e) => {
            canceled().lock().unwrap().remove(id);
            Err(format!("Couldn't stop the process: {e}"))
        }
    }
}

/// Start a headless run; accept its id only once the CLI successfully spawns.
pub fn start_job(
    skill: String,
    label: String,
    prompt: String,
    bin: String,
    extra: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    require_acting_mode()?;
    if prompt.trim().is_empty() {
        return Err("Prompt is empty".into());
    }
    validate_job_command(&bin, &extra)?;
    let cwd = resolve_cwd(cwd)?;
    let id = next_job_id();
    let job = Job {
        id: id.clone(),
        skill,
        label,
        status: "running".into(),
        output: String::new(),
        exit_code: None,
        launched: false,
        cwd: cwd.clone(),
        started_at: now_iso(),
        finished_at: None,
    };
    jobs().lock().unwrap().insert(id.clone(), job);

    let jid = id.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || run_child(jid, prompt, bin, extra, cwd, Some(sender)));
    receiver.recv().map_err(|_| "Job launcher stopped before acknowledging startup")??;
    Ok(id)
}

pub fn read_job(id: &str) -> Option<Job> {
    let mut job = jobs().lock().ok()?.get(id).cloned()?;
    redact_job(&mut job, &crate::secrets::Redactor::load());
    Some(job)
}

fn redact_job(job: &mut Job, redactor: &crate::secrets::Redactor) {
    for s in [&mut job.id, &mut job.skill, &mut job.label, &mut job.status,
        &mut job.output, &mut job.started_at] { *s = redactor.text(s); }
    for s in [&mut job.cwd, &mut job.finished_at].into_iter().flatten() { *s = redactor.text(s); }
}

pub fn has_running_jobs() -> Result<bool, String> {
    let running = jobs().lock().map_err(|_| "job lock poisoned")?.values().any(|j| j.status == "running");
    Ok(running || ACTIVE_JOB_WORKERS.load(Ordering::SeqCst) != 0)
}

pub fn read_jobs() -> Vec<Job> {
    let mut v: Vec<Job> = jobs()
        .lock()
        .map(|g| g.values().cloned().collect())
        .unwrap_or_default();
    v.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    v.truncate(50);
    let redactor = crate::secrets::Redactor::load();
    for job in &mut v { redact_job(job, &redactor); }
    v
}

#[tauri::command]
pub async fn run_skill(
    skill: String,
    label: String,
    prompt: String,
    bin: Option<String>,
    args: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let bin = bin
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "claude".into());
    let extra = split_args(&args.unwrap_or_default());
    start_job(skill, label, prompt, bin, extra, cwd)
}

#[tauri::command]
pub async fn get_job(id: String) -> Option<Job> {
    read_job(&id)
}

#[tauri::command]
pub async fn list_jobs() -> Vec<Job> {
    read_jobs()
}

#[tauri::command]
pub async fn stop_job(id: String) -> Result<(), String> {
    cancel_job(&id)
}

// ---------------------------------------------------------------------------
// Audit log — every run is appended to ~/.claude/cipher-jobs/audit.jsonl so
// there's a durable record of what ran, where, when, and its result.
// ---------------------------------------------------------------------------

fn audit_dir() -> Option<PathBuf> {
    if std::env::var("CIPHER_STATE_DIR").is_ok() {
        app_state_dir().ok().map(|dir| dir.join("jobs"))
    } else {
        dirs::home_dir().map(|dir| dir.join(".claude/cipher-jobs"))
    }
}

pub fn audit_path() -> Option<String> {
    audit_dir().map(|d| d.join("audit.jsonl").display().to_string())
}

/// Append a finished job to the audit log (best-effort; never panics).
fn write_audit(id: &str, prompt: &str, bin: &str, extra: &[String]) {
    let Some(job) = read_job(id) else { return };
    let Some(dir) = audit_dir() else { return };
    let _ = fs::create_dir_all(&dir);

    let excerpt: String = job.output.chars().take(AUDIT_EXCERPT).collect();
    let mut record = serde_json::json!({
        "id": job.id,
        "skill": job.skill,
        "label": job.label,
        "status": job.status,
        "exitCode": job.exit_code,
        "launched": job.launched,
        "cwd": job.cwd,
        "prompt": prompt,
        "bin": bin,
        "args": extra.join(" "),
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
        "outputExcerpt": excerpt,
    });

    crate::secrets::Redactor::load().value(&mut record);

    if let Ok(line) = serde_json::to_string(&record) {
        let _ = append_audit_line(&dir.join("audit.jsonl"), &line);
    }
}

fn append_audit_line(path: &Path, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new().create(true).read(true).append(true).open(path)?;
    // OS lock spans all scheduled-task/server processes; drop unlocks on errors.
    file.lock()?;
    writeln!(file, "{line}")?;
    file.sync_data()
}

/// Read the most recent audit entries (newest first).
pub fn read_audit(limit: usize) -> Vec<AuditEntry> {
    let Some(path) = audit_dir().map(|d| d.join("audit.jsonl")) else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let redactor = crate::secrets::Redactor::load();
    let mut out: Vec<AuditEntry> = content
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(limit)
        .filter_map(|l| {
            let mut value = serde_json::from_str::<serde_json::Value>(l).ok()?;
            redactor.value(&mut value);
            serde_json::from_value(value).ok()
        })
        .collect();
    out.truncate(limit);
    out
}

#[tauri::command]
pub async fn get_audit(limit: Option<usize>) -> Vec<AuditEntry> {
    let n = limit.unwrap_or(100);
    tauri::async_runtime::spawn_blocking(move || read_audit(n))
        .await
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Deck — calendar + tasks (CipherDeck, folded in)
// ---------------------------------------------------------------------------

pub fn deck_data(cfg: crate::deck::DeckConfig) -> crate::deck::model::Dashboard {
    if cfg.is_empty() {
        crate::deck::sample_dashboard()
    } else {
        crate::deck::fetch(&cfg)
    }
}

#[tauri::command]
pub async fn get_deck(
    ics_urls: Option<Vec<String>>,
    asana_token: Option<String>,
    asana_project: Option<String>,
    asana_workspace: Option<String>,
) -> Result<crate::deck::model::Dashboard, String> {
    let cfg = crate::deck::DeckConfig {
        ics_urls: ics_urls.unwrap_or_default(),
        asana_token: crate::secrets::resolve_secrets(&asana_token.unwrap_or_default()),
        asana_project: asana_project.unwrap_or_default(),
        asana_workspace: asana_workspace.unwrap_or_default(),
    };
    tauri::async_runtime::spawn_blocking(move || deck_data(cfg))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_task_detail(
    token: String,
    gid: String,
) -> Result<crate::deck::model::TaskDetail, String> {
    tauri::async_runtime::spawn_blocking(move || crate::deck::task_detail(&crate::secrets::resolve_secrets(&token), &gid))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_task_comments(
    token: String,
    ids: Vec<String>,
) -> Result<Vec<crate::deck::model::TaskComments>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::deck::task_comments(&crate::secrets::resolve_secrets(&token), &ids, 2))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// AI provider proxy (server-side HTTP to dodge browser CORS)
// ---------------------------------------------------------------------------

/// Only allow proxying to HTTPS hosts, or HTTP on localhost / private-LAN /
/// Tailscale addresses (local model servers like Ollama, including one on
/// another machine on the home network). Still blocks arbitrary public HTTP.
pub fn proxy_allowed(url: &str) -> bool {
    if let Some(rest) = url.strip_prefix("https://") {
        return !rest.is_empty();
    }
    if let Some(rest) = url.strip_prefix("http://") {
        let host = rest.split(['/', ':']).next().unwrap_or("");
        if host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]" {
            return true;
        }
        // RFC1918 private ranges + Tailscale's CGNAT range (100.64.0.0/10).
        return host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| {
            let o = ip.octets();
            ip.is_private() || (o[0] == 100 && (64..128).contains(&o[1]))
        });
    }
    false
}

pub fn http_proxy(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
) -> Result<ProxyResponse, String> {
    if !proxy_allowed(&url) {
        return Err("This URL isn't allowed (use https://, or http:// only on localhost).".into());
    }

    let mut req = ureq::request(&method, &url);
    for (k, v) in &headers {
        req = req.set(k, &crate::secrets::resolve_secrets(v));
    }
    let body = crate::secrets::resolve_secrets(&body);

    let resp = if body.is_empty() {
        req.call()
    } else {
        req.send_string(&body)
    };

    match resp {
        Ok(r) => {
            let status = r.status();
            let body = r.into_string().map_err(|e| e.to_string())?;
            Ok(ProxyResponse { status, body })
        }
        // Non-2xx: still return the body so the frontend can parse the error.
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            Ok(ProxyResponse { status: code, body })
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn ai_proxy(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: String,
) -> Result<ProxyResponse, String> {
    tauri::async_runtime::spawn_blocking(move || http_proxy(url, method, headers, body))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// OAuth (Authorization Code flow via a one-shot localhost redirect listener).
// Used for Twitch (follower/sub counts) and Google/YouTube Analytics — both
// need a user token, which the app-level client-credentials flow can't give.
// Desktop-app only: the phone/web path can't open a loopback listener.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}

fn oauth_urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn oauth_percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let hex = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                (Some(a), Some(b)) => {
                    out.push(a * 16 + b);
                    i += 3;
                }
                _ => {
                    out.push(b'%');
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn oauth_parse_query(q: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            m.insert(oauth_percent_decode(k), oauth_percent_decode(v));
        }
    }
    m
}

fn oauth_html(msg: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let body = format!(
        "<!doctype html><meta charset=utf-8><body style=\"font-family:system-ui;background:#0b0f1a;\
         color:#cdd8ee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">\
         <div style=\"text-align:center\"><h2 style=\"color:#39d5ef;letter-spacing:2px\">cipherManager</h2>\
         <p>{msg}</p></div>"
    );
    let header =
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap();
    tiny_http::Response::from_string(body).with_header(header)
}

/// Proton Mail for the Packages page, read through Bridge's local IMAP server.
/// Classification stays in the frontend (see `src/lib/packages.ts`) — the hints
/// are only a coarse prefilter so 90 days of mail isn't downloaded wholesale.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn proton_fetch_mail(
    host: String,
    port: u16,
    user: String,
    password: String,
    mailboxes: Vec<String>,
    days_back: i64,
    subject_hints: Vec<String>,
    from_hints: Vec<String>,
    limit: usize,
) -> Result<Vec<crate::proton::MailMessage>, String> {
    let password = crate::secrets::resolve_secrets(&password);
    tauri::async_runtime::spawn_blocking(move || {
        crate::proton::fetch(
            &host,
            port,
            &user,
            &password,
            &mailboxes,
            days_back,
            &subject_hints,
            &from_hints,
            limit,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run the interactive OAuth Authorization Code flow. Binds a one-shot listener
/// on `http://localhost:{port}`, opens the browser to `auth_url`, waits (up to
/// 5 min) for the redirect, then exchanges the code for tokens at `token_url`.
/// `extra_auth` carries provider-specific query params (e.g. Google's
/// `access_type=offline`, `prompt=consent`).
#[tauri::command]
pub async fn oauth_login(
    auth_url: String,
    token_url: String,
    client_id: String,
    client_secret: String,
    scope: String,
    port: u16,
    extra_auth: HashMap<String, String>,
) -> Result<OAuthTokens, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client_secret = crate::secrets::resolve_secrets(&client_secret);
        let redirect_uri = format!("http://localhost:{port}");
        let server = tiny_http::Server::http(("127.0.0.1", port))
            .map_err(|e| format!("Can't bind port {port}: {e}. Close whatever is using it and retry."))?;

        let state = format!(
            "s{}",
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        );

        let mut url = format!(
            "{auth_url}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}",
            oauth_urlencode(&client_id),
            oauth_urlencode(&redirect_uri),
            oauth_urlencode(&scope),
            oauth_urlencode(&state),
        );
        for (k, v) in &extra_auth {
            url.push('&');
            url.push_str(&oauth_urlencode(k));
            url.push('=');
            url.push_str(&oauth_urlencode(v));
        }
        open_url(url)?;

        let deadline = Instant::now() + Duration::from_secs(300);
        let (code, got_state) = loop {
            if Instant::now() > deadline {
                return Err("Timed out waiting for you to authorize in the browser.".to_string());
            }
            match server.recv_timeout(Duration::from_secs(2)) {
                Ok(Some(req)) => {
                    let u = req.url().to_string();
                    let params = u.split_once('?').map(|(_, q)| oauth_parse_query(q));
                    match params {
                        Some(p) if p.contains_key("error") => {
                            let _ = req.respond(oauth_html("Authorization was denied. You can close this tab."));
                            return Err(format!(
                                "Authorization denied: {}",
                                p.get("error_description").or_else(|| p.get("error")).cloned().unwrap_or_default()
                            ));
                        }
                        Some(p) if p.contains_key("code") => {
                            let _ = req.respond(oauth_html(
                                "Connected. You can close this tab and return to cipherManager.",
                            ));
                            break (p.get("code").cloned().unwrap_or_default(), p.get("state").cloned().unwrap_or_default());
                        }
                        _ => {
                            // favicon or a bare hit — keep waiting.
                            let _ = req.respond(oauth_html("Waiting for authorization…"));
                        }
                    }
                }
                Ok(None) => continue,
                Err(e) => return Err(e.to_string()),
            }
        };

        if got_state != state {
            return Err("State mismatch — authorization aborted for safety.".to_string());
        }

        let resp = ureq::post(&token_url).send_form(&[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect_uri),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
        ]);
        let body = match resp {
            Ok(r) => r.into_string().map_err(|e| e.to_string())?,
            Err(ureq::Error::Status(c, r)) => {
                return Err(format!("Token exchange failed ({c}): {}", r.into_string().unwrap_or_default()));
            }
            Err(e) => return Err(e.to_string()),
        };
        let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let access = v.get("access_token").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        if access.is_empty() {
            return Err(format!("No access token in response: {body}"));
        }
        Ok(OAuthTokens {
            access_token: access,
            refresh_token: v.get("refresh_token").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            expires_in: v.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(3600),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Hand-built multipart/form-data POST (ureq has none). Shared by stt_proxy
/// and the meeting recorder's chunked transcription. Returns (status, body).
pub fn multipart_post(
    url: &str,
    headers: &HashMap<String, String>,
    fields: &HashMap<String, String>,
    file_field: &str, // "file" for OpenAI/ElevenLabs, "audio_file" for WhisperX /asr
    filename: &str,
    mime: &str,
    file_bytes: &[u8],
    timeout_secs: u64,
) -> Result<(u16, String), String> {
    let boundary = "----cipherManagerSttBoundary7f2c91";
    let mut body: Vec<u8> = Vec::new();
    for (k, v) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
                .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(file_bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let mut req = ureq::post(url)
        .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
        .timeout(std::time::Duration::from_secs(timeout_secs));
    for (k, v) in headers {
        req = req.set(k, &crate::secrets::resolve_secrets(v));
    }
    match req.send_bytes(&body) {
        Ok(r) => {
            let status = r.status();
            Ok((status, r.into_string().unwrap_or_default()))
        }
        Err(ureq::Error::Status(code, r)) => Ok((code, r.into_string().unwrap_or_default())),
        Err(e) => Err(e.to_string()),
    }
}

/// STT proxy — uploads recorded audio as multipart/form-data to a speech-to-
/// text API (ElevenLabs Scribe / OpenAI Whisper).
#[tauri::command]
pub async fn stt_proxy(
    url: String,
    headers: HashMap<String, String>,
    audio_base64: String,
    filename: String,
    mime: String,
    fields: HashMap<String, String>,
) -> Result<ProxyResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !proxy_allowed(&url) {
            return Err(
                "This URL isn't allowed (use https://, or http:// only on localhost).".to_string(),
            );
        }
        let audio = base64_decode(&audio_base64)?;
        let (status, body) =
            multipart_post(&url, &headers, &fields, "file", &filename, &mime, &audio, 60)?;
        Ok(ProxyResponse { status, body })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Real exit (tray Quit routes through the frontend for a final cloud-snapshot
/// push, then calls this). Window close only hides to tray and never gets here.
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    crate::screenrec::shutdown_screen_rec();
    app.exit(0);
}

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    let root = claude::claude_root();
    AppInfo {
        claude_root: root.as_ref().map(|p| p.display().to_string()),
        projects_dir: claude::projects_dir().map(|p| p.display().to_string()),
        root_exists: root.as_ref().map(|p| p.is_dir()).unwrap_or(false),
        pricing: pricing::table(),
        archive_dir: claude::archive_dir().map(|p| p.display().to_string()),
        audit_path: audit_path(),
    }
}
