//! Minimal iCalendar (.ics) fetching and parsing — enough to drive the Deck
//! from a published Outlook/Google calendar feed.
//!
//! Supported: line unfolding (RFC 5545), VEVENT blocks, DTSTART/DTEND in UTC,
//! floating local time, all-day DATE values, best-effort TZID resolution, and
//! RRULE expansion for recurring events.

use std::collections::HashSet;
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};

use super::model::{local_dt, Event, EventKind};

pub fn fetch_events(url: &str) -> Result<Vec<Event>, String> {
    let body = ureq::get(url)
        .timeout(StdDuration::from_secs(20))
        .call()
        .map_err(super::asana::err_to_string)?
        .into_string()
        .map_err(|e| format!("read failed: {e}"))?;
    Ok(parse(&body))
}

/// Parse the calendar body into events within a useful window. Reaches two
/// weeks back — matching the recording-rescue cutoff, whose match-to-meeting
/// picker needs past days — through the next several days the Deck renders.
/// (UI buckets filter by same-day/future, so old events stay invisible there.)
pub fn parse(body: &str) -> Vec<Event> {
    let lines = unfold(body);

    let window_start = super::model::start_of_today() - Duration::days(14);
    let window_end = super::model::start_of_today() + Duration::days(7);

    let mut events = Vec::new();
    let mut cur: Option<Vevent> = None;

    for line in &lines {
        let upper = line.to_ascii_uppercase();
        if upper == "BEGIN:VEVENT" {
            cur = Some(Vevent::default());
            continue;
        }
        if upper == "END:VEVENT" {
            if let Some(v) = cur.take() {
                events.extend(v.into_events(window_start, window_end));
            }
            continue;
        }
        let Some(v) = cur.as_mut() else { continue };

        let (name, params, value) = split_property(line);
        match name.as_str() {
            "DTSTART" => v.start = parse_dt(&value, &params),
            "DTEND" => v.end = parse_dt(&value, &params),
            "SUMMARY" => v.summary = unescape(&value),
            "LOCATION" => v.location = unescape(&value),
            "DESCRIPTION" => v.description = unescape(&value),
            "ATTENDEE" => v.attendees += 1,
            "RRULE" => v.rrule = Some(value.trim().to_string()),
            "EXDATE" => {
                for tok in value.split(',') {
                    if let Some(dt) = parse_dt(tok, &params) {
                        v.exdates.push(dt.date_naive());
                    }
                }
            }
            "CONFERENCE"
            | "X-GOOGLE-CONFERENCE"
            | "X-MICROSOFT-SKYPETEAMSMEETINGURL"
            | "X-MICROSOFT-ONLINEMEETINGCONFLINK"
            | "X-MICROSOFT-ONLINEMEETINGEXTERNALLINK" => {
                if v.conf_url.is_none() && !value.trim().is_empty() {
                    v.conf_url = Some(unescape(&value).trim().to_string());
                }
            }
            "URL" => {
                if v.url_prop.is_none() && !value.trim().is_empty() {
                    v.url_prop = Some(unescape(&value).trim().to_string());
                }
            }
            _ => {}
        }
    }

    events.sort_by_key(|e| e.start);
    events
}

#[derive(Default)]
struct Vevent {
    start: Option<DateTime<Local>>,
    end: Option<DateTime<Local>>,
    summary: String,
    location: String,
    description: String,
    attendees: usize,
    conf_url: Option<String>,
    url_prop: Option<String>,
    rrule: Option<String>,
    exdates: Vec<NaiveDate>,
}

