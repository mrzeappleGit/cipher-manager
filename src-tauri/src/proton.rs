//! Proton Mail for the Packages page, via Proton Mail Bridge.
//!
//! Proton is end-to-end encrypted, so there is no API and no direct IMAP:
//! Bridge is a desktop app that decrypts locally and exposes a plain IMAP
//! server on 127.0.0.1. It is paid-plans-only — free accounts are refused at
//! Proton's API, which is why this needs no fallback for them.
//!
//! Deliberately dumb: this fetches, it does not classify. The order/carrier
//! matchers live once in `src/lib/packages.ts` and run over what comes back,
//! so Proton and Gmail can never drift apart on what counts as a shipment.
//! The `subject_hints`/`from_hints` here are only a coarse prefilter so we
//! don't download 90 days of every mailbox — the real matching is downstream.

//! Compiled only with `--features proton` — see the note in Cargo.toml. The
//! message type and the pure helpers below always build (and stay tested) so
//! the command signature doesn't change with the feature flag.

#[cfg(feature = "proton")]
use mailparse::{parse_headers, parse_mail, MailHeaderMap};
use serde::Serialize;

/// One message, flattened to what the matchers need.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MailMessage {
    pub id: String,
    pub subject: String,
    pub from: String,
    /// RFC3339, so the frontend can compare it against Gmail's dates directly.
    pub date: String,
    /// Decoded text — HTML part when there is one, since the image scraper
    /// and the tracking-link matcher both want the markup.
    pub body: String,
}

/// IMAP wants `01-Jan-2026`, and only in English.
fn imap_date(days_back: i64) -> String {
    const MON: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let d = chrono::Local::now() - chrono::Duration::days(days_back);
    let m = MON[(chrono::Datelike::month(&d) - 1) as usize];
    format!("{:02}-{}-{}", chrono::Datelike::day(&d), m, chrono::Datelike::year(&d))
}

#[cfg_attr(not(feature = "proton"), allow(dead_code))]
fn hit(haystack: &str, needles: &[String]) -> bool {
    let h = haystack.to_lowercase();
    needles.iter().any(|n| !n.is_empty() && h.contains(&n.to_lowercase()))
}

/// Pull the most useful text out of a MIME tree: prefer text/html (the image
/// and tracking-link matchers need markup), fall back to text/plain.
#[cfg(feature = "proton")]
fn best_body(raw: &[u8]) -> String {
    let Ok(mail) = parse_mail(raw) else {
        return String::new();
    };
    let mut html = String::new();
    let mut plain = String::new();
    let mut stack = vec![&mail];
    while let Some(part) = stack.pop() {
        for sub in &part.subparts {
            stack.push(sub);
        }
        let ctype = part.ctype.mimetype.to_lowercase();
        if ctype == "text/html" && html.is_empty() {
            html = part.get_body().unwrap_or_default();
        } else if ctype == "text/plain" && plain.is_empty() {
            plain = part.get_body().unwrap_or_default();
        }
    }
    if html.is_empty() {
        plain
    } else {
        // Both, so a tracking number that only appears in the plaintext
        // alternative still gets seen.
        format!("{html}\n{plain}")
    }
}

/// Stub for builds without `--features proton`, so the Tauri command keeps its
/// signature and the frontend gets a message it can actually show.
#[cfg(not(feature = "proton"))]
#[allow(clippy::too_many_arguments)]
pub fn fetch(
    _host: &str,
    _port: u16,
    _user: &str,
    _password: &str,
    _mailboxes: &[String],
    _days_back: i64,
    _subject_hints: &[String],
    _from_hints: &[String],
    _limit: usize,
) -> Result<Vec<MailMessage>, String> {
    Err("This build has no Proton support. Rebuild with `--features proton`.".into())
}

