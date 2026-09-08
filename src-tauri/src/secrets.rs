//! Secure credential store (WP-0B). Secrets live in the OS credential vault
//! (Windows Credential Manager via `keyring`), never in localStorage, disk
//! JSON, snapshots, logs, or API responses. The frontend sends the PLACEHOLDER
//! `{{secret:<id>}}` in request headers/tokens; the backend swaps in the real
//! value inside the proxy path (resolve_secrets), so secrets never leave here.

use keyring::Entry;

const SERVICE: &str = "cipher-manager";

/// Allowlist of secret ids — bounds what can be stored/resolved and keeps a
/// typo from minting a junk vault entry. Ids mirror the settings fields.
pub const SECRET_IDS: &[&str] = &[
    "anthropic-api-key",
    "openai-api-key",
    "gemini-api-key",
    "openai-compatible-api-key",
    "eleven-api-key",
    "asana-token",
    "youtube-api-key",
    "twitch-client-secret",
    "twitch-refresh-token",
    "picovoice-key",
    "ha-token",
    "google-client-secret",
    "youtube-refresh-token",
    // Second Google grant on the SAME OAuth client — package tracking reads
    // shipping mail with gmail.readonly. Separate token from the YouTube one
    // because widening that grant's scope forces a re-consent that kills it.
    "gmail-refresh-token",
    // base64("ccx:<password>") for the CipherCodex WebDAV store — sent as
    // "Authorization: Basic {{secret:ccx-webdav-basic}}" by the codex-harvest skill.
    "ccx-webdav-basic",
    // CipherScribe fold-in: bearer token for the self-hosted LanguageTool +
    // rewrite endpoint (settings.scribeEndpoint). No legacy settings.json field.
    "scribe-token",
    // Proton Mail Bridge's generated per-account password (NOT the Proton
    // account password) — used to log into Bridge's local IMAP server.
    "proton-bridge-password",
];

/// Package tracking can read more than one mailbox. Slot 1 is the plain
/// `gmail-refresh-token` above; extra ones take a numeric suffix. Bounded so a
/// typo still can't mint a junk vault entry.
pub const MAILBOX_SLOTS: u8 = 5;

/// `gmail-refresh-token-2` ..= `-MAILBOX_SLOTS`.
fn extra_mailbox_ids() -> impl Iterator<Item = String> {
    (2..=MAILBOX_SLOTS).map(|n| format!("gmail-refresh-token-{n}"))
}

fn all_secret_ids() -> impl Iterator<Item = String> {
    SECRET_IDS.iter().map(|s| s.to_string()).chain(extra_mailbox_ids())
}

fn valid_id(id: &str) -> bool {
    if SECRET_IDS.contains(&id) {
        return true;
    }
    extra_mailbox_ids().any(|candidate| candidate == id)
}

fn entry(id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, id).map_err(|e| format!("credential store unavailable: {e}"))
}

pub fn set_secret_impl(id: &str, value: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("unknown secret id: {id}"));
    }
    let e = entry(id)?;
    if value.is_empty() {
        // Empty = clear it.
        return delete_secret_impl(id);
    }
    e.set_password(value).map_err(|e| format!("couldn't store secret: {e}"))
}

pub fn delete_secret_impl(id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("unknown secret id: {id}"));
    }
    match entry(id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("couldn't delete secret: {e}")),
    }
}