impl Vevent {
    fn into_events(self, win_start: DateTime<Local>, win_end: DateTime<Local>) -> Vec<Event> {
        let Some(start) = self.start else {
            return Vec::new();
        };
        let end = self.end.unwrap_or_else(|| start + Duration::minutes(30));
        let duration = end - start;

        let url = self
            .conf_url
            .clone()
            .or_else(|| extract_url(&self.location))
            .or_else(|| extract_url(&self.description))
            .or_else(|| self.url_prop.clone());

        let kind = classify(&self.location, &self.description, url.as_deref());
        let who = if self.attendees > 0 {
            format!("{} attendee{}", self.attendees, if self.attendees == 1 { "" } else { "s" })
        } else {
            String::new()
        };
        let location = if self.location.trim().is_empty() {
            "—".to_string()
        } else {
            self.location.trim().to_string()
        };
        let title = if self.summary.trim().is_empty() {
            "(no title)".to_string()
        } else {
            self.summary.trim().to_string()
        };

        // Cap the invite body — Outlook descriptions can run to many KB of boilerplate.
        let description: String = self.description.trim().chars().take(2000).collect();

        let make = |s: DateTime<Local>, e: DateTime<Local>| Event {
            title: title.clone(),
            start: s,
            end: e,
            location: location.clone(),
            kind,
            who: who.clone(),
            url: url.clone(),
            description: description.clone(),
        };

        if let Some(rrule_str) = &self.rrule {
            if let Some(rule) = super::recur::parse_rrule(rrule_str) {
                let exset: HashSet<NaiveDate> = self.exdates.iter().copied().collect();
                return super::recur::expand(start, duration, &rule, &exset, win_start, win_end)
                    .into_iter()
                    .map(|(s, e)| make(s, e))
                    .collect();
            }
        }

        if start <= win_end && end >= win_start {
            vec![make(start, end)]
        } else {
            Vec::new()
        }
    }
}

fn extract_url(text: &str) -> Option<String> {
    let start = text.find("http://").or_else(|| text.find("https://"))?;
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(|c| matches!(c, '.' | ',' | ')' | ';'));
    if url.len() > "https://".len() {
        Some(url.to_string())
    } else {
        None
    }
}

fn classify(location: &str, description: &str, url: Option<&str>) -> EventKind {
    let hay = format!("{} {} {}", location, description, url.unwrap_or("")).to_ascii_lowercase();
    const ONLINE: [&str; 7] = ["zoom", "meet", "teams", "webex", "http://", "https://", "hangout"];
    if ONLINE.iter().any(|k| hay.contains(k)) {
        EventKind::Video
    } else if location.trim().is_empty() {
        EventKind::Other
    } else {
        EventKind::Room
    }
}

fn unfold(body: &str) -> Vec<String> {
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    let mut out: Vec<String> = Vec::new();
    for raw in normalized.split('\n') {
        if (raw.starts_with(' ') || raw.starts_with('\t')) && !out.is_empty() {
            let last = out.last_mut().unwrap();
            last.push_str(&raw[1..]);
        } else {
            out.push(raw.to_string());
        }
    }
    out
}

fn split_property(line: &str) -> (String, Vec<(String, String)>, String) {
    let colon = line.find(':').unwrap_or(line.len());
    let (left, right) = line.split_at(colon);
    let value = right.strip_prefix(':').unwrap_or("").to_string();

    let mut parts = left.split(';');
    let name = parts.next().unwrap_or("").trim().to_ascii_uppercase();
    let params = parts
        .filter_map(|p| {
            let mut kv = p.splitn(2, '=');
            let k = kv.next()?.trim().to_ascii_uppercase();
            let v = kv.next().unwrap_or("").trim().trim_matches('"').to_string();
            Some((k, v))
        })
        .collect();
    (name, params, value)
}