/// Fetch recent mail from Bridge. Two passes: headers for everything in the
/// window (cheap), then full bodies only for what survives the prefilter.
#[cfg(feature = "proton")]
#[allow(clippy::too_many_arguments)]
pub fn fetch(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    mailboxes: &[String],
    days_back: i64,
    subject_hints: &[String],
    from_hints: &[String],
    limit: usize,
) -> Result<Vec<MailMessage>, String> {
    // ponytail: cert validation is off because Bridge presents a self-signed
    // cert for 127.0.0.1 and the traffic never leaves the machine. Scope it to
    // loopback so this can't quietly become a real MITM hole if the host ever
    // becomes configurable to something remote.
    let loopback = matches!(host, "127.0.0.1" | "::1" | "localhost");
    if !loopback {
        return Err("Proton Bridge only ever runs on this machine — host must be 127.0.0.1.".into());
    }
    // Bridge can be configured for implicit TLS *or* STARTTLS, and it doesn't
    // use 993 either way, so imap's AutoTls guesses wrong half the time: it
    // only does implicit TLS on 993 and otherwise opens in plaintext, which
    // hangs against a socket waiting for a ClientHello. Try implicit first
    // (observed default on a real Bridge 3.8), then STARTTLS. Verification is
    // skipped per the loopback note above.
    let connect = |mode| {
        imap::ClientBuilder::new(host, port)
            .mode(mode)
            .danger_skip_tls_verify(true)
            .connect()
    };
    let client = match connect(imap::ConnectionMode::Tls) {
        Ok(c) => c,
        Err(tls_err) => connect(imap::ConnectionMode::StartTls).map_err(|starttls_err| {
            format!(
                "Can't reach Proton Bridge on {host}:{port} — is Bridge running and the tunnel up? \
                 (TLS: {tls_err}; STARTTLS: {starttls_err})"
            )
        })?,
    };

    let mut session = client
        .login(user, password)
        .map_err(|(e, _)| format!("Bridge login failed: {e}. Use the Bridge password, not your Proton password."))?;

    // Several folders on one connection. Proton's "All Mail" also contains
    // Trash and Spam, which is why the default is INBOX + Archive instead:
    // that mirrors what a Gmail search returns, where trashed and spam mail is
    // excluded unless you explicitly ask for it.
    let mut out = Vec::new();
    let mut opened = 0usize;
    let mut open_errors = Vec::new();
    for mailbox in mailboxes {
        let mailbox = mailbox.trim();
        if mailbox.is_empty() {
            continue;
        }
        if let Err(e) = session.select(mailbox) {
            // A missing folder is not fatal — Bridge names vary by account.
            open_errors.push(format!("{mailbox}: {e}"));
            continue;
        }
        opened += 1;
        let remaining = limit.saturating_sub(out.len());
        if remaining == 0 {
            break;
        }
        match scan_selected(&mut session, days_back, subject_hints, from_hints, remaining) {
            Ok(mut msgs) => out.append(&mut msgs),
            Err(e) => open_errors.push(format!("{mailbox}: {e}")),
        }
    }
    let _ = session.logout();
    if opened == 0 {
        return Err(format!("No mailbox could be opened ({})", open_errors.join("; ")));
    }
    Ok(out)
}

