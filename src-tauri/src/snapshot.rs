//! Cloud snapshot: build the shareable data export (also used by `serve
//! --export`), bake it into the embedded single-file SPA, push to the VPS.

use crate::commands;

const TEMPLATE: &str = include_str!(concat!(env!("OUT_DIR"), "/snapshot-template.html"));
/// Must match the stub text build.rs writes when dist-snapshot/index.html is absent.
const STUB_MARKER: &str = "snapshot template missing";

fn template_is_stub(t: &str) -> bool {
    t.contains(STUB_MARKER)
}

/// The JSON baked into the shareable page (and printed by `serve --export`).
pub fn export_data() -> serde_json::Value {
    let (projects, usage) = commands::scan_all();
    let mut sessions = serde_json::Map::new();
    for p in &projects {
        sessions.insert(
            p.id.clone(),
            serde_json::to_value(commands::sessions_for_project(&p.id)).unwrap_or_default(),
        );
    }
    serde_json::json!({
        "projects": projects,
        "usage": usage,
        "recaps": commands::daily_recaps(),
        "disk": commands::disk_stats(),
        "appInfo": commands::get_app_info(),
        "sessions": sessions,
        "generatedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    })
}

/// Same escaping rules as scripts/make-snapshot.mjs: every '<' and the
/// U+2028/U+2029 line separators become JS escape sequences, so the JSON can
/// never break out of the <script> element.
fn escape_for_script(json: &str) -> String {
    json.replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

pub fn bake_html(data: &serde_json::Value) -> Result<String, String> {
    let json = serde_json::to_string(data).map_err(|e| e.to_string())?;
    let inject = format!(
        "<script>window.__CIPHER_SNAPSHOT__ = {};</script>\n",
        escape_for_script(&json)
    );
    let idx = TEMPLATE
        .find("<script")
        .or_else(|| TEMPLATE.find("</head>"))
        .ok_or("no injection point in snapshot template — is dist-snapshot stale?")?;
    Ok(format!("{}{}{}", &TEMPLATE[..idx], inject, &TEMPLATE[idx..]))
}

fn push_cloud_snapshot_impl(extra: serde_json::Value, ssh_host: &str, remote_path: &str) -> Result<(), String> {
    commands::validate_publish_target(ssh_host, remote_path)?;
    if template_is_stub(TEMPLATE) {
        return Err("this build has no snapshot template - rebuild after npm run build:snapshot".into());
    }
    let mut data = export_data();
    if let (Some(base), Some(more)) = (data.as_object_mut(), extra.as_object()) {
        for (k, v) in more {
            base.insert(k.clone(), v.clone());
        }
    }
    let html = bake_html(&data)?;
    commands::ssh_pipe_to_file(ssh_host, remote_path, html.as_bytes())
}

#[tauri::command]
pub async fn push_cloud_snapshot(extra: serde_json::Value, ssh_host: String, remote_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || push_cloud_snapshot_impl(extra, &ssh_host, &remote_path))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_template_refuses_to_push() {
        // exact stub build.rs writes when dist-snapshot/index.html is absent
        let stub = "<html><head></head><body>snapshot template missing - run npm run build:snapshot before building</body></html>";
        assert!(template_is_stub(stub));
        assert!(!template_is_stub(
            "<html><head><script>var app;</script></head><body>real snapshot</body></html>"
        ));
    }

    #[test]
    fn baked_html_cannot_break_out_of_script() {
        let data = serde_json::json!({
            "projects": [], "note": "</script><script>alert(1)</script>",
            "sep": "a\u{2028}b"
        });
        let html = bake_html(&data).expect("bake failed");
        assert!(html.contains("window.__CIPHER_SNAPSHOT__"));
        // the raw close tag must not survive inside the injected script
        assert!(!html.contains("</script><script>alert(1)"));
        assert!(html.contains("\\u003c/script"));
        assert!(html.contains("\\u2028"));
    }

    #[test]
    fn snapshot_requires_a_destination_before_exporting_data() {
        let error = push_cloud_snapshot_impl(serde_json::json!({}), "", "").unwrap_err();
        assert!(error.contains("SSH host"));
    }
}