/// Read a secret's raw value. INTERNAL ONLY — never exposed as a command.
pub fn get_secret(id: &str) -> Option<String> {
    if !valid_id(id) {
        return None;
    }
    match entry(id).ok()?.get_password() {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

pub fn has_secret(id: &str) -> bool {
    get_secret(id).is_some()
}

/// Presence map for the Settings UI (booleans only — never values).
pub fn secret_presence_impl() -> std::collections::HashMap<String, bool> {
    all_secret_ids()
        .map(|id| {
            let present = has_secret(&id);
            (id, present)
        })
        .collect()
}

/// Replace every `{{secret:<id>}}` token in `s` with the stored value. Unknown
/// ids and missing secrets resolve to empty (the request then fails auth
/// cleanly rather than leaking the placeholder). Cheap no-op when absent.
pub fn resolve_secrets(s: &str) -> String {
    if !s.contains("{{secret:") {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("{{secret:") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 9..];
        if let Some(end) = after.find("}}") {
            let id = &after[..end];
            out.push_str(&get_secret(id).unwrap_or_default());
            rest = &after[end + 2..];
        } else {
            out.push_str(&rest[start..]); // unterminated — leave as-is
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

/// Redact any stored secret value that leaked into a string (job logs, audit,
/// errors, health output). O(secrets) scan; called on user-visible text only.
pub fn redact(s: &str) -> String {
    Redactor::load().text(s)
}

/// Snapshot once per response/audit batch, never once per output fragment or
/// while holding the jobs mutex. Longest first also masks overlapping values.
pub(crate) struct Redactor(Vec<String>);

impl Redactor {
    pub(crate) fn load() -> Self {
        #[cfg(not(test))]
        let values = all_secret_ids()
            .filter_map(|id| get_secret(&id)).collect();
        // Unit tests must never inspect the user's credential vault.
        #[cfg(test)]
        let values = vec!["release-mock-secret-value".into(), "sk-test-VALUE-123".into()];
        Self::new(values)
    }

    fn new(mut values: Vec<String>) -> Self {
        values.retain(|s| !s.is_empty());
        values.sort_by_key(|s| std::cmp::Reverse(s.len()));
        values.dedup();
        Self(values)
    }

    pub(crate) fn text(&self, s: &str) -> String {
        self.0.iter().fold(s.to_string(), |text, secret| text.replace(secret, "[redacted]"))
    }

    pub(crate) fn value(&self, value: &mut serde_json::Value) {
        match value {
            serde_json::Value::String(s) => *s = self.text(s),
            serde_json::Value::Array(items) => items.iter_mut().for_each(|v| self.value(v)),
            serde_json::Value::Object(items) => items.values_mut().for_each(|v| self.value(v)),
            _ => {},
        }
    }
}

// --- Commands ---------------------------------------------------------------
// set/delete are desktop-only (you configure keys on the PC). Presence is safe
// anywhere. There is deliberately NO get-secret command.

#[tauri::command]
pub fn set_secret(id: String, value: String) -> Result<(), String> {
    set_secret_impl(&id, &value)
}

#[tauri::command]
pub fn delete_secret(id: String) -> Result<(), String> {
    delete_secret_impl(&id)
}

#[tauri::command]
pub fn secret_presence() -> std::collections::HashMap<String, bool> {
    secret_presence_impl()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_safety_redaction_includes_every_mailbox() {
        let ids: Vec<_> = all_secret_ids().collect();
        for id in extra_mailbox_ids() { assert!(ids.contains(&id)); }
        assert!(!valid_id("gmail-refresh-token-02"), "noncanonical IDs must not bypass the redaction inventory");
        let redactor = Redactor::new(vec!["mailbox-secret".into(), "mailbox-secret-long".into(), "short".into()]);
        assert_eq!(redactor.text("mailbox-secret-long / mailbox-secret / short"), "[redacted] / [redacted] / [redacted]");
    }

    #[test]
    fn resolve_and_redact_are_inverse_ish() {
        // resolve_secrets on text without placeholders is a no-op.
        assert_eq!(resolve_secrets("Authorization: Bearer abc"), "Authorization: Bearer abc");
        // Unknown id resolves to empty, terminator consumed.
        assert_eq!(resolve_secrets("x{{secret:nope}}y"), "xy");
        // Unterminated placeholder is left intact.
        assert_eq!(resolve_secrets("a{{secret:openai-api-key"), "a{{secret:openai-api-key");
        // Allowlist rejects junk ids without hitting the vault.
        assert!(set_secret_impl("not-a-real-id", "x").is_err());
        assert!(get_secret("not-a-real-id").is_none());
    }
}

#[cfg(test)]
mod keyring_roundtrip {
    use super::*;
    // Real Windows Credential Manager round-trip on this machine. Ignored by
    // default (touches the OS vault); run: cargo test -- --ignored keyring
    #[test]
    #[ignore = "touches the OS credential vault"]
    fn set_resolve_delete() {
        let id = "openai-compatible-api-key"; // allowlisted, normally unused
        let had = get_secret(id); // preserve any real value
        set_secret_impl(id, "sk-test-VALUE-123").unwrap();
        assert!(has_secret(id));
        let out = resolve_secrets("Authorization: Bearer {{secret:openai-compatible-api-key}}");
        assert_eq!(out, "Authorization: Bearer sk-test-VALUE-123");
        // redact scrubs it back out of any leaked text
        assert_eq!(redact("key=sk-test-VALUE-123 end"), "key=[redacted] end");
        delete_secret_impl(id).unwrap();
        assert!(!has_secret(id));
        if let Some(v) = had {
            set_secret_impl(id, &v).unwrap(); // restore
        }
    }
}
