//! LanguageTool grammar checking + AI rewrite over ureq. Ported from the
//! standalone cipherScribe desktop app (which used reqwest); the VPS
//! endpoints (`/v2/check`, `/rewrite`) are unchanged, so the request shape
//! here must keep matching what that app — and the still-live browser
//! extension — send.

#[cfg(test)]
mod tests {
    use super::*;

    /// LanguageTool's /v2/check shape, trimmed to what we consume.
    const SAMPLE: &str = r#"{"matches":[
      {"offset":4,"length":3,"message":"Possible spelling mistake found.",
       "replacements":[{"value":"the"},{"value":"tea"}],
       "rule":{"issueType":"misspelling","category":{"id":"TYPOS"}}},
      {"offset":20,"length":6,"message":"Consider a shorter word.",
       "replacements":[],
       "rule":{"issueType":"style","category":{"id":"STYLE"}}}
    ]}"#;

    #[test]
    fn matches_normalise_and_classify() {
        let out = normalize(SAMPLE);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].offset, 4);
        assert_eq!(out[0].replacements, vec!["the", "tea"]);
        assert!(out[0].unambiguous(), "a misspelling with a fix is auto-applicable");
        assert_eq!(out[1].kind, "style");
        assert!(!out[1].unambiguous(), "style advice is never auto-applied");
    }

    #[test]
    fn junk_never_panics() {
        assert!(normalize("not json").is_empty());
        assert!(normalize(r#"{"matches":[]}"#).is_empty());
    }

    /// `cargo test -- --ignored --nocapture real_check` (needs SCRIBE_ENDPOINT and SCRIBE_TOKEN)
    #[test]
    #[ignore = "hits the live LanguageTool VPS - run explicitly"]
    fn real_check() {
        let token = std::env::var("SCRIBE_TOKEN").unwrap_or_default();
        let endpoint = std::env::var("SCRIBE_ENDPOINT").expect("set SCRIBE_ENDPOINT explicitly");
        let out = check("This sentance has a typo.", &endpoint, &token, "en-US")
            .expect("check failed");
        eprintln!("{out:#?}");
        assert!(!out.is_empty(), "backend found no issues in an obviously wrong sentence");
    }
}

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// UTF-16 code-unit offset into the exact text sent to LT.
    pub offset: usize,
    pub length: usize,
    pub message: String,
    pub replacements: Vec<String>,
    pub kind: String,
}

impl Issue {
    /// Safe to auto-apply: objectively wrong (not style advice) with a fix.
    pub fn unambiguous(&self) -> bool {
        self.kind != "style" && !self.replacements.is_empty()
    }
}

/// Parse a /v2/check body. Anything unparsable is no issues, never an error —
/// this runs on a keystroke debounce and must not raise a toast.
///
/// `kind` classification reproduces the source cipherScribe app exactly
/// (desktop `lib.rs::lt_check`, mirrored in the browser extension's
/// `background/normalize.ts::classify`): `misspelling`/`TYPOS` -> "spelling",
/// `grammar`/`GRAMMAR` -> "grammar", everything else -> "style". `unambiguous`
/// above relies on "style" catching every non-correctness case, so this must
/// stay a closed 3-way match, not a passthrough of the raw `issueType`.
pub fn normalize(body: &str) -> Vec<Issue> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else { return vec![] };
    v["matches"]
        .as_array()
        .map(|ms| {
            ms.iter()
                .filter_map(|m| {
                    let cat = m["rule"]["category"]["id"].as_str().unwrap_or("");
                    let issue_type = m["rule"]["issueType"].as_str().unwrap_or("");
                    let kind = if issue_type == "misspelling" || cat == "TYPOS" {
                        "spelling"
                    } else if cat == "GRAMMAR" || issue_type == "grammar" {
                        "grammar"
                    } else {
                        "style"
                    };
                    Some(Issue {
                        offset: m["offset"].as_u64()? as usize,
                        length: m["length"].as_u64()? as usize,
                        message: m["message"].as_str().unwrap_or_default().to_string(),
                        replacements: m["replacements"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|r| r["value"].as_str().map(str::to_string))
                            .take(6)
                            .collect(),
                        kind: kind.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// POST text to LanguageTool's `/v2/check` and normalise the matches. Mirrors
/// the source app's `lt_check`, including the explicit `enabledOnly=false`
/// form field (LT defaults to enabled-only rules otherwise).
pub fn check(text: &str, endpoint: &str, token: &str, language: &str) -> Result<Vec<Issue>, String> {
    let url = format!("{}/v2/check", endpoint.trim_end_matches('/'));
    let mut req = ureq::post(&url);
    if !token.is_empty() {
        req = req.set("Authorization", &format!("Bearer {token}"));
    }
    let resp = req.send_form(&[("text", text), ("language", language), ("enabledOnly", "false")]);
    let body = match resp {
        Ok(r) => r.into_string().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(code, r)) => {
            return Err(format!("HTTP {code}: {}", r.into_string().unwrap_or_default()));
        }
        Err(e) => return Err(format!("LanguageTool unreachable: {e}")),
    };
    Ok(normalize(&body))
}

/// POST `{ text, style }` to the same VPS's `/rewrite` proxy and return the
/// rewritten text. `style` is forwarded verbatim — the caller (Task 5+) is
/// responsible for sending one of the old client's codes (formal / casual /
/// concise / expand / leet).
pub fn rewrite(text: &str, style: &str, endpoint: &str, token: &str) -> Result<String, String> {
    let url = format!("{}/rewrite", endpoint.trim_end_matches('/'));
    let mut req = ureq::post(&url).set("Content-Type", "application/json");
    if !token.is_empty() {
        req = req.set("Authorization", &format!("Bearer {token}"));
    }
    let payload = serde_json::json!({ "text": text, "style": style }).to_string();
    let resp = req.send_string(&payload);
    let body = match resp {
        Ok(r) => r.into_string().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(code, r)) => {
            return Err(format!("HTTP {code}: {}", r.into_string().unwrap_or_default()));
        }
        Err(e) => return Err(format!("Rewrite backend unreachable: {e}")),
    };
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    v["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Malformed rewrite response".into())
}

/// Fixed sentence for `scribe_ping`'s round trip — the same one `real_check`
/// above hits the live VPS with, deliberately mis-spelled so a healthy backend
/// finds at least one issue (an endpoint that's merely up but broken could
/// still return `200` with an empty match list).
const PING_TEXT: &str = "This sentance has a typo.";

fn ping_message(issue_count: usize) -> String {
    format!("Reached the backend — {issue_count} issue(s) found in the test sentence.")
}

/// Settings' "Test" button (Scribe card): round-trips `PING_TEXT` through
/// `/v2/check` and reports how many issues came back, or the error — the
/// fastest way to tell a bad token/endpoint apart from a working one without
/// leaving Settings. Same spawn_blocking shape as `commands::ha_conversation`,
/// since `check` blocks on ureq.
#[tauri::command]
pub async fn scribe_ping(endpoint: String, token: String, language: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = crate::secrets::resolve_secrets(&token);
        check(PING_TEXT, &endpoint, &token, &language).and_then(|issues| {
            if issues.is_empty() {
                // PING_TEXT is deliberately mis-spelled — a healthy checker always
                // flags it, so 0 issues means the backend answered but isn't
                // actually checking, not that everything's fine.
                Err("Reached the backend, but it found 0 issues in a deliberately \
                     mis-spelled test sentence — the checker may not be running."
                    .to_string())
            } else {
                Ok(ping_message(issues.len()))
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