/// Search + fetch within whatever folder is currently selected.
#[cfg(feature = "proton")]
fn scan_selected(
    session: &mut imap::Session<imap::Connection>,
    days_back: i64,
    subject_hints: &[String],
    from_hints: &[String],
    limit: usize,
) -> Result<Vec<MailMessage>, String> {
    let uids = session
        .uid_search(format!("SINCE {}", imap_date(days_back)))
        .map_err(|e| format!("IMAP search failed: {e}"))?;
    if uids.is_empty() {
        return Ok(Vec::new());
    }

    // Pass 1 — headers only, in chunks so the command line stays sane.
    let mut all: Vec<u32> = uids.into_iter().collect();
    all.sort_unstable_by(|a, b| b.cmp(a)); // newest first, so `limit` keeps the newest
    let mut candidates: Vec<(u32, String, String, String)> = Vec::new();
    for chunk in all.chunks(200) {
        let set = chunk.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let fetched = session
            .uid_fetch(&set, "BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)]")
            .map_err(|e| format!("IMAP header fetch failed: {e}"))?;
        for f in fetched.iter() {
            let Some(uid) = f.uid else { continue };
            let Some(raw) = f.header() else { continue };
            // parse_headers decodes RFC2047 (=?UTF-8?B?...?=) for us.
            let Ok((headers, _)) = parse_headers(raw) else { continue };
            let subject = headers.get_first_value("Subject").unwrap_or_default();
            let from = headers.get_first_value("From").unwrap_or_default();
            let date = headers.get_first_value("Date").unwrap_or_default();
            if hit(&subject, subject_hints) || hit(&from, from_hints) {
                candidates.push((uid, subject, from, date));
            }
        }
        if candidates.len() >= limit {
            break;
        }
    }
    candidates.truncate(limit);

    // Pass 2 — full bodies for the survivors only.
    let mut out = Vec::with_capacity(candidates.len());
    for chunk in candidates.chunks(25) {
        let set = chunk.iter().map(|(u, ..)| u.to_string()).collect::<Vec<_>>().join(",");
        let fetched = session
            .uid_fetch(&set, "BODY.PEEK[]")
            .map_err(|e| format!("IMAP body fetch failed: {e}"))?;
        for f in fetched.iter() {
            let Some(uid) = f.uid else { continue };
            let Some((_, subject, from, date)) = chunk.iter().find(|(u, ..)| *u == uid) else {
                continue;
            };
            out.push(MailMessage {
                id: format!("proton:{uid}"),
                subject: subject.clone(),
                from: from.clone(),
                date: chrono::DateTime::parse_from_rfc2822(date.trim())
                    .map(|d| d.to_rfc3339())
                    .unwrap_or_else(|_| chrono::Local::now().to_rfc3339()),
                body: f.body().map(best_body).unwrap_or_default(),
            });
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imap_date_is_english_two_digit_day() {
        let d = imap_date(0);
        // 01-Jan-2026 shape: 2 digits, 3-letter month, 4-digit year.
        let parts: Vec<&str> = d.split('-').collect();
        assert_eq!(parts.len(), 3, "got {d}");
        assert_eq!(parts[0].len(), 2, "day must be zero-padded: {d}");
        assert_eq!(parts[1].len(), 3, "month must be the 3-letter English name: {d}");
        assert_eq!(parts[2].len(), 4, "year must be 4 digits: {d}");
        assert!(parts[0].chars().all(|c| c.is_ascii_digit()));
        assert!(parts[1].chars().all(|c| c.is_ascii_alphabetic()));
    }

    #[test]
    fn hints_match_case_insensitively_and_ignore_blanks() {
        let hints = vec!["has shipped".to_string(), String::new()];
        assert!(hit("Your Order HAS SHIPPED!", &hints));
        assert!(!hit("Weekly newsletter", &hints));
        // A blank hint must not match everything.
        assert!(!hit("anything", &[String::new()]));
    }

    #[test]
    #[cfg(feature = "proton")]
    fn best_body_prefers_html_and_decodes_transfer_encoding() {
        // quoted-printable html part: "=3D" decodes to "=".
        let raw = b"Content-Type: multipart/alternative; boundary=\"b\"\r\n\r\n\
--b\r\nContent-Type: text/plain\r\n\r\nplain here\r\n\
--b\r\nContent-Type: text/html\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n\
<a href=3D\"http://x/1Z999AA10123456784\">t</a>\r\n--b--\r\n";
        let body = best_body(raw);
        assert!(body.contains("href=\"http://x/1Z999AA10123456784\""), "got {body}");
        assert!(body.contains("plain here"), "plaintext must be kept too: {body}");
    }
}