/// Map a Windows timezone name (as emitted by Outlook in TZID) to its IANA
/// name. Returns None for names already in IANA form (Google's TZIDs) or ones
/// we don't cover — the caller then tries the raw string.
// ponytail: common zones only, from the CLDR windowsZones table. Add rows if a
// real feed shows up with a name that isn't here.
fn win_tz_to_iana(name: &str) -> Option<&'static str> {
    Some(match name.trim() {
        "Dateline Standard Time" => "Etc/GMT+12",
        "Hawaiian Standard Time" => "Pacific/Honolulu",
        "Alaskan Standard Time" => "America/Anchorage",
        "Pacific Standard Time" | "Pacific Standard Time (Mexico)" => "America/Los_Angeles",
        "US Mountain Standard Time" => "America/Phoenix",
        "Mountain Standard Time" | "Mountain Standard Time (Mexico)" => "America/Denver",
        "Central Standard Time" | "Central Standard Time (Mexico)" => "America/Chicago",
        "Canada Central Standard Time" => "America/Regina",
        "Eastern Standard Time" | "US Eastern Standard Time" => "America/New_York",
        "Atlantic Standard Time" => "America/Halifax",
        "Newfoundland Standard Time" => "America/St_Johns",
        "SA Pacific Standard Time" => "America/Bogota",
        "E. South America Standard Time" => "America/Sao_Paulo",
        "GMT Standard Time" => "Europe/London",
        "Greenwich Standard Time" => "Atlantic/Reykjavik",
        "W. Europe Standard Time" => "Europe/Berlin",
        "Central Europe Standard Time" => "Europe/Budapest",
        "Romance Standard Time" => "Europe/Paris",
        "Central European Standard Time" => "Europe/Warsaw",
        "W. Central Africa Standard Time" => "Africa/Lagos",
        "GTB Standard Time" => "Europe/Bucharest",
        "E. Europe Standard Time" => "Europe/Chisinau",
        "South Africa Standard Time" => "Africa/Johannesburg",
        "FLE Standard Time" => "Europe/Kiev",
        "Israel Standard Time" => "Asia/Jerusalem",
        "Arabic Standard Time" | "Arab Standard Time" => "Asia/Baghdad",
        "Russian Standard Time" => "Europe/Moscow",
        "Arabian Standard Time" => "Asia/Dubai",
        "Iran Standard Time" => "Asia/Tehran",
        "Pakistan Standard Time" => "Asia/Karachi",
        "India Standard Time" => "Asia/Kolkata",
        "Bangladesh Standard Time" => "Asia/Dhaka",
        "SE Asia Standard Time" => "Asia/Bangkok",
        "China Standard Time" => "Asia/Shanghai",
        "Singapore Standard Time" => "Asia/Singapore",
        "W. Australia Standard Time" => "Australia/Perth",
        "Taipei Standard Time" => "Asia/Taipei",
        "Tokyo Standard Time" => "Asia/Tokyo",
        "Korea Standard Time" => "Asia/Seoul",
        "Cen. Australia Standard Time" => "Australia/Adelaide",
        "AUS Eastern Standard Time" | "E. Australia Standard Time" => "Australia/Sydney",
        "Tasmania Standard Time" => "Australia/Hobart",
        "New Zealand Standard Time" => "Pacific/Auckland",
        "UTC" | "Coordinated Universal Time" => "UTC",
        _ => return None,
    })
}

fn param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(',') => out.push(','),
                Some(';') => out.push(';'),
                Some('\\') => out.push('\\'),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn parse_dt(value: &str, params: &[(String, String)]) -> Option<DateTime<Local>> {
    let value = value.trim();
    let is_date = param(params, "VALUE") == Some("DATE") || (value.len() == 8 && !value.contains('T'));

    if is_date {
        let d = NaiveDate::parse_from_str(value, "%Y%m%d").ok()?;
        return Some(local_dt(d.and_hms_opt(0, 0, 0)?));
    }

    if let Some(stripped) = value.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(stripped, "%Y%m%dT%H%M%S").ok()?;
        return Some(Utc.from_utc_datetime(&naive).with_timezone(&Local));
    }

    let naive = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()?;

    if let Some(tzid) = param(params, "TZID") {
        // Outlook publishes Windows zone names ("Eastern Standard Time"); map
        // those to IANA so chrono-tz can resolve them. Direct IANA TZIDs
        // (Google) pass straight through.
        let iana = win_tz_to_iana(tzid).unwrap_or(tzid);
        if let Ok(tz) = iana.parse::<chrono_tz::Tz>() {
            return match tz.from_local_datetime(&naive) {
                chrono::LocalResult::Single(dt) => Some(dt.with_timezone(&Local)),
                chrono::LocalResult::Ambiguous(a, _) => Some(a.with_timezone(&Local)),
                chrono::LocalResult::None => Some(local_dt(naive)),
            };
        }
    }

    Some(local_dt(naive))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_tzid_resolves_to_correct_instant() {
        // 9:00 AM "Eastern Standard Time" == 14:00 UTC (EDT, summer). Without the
        // Windows→IANA map this fell through to local time and rendered wrong.
        let p = vec![("TZID".into(), "Eastern Standard Time".into())];
        let dt = parse_dt("20260707T090000", &p).unwrap();
        assert_eq!(dt.with_timezone(&Utc).format("%Y%m%dT%H%M%SZ").to_string(), "20260707T130000Z");

        // IANA TZID still works unchanged.
        let g = vec![("TZID".into(), "America/New_York".into())];
        assert_eq!(parse_dt("20260707T090000", &g).unwrap(), dt);
    }
}
