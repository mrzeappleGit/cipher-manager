//! Sample calendar + tasks, anchored to the real "today" so the demo always
//! looks current. Shown whenever no live feed is configured.

use chrono::{Duration, Local};

use super::model::{local_dt, Dashboard, Event, EventKind, Task, TaskField};

fn at(h: u32, m: u32, day_off: i64) -> chrono::DateTime<Local> {
    let date = Local::now().date_naive() + Duration::days(day_off);
    local_dt(date.and_hms_opt(h, m, 0).expect("valid h:m"))
}

fn ev(title: &str, s: (u32, u32, i64), e: (u32, u32, i64), loc: &str, kind: &str, who: &str) -> Event {
    let kind = EventKind::from_type_str(kind);
    let url = if kind == EventKind::Video {
        Some("https://example.com/join".to_string())
    } else {
        None
    };
    Event {
        title: title.to_string(),
        start: at(s.0, s.1, s.2),
        end: at(e.0, e.1, e.2),
        location: loc.to_string(),
        kind,
        who: who.to_string(),
        url,
        description: String::new(),
    }
}

pub fn events() -> Vec<Event> {
    vec![
        ev("Team standup", (9, 0, 0), (9, 15, 0), "Zoom", "video", "6 people"),
        ev("Product review", (10, 0, 0), (11, 0, 0), "Conf Room A", "room", "You + 4"),
        ev("1:1 with Sam", (11, 30, 0), (12, 0, 0), "Google Meet", "video", "Sam Rivera"),
        ev("Lunch", (12, 30, 0), (13, 30, 0), "—", "block", "Blocked"),
        ev("Design sync", (14, 0, 0), (15, 0, 0), "Google Meet", "video", "You + 3"),
        ev("Interview: Frontend", (15, 30, 0), (16, 15, 0), "Zoom", "video", "Candidate"),
        ev("Weekly planning", (16, 30, 0), (17, 30, 0), "Conf Room C", "room", "Team"),
        ev("Roadmap workshop", (9, 30, 1), (11, 0, 1), "Conf Room A", "room", "Team"),
        ev("Vendor call", (13, 0, 1), (13, 45, 1), "Zoom", "video", "Acme Inc"),
        ev("1:1 with Priya", (15, 0, 1), (15, 30, 1), "Google Meet", "video", "Priya N"),
        ev("All-hands", (10, 0, 2), (11, 0, 2), "Main Stage", "room", "Company"),
        ev("Focus block", (13, 0, 2), (15, 0, 2), "—", "block", "Deep work"),
        ev("Sprint review", (11, 0, 3), (12, 0, 3), "Zoom", "video", "Team"),
        ev("Coffee w/ Jordan", (9, 0, 4), (9, 30, 4), "Cafe", "room", "Jordan L"),
        ev("Board prep", (14, 0, 4), (15, 30, 4), "Conf Room B", "room", "Exec"),
    ]
}

fn task(
    name: &str,
    due: (u32, u32, i64),
    proj: &str,
    assignee: &str,
    section: &str,
    priority: &str,
) -> Task {
    Task {
        id: String::new(),
        name: name.to_string(),
        due: at(due.0, due.1, due.2),
        proj: proj.to_string(),
        url: None,
        assignee: Some(assignee.to_string()),
        section: Some(section.to_string()),
        tags: Vec::new(),
        num_subtasks: 0,
        fields: if priority.is_empty() {
            Vec::new()
        } else {
            vec![TaskField { name: "Priority".into(), value: priority.into() }]
        },
    }
}

pub fn tasks() -> Vec<Task> {
    vec![
        task("Send signed vendor contract", (17, 0, -1), "Ops", "You", "In progress", "High"),
        task("Approve marketing budget", (12, 0, -2), "Finance", "You", "Blocked", "High"),
        task("Finalize Q3 roadmap", (15, 0, 0), "Product", "You", "In progress", "Medium"),
        task("Review design specs", (18, 0, 0), "Design", "You", "To do", "Medium"),
        task("Reply to customer feedback", (11, 0, 1), "Support", "You", "To do", "Low"),
        task("Prep board deck", (9, 0, 2), "Exec", "You", "To do", "High"),
        task("Write release notes", (14, 0, 3), "Product", "You", "To do", "Low"),
        task("Update analytics dashboard", (17, 0, 4), "Data", "You", "To do", ""),
    ]
}

pub fn dashboard() -> Dashboard {
    Dashboard {
        events: events(),
        tasks: tasks(),
        source: "Sample data — add your calendar feed or Asana token in Settings".to_string(),
        live: false,
        notes: Vec::new(),
    }
}
