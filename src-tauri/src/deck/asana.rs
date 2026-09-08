//! Asana REST client. Fetches incomplete tasks with due dates — including
//! overdue ones — either from a specific project, or (when no project is set)
//! the tasks assigned to the current user ("My Tasks") across a workspace.

use std::time::Duration as StdDuration;

use chrono::{DateTime, Local, NaiveDate};
use serde_json::Value;

use super::model::{
    local_dt, DeckAttachment, DeckComment, DeckSubtask, Task, TaskComments, TaskDetail, TaskField,
};

const API: &str = "https://app.asana.com/api/1.0";
const FIELDS: &str = "gid,name,due_on,due_at,start_on,start_at,completed,assignee.name,\
projects.name,memberships.section.name,tags.name,num_subtasks,permalink_url,\
custom_fields.name,custom_fields.display_value";
const MAX_PAGES: usize = 20; // safety cap: up to ~2000 tasks

/// True if `s` is a valid Asana gid (digits only) — guards path injection.
fn is_gid(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

pub fn fetch_tasks(token: &str, project: &str, workspace: &str) -> Result<Vec<Task>, String> {
    let project = project.trim();
    let url = if !project.is_empty() {
        format!("{API}/tasks?project={project}&completed_since=now&limit=100&opt_fields={FIELDS}")
    } else {
        let ws = if workspace.trim().is_empty() {
            default_workspace(token)?
        } else {
            workspace.trim().to_string()
        };
        format!("{API}/tasks?assignee=me&workspace={ws}&completed_since=now&limit=100&opt_fields={FIELDS}")
    };

    let data = get_all_data(&url, token)?;
    Ok(tasks_from(&data))
}

fn default_workspace(token: &str) -> Result<String, String> {
    let json = get_json(
        &format!("{API}/users/me?opt_fields=workspaces.name,workspaces.gid"),
        token,
    )?;
    json["data"]["workspaces"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(|w| w.get("gid"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "no workspace found for this token".to_string())
}

fn get_all_data(first_url: &str, token: &str) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut next = Some(first_url.to_string());
    let mut pages = 0;

    while let Some(url) = next {
        let json = get_json(&url, token)?;
        let page = json
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| "unexpected Asana response".to_string())?;
        out.extend(page.iter().cloned());

        next = json
            .get("next_page")
            .and_then(|np| np.get("uri"))
            .and_then(Value::as_str)
            .map(str::to_string);

        pages += 1;
        if pages >= MAX_PAGES {
            break;
        }
    }
    Ok(out)
}

fn get_json(url: &str, token: &str) -> Result<Value, String> {
    ureq::get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(StdDuration::from_secs(20))
        .call()
        .map_err(err_to_string)?
        .into_json()
        .map_err(|e| format!("bad JSON: {e}"))
}

fn tasks_from(data: &[Value]) -> Vec<Task> {
    let mut tasks = Vec::new();
    for t in data {
        if t.get("completed").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let name = t.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        let Some(due) = parse_due(t) else { continue };

        let proj = t
            .get("projects")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Asana")
            .to_string();

        let url = t.get("permalink_url").and_then(Value::as_str).map(str::to_string);
        let id = t.get("gid").and_then(Value::as_str).unwrap_or("").to_string();
        let assignee = t
            .get("assignee")
            .and_then(|a| a.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let section = t
            .get("memberships")
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find_map(|m| m.get("section").and_then(|s| s.get("name")).and_then(Value::as_str)))
            .map(str::to_string);
        let tags = t
            .get("tags")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|tag| tag.get("name").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let num_subtasks = t.get("num_subtasks").and_then(Value::as_u64).unwrap_or(0) as u32;
        let fields = t
            .get("custom_fields")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|cf| {
                        let name = cf.get("name").and_then(Value::as_str)?.to_string();
                        let value = cf.get("display_value").and_then(Value::as_str)?.trim().to_string();
                        if value.is_empty() {
                            None
                        } else {
                            Some(TaskField { name, value })
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        tasks.push(Task {
            id,
            name,
            due,
            proj,
            url,
            assignee,
            section,
            tags,
            num_subtasks,
            fields,
        });
    }

    tasks.sort_by_key(|t| t.due);
    tasks
}

/// Full detail for one task: description, comments, subtasks, attachments.
pub fn fetch_task_detail(token: &str, gid: &str) -> Result<TaskDetail, String> {
    if !is_gid(gid) {
        return Err("Invalid task id".into());
    }
    let mut detail = TaskDetail::default();

    if let Ok(t) = get_json(&format!("{API}/tasks/{gid}?opt_fields=notes"), token) {
        detail.notes = t
            .get("data")
            .and_then(|d| d.get("notes"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
    }

    detail.comments = fetch_comments_inner(token, gid, usize::MAX)?;

    if let Ok(st) = get_json(
        &format!("{API}/tasks/{gid}/subtasks?opt_fields=name,completed,due_on&limit=100"),
        token,
    ) {
        if let Some(arr) = st.get("data").and_then(Value::as_array) {
            detail.subtasks = arr
                .iter()
                .filter_map(|s| {
                    let name = s.get("name").and_then(Value::as_str)?.trim().to_string();
                    if name.is_empty() {
                        return None;
                    }
                    Some(DeckSubtask {
                        name,
                        completed: s.get("completed").and_then(Value::as_bool).unwrap_or(false),
                        due: s.get("due_on").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect();
        }
    }

    if let Ok(at) = get_json(
        &format!("{API}/tasks/{gid}/attachments?opt_fields=name,view_url&limit=100"),
        token,
    ) {
        if let Some(arr) = at.get("data").and_then(Value::as_array) {
            detail.attachments = arr
                .iter()
                .filter_map(|a| {
                    let name = a.get("name").and_then(Value::as_str)?.to_string();
                    Some(DeckAttachment {
                        name,
                        url: a.get("view_url").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect();
        }
    }

    Ok(detail)
}

fn fetch_comments_inner(token: &str, gid: &str, limit: usize) -> Result<Vec<DeckComment>, String> {
    let json = get_json(
        &format!("{API}/tasks/{gid}/stories?opt_fields=type,text,created_at,created_by.name&limit=100"),
        token,
    )?;
    let mut comments: Vec<DeckComment> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|s| s.get("type").and_then(Value::as_str) == Some("comment"))
                .filter_map(|s| {
                    let text = s.get("text").and_then(Value::as_str)?.trim().to_string();
                    if text.is_empty() {
                        return None;
                    }
                    Some(DeckComment {
                        author: s
                            .get("created_by")
                            .and_then(|u| u.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or("Someone")
                            .to_string(),
                        text,
                        created_at: s.get("created_at").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    // Stories come oldest-first; keep the most recent `limit`.
    if comments.len() > limit {
        comments = comments.split_off(comments.len() - limit);
    }
    Ok(comments)
}

/// The latest `per` comments for each of the given task gids (for the summary).
pub fn fetch_task_comments(token: &str, gids: &[String], per: usize) -> Vec<TaskComments> {
    let mut out = Vec::new();
    for gid in gids.iter().filter(|g| is_gid(g)).take(12) {
        match fetch_comments_inner(token, gid, per) {
            Ok(comments) if !comments.is_empty() => {
                out.push(TaskComments { id: gid.clone(), comments })
            }
            _ => {}
        }
    }
    out
}

fn parse_due(t: &Value) -> Option<DateTime<Local>> {
    if let Some(due_at) = t.get("due_at").and_then(Value::as_str) {
        if let Ok(dt) = DateTime::parse_from_rfc3339(due_at) {
            return Some(dt.with_timezone(&Local));
        }
    }
    if let Some(due_on) = t.get("due_on").and_then(Value::as_str) {
        if let Ok(d) = NaiveDate::parse_from_str(due_on, "%Y-%m-%d") {
            return Some(local_dt(d.and_hms_opt(17, 0, 0)?));
        }
    }
    None
}

/// Turn a ureq error into a short, readable message (shared with the ICS fetch).
pub fn err_to_string(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            let snippet: String = body.chars().take(160).collect();
            if snippet.trim().is_empty() {
                format!("HTTP {code}")
            } else {
                format!("HTTP {code}: {snippet}")
            }
        }
        ureq::Error::Transport(t) => format!("network error: {t}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tasks_from_fixture() {
        let data: Vec<Value> = serde_json::from_str(
            r#"[
              {"gid":"111","name":"Ship the report","completed":false,"due_on":"2026-07-15",
               "projects":[{"name":"COE Portfolio"}],"permalink_url":"https://app.asana.com/x/111",
               "assignee":{"name":"Alex"},"tags":[]},
              {"gid":"222","name":"Done already","completed":true,"due_on":"2026-07-10"},
              {"gid":"333","name":"","completed":false,"due_on":"2026-07-10"},
              {"gid":"444","name":"No due date","completed":false}
            ]"#,
        )
        .unwrap();
        let tasks = tasks_from(&data);
        // completed, unnamed, and undated entries are all skipped today.
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].name, "Ship the report");
        assert_eq!(tasks[0].proj, "COE Portfolio");
        assert_eq!(tasks[0].assignee.as_deref(), Some("Alex"));
    }

    #[test]
    fn gid_validation() {
        assert!(is_gid("1234567890"));
        assert!(!is_gid("12; DROP TABLE"));
        assert!(!is_gid(""));
    }
}
