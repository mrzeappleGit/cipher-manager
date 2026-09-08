//! Pragmatic RRULE expansion for the Deck's short window.
//!
//! Supports FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL,
//! BYDAY (for weekly), and EXDATE exclusions — which covers essentially every
//! real recurring meeting. Monthly BYDAY ordinals ("3rd Thursday") are not
//! resolved; such rules fall back to the DTSTART day-of-month.

use std::collections::HashSet;

use chrono::{
    DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc, Weekday,
};

use super::model::local_dt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone)]
pub struct Rrule {
    pub freq: Freq,
    pub interval: i64,
    pub count: Option<u32>,
    pub until: Option<DateTime<Local>>,
    pub byday: Vec<Weekday>,
}

const CAP: usize = 20_000;

pub fn parse_rrule(value: &str) -> Option<Rrule> {
    let mut freq = None;
    let mut interval = 1i64;
    let mut count = None;
    let mut until = None;
    let mut byday = Vec::new();

    for part in value.split(';') {
        let mut kv = part.splitn(2, '=');
        let key = kv.next()?.trim().to_ascii_uppercase();
        let val = kv.next().unwrap_or("").trim();
        match key.as_str() {
            "FREQ" => {
                freq = match val.to_ascii_uppercase().as_str() {
                    "DAILY" => Some(Freq::Daily),
                    "WEEKLY" => Some(Freq::Weekly),
                    "MONTHLY" => Some(Freq::Monthly),
                    "YEARLY" => Some(Freq::Yearly),
                    _ => None,
                }
            }
            "INTERVAL" => interval = val.parse::<i64>().unwrap_or(1).max(1),
            "COUNT" => count = val.parse::<u32>().ok(),
            "UNTIL" => until = parse_until(val),
            "BYDAY" => byday = val.split(',').filter_map(parse_weekday).collect(),
            _ => {}
        }
    }

    Some(Rrule {
        freq: freq?,
        interval,
        count,
        until,
        byday,
    })
}

/// Expand a recurrence into (start, end) instances within `[win_start, win_end]`.
pub fn expand(
    dtstart: DateTime<Local>,
    duration: Duration,
    rule: &Rrule,
    exdates: &HashSet<NaiveDate>,
    win_start: DateTime<Local>,
    win_end: DateTime<Local>,
) -> Vec<(DateTime<Local>, DateTime<Local>)> {
    let base = dtstart.date_naive();
    let interval = rule.interval.max(1);
    let mut out = Vec::new();
    let mut generated: u32 = 0;

    let consider = |date: NaiveDate,
                    generated: &mut u32,
                    out: &mut Vec<(DateTime<Local>, DateTime<Local>)>|
     -> Flow {
        if date < base {
            return Flow::Continue;
        }
        let occ = with_time(date, dtstart);
        if let Some(until) = rule.until {
            if occ > until {
                return Flow::Stop;
            }
        }
        *generated += 1;
        if let Some(c) = rule.count {
            if *generated > c {
                return Flow::Stop;
            }
        }
        if occ > win_end {
            return Flow::Stop;
        }
        if !exdates.contains(&date) {
            let end = occ + duration;
            if end >= win_start {
                out.push((occ, end));
            }
        }
        Flow::Continue
    };

    if rule.freq == Freq::Weekly && !rule.byday.is_empty() {
        let mut days: Vec<Weekday> = rule.byday.clone();
        days.sort_by_key(|d| d.num_days_from_monday());
        let week0_start = base - Duration::days(base.weekday().num_days_from_monday() as i64);
        let win_end_date = win_end.date_naive();

        let mut w: i64 = 0;
        'weeks: loop {
            let week_start = week0_start + Duration::days(7 * interval * w);
            if week_start > win_end_date + Duration::days(1) {
                break;
            }
            for wd in &days {
                let date = week_start + Duration::days(wd.num_days_from_monday() as i64);
                if let Flow::Stop = consider(date, &mut generated, &mut out) {
                    break 'weeks;
                }
            }
            w += 1;
            if w as usize > CAP {
                break;
            }
        }
    } else {
        let mut n: i64 = 0;
        loop {
            let date = match rule.freq {
                Freq::Daily => base + Duration::days(interval * n),
                Freq::Weekly => base + Duration::days(7 * interval * n),
                Freq::Monthly => add_months(base, interval * n),
                Freq::Yearly => add_years(base, (interval * n) as i32),
            };
            if let Flow::Stop = consider(date, &mut generated, &mut out) {
                break;
            }
            n += 1;
            if n as usize > CAP {
                break;
            }
        }
    }

    out.sort_by_key(|(s, _)| *s);
    out
}

enum Flow {
    Continue,
    Stop,
}

fn with_time(date: NaiveDate, base: DateTime<Local>) -> DateTime<Local> {
    let naive = date
        .and_hms_opt(base.hour(), base.minute(), base.second())
        .unwrap_or_else(|| date.and_hms_opt(0, 0, 0).unwrap());
    local_dt(naive)
}

fn parse_weekday(tok: &str) -> Option<Weekday> {
    let tok = tok.trim();
    if tok.len() < 2 {
        return None;
    }
    let code = &tok[tok.len() - 2..];
    match code.to_ascii_uppercase().as_str() {
        "MO" => Some(Weekday::Mon),
        "TU" => Some(Weekday::Tue),
        "WE" => Some(Weekday::Wed),
        "TH" => Some(Weekday::Thu),
        "FR" => Some(Weekday::Fri),
        "SA" => Some(Weekday::Sat),
        "SU" => Some(Weekday::Sun),
        _ => None,
    }
}

fn parse_until(v: &str) -> Option<DateTime<Local>> {
    let v = v.trim();
    if let Some(s) = v.strip_suffix('Z') {
        let ndt = NaiveDateTime::parse_from_str(s, "%Y%m%dT%H%M%S").ok()?;
        return Some(Utc.from_utc_datetime(&ndt).with_timezone(&Local));
    }
    if v.len() == 8 {
        let d = NaiveDate::parse_from_str(v, "%Y%m%d").ok()?;
        return Some(local_dt(d.and_hms_opt(23, 59, 59)?));
    }
    let ndt = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    Some(local_dt(ndt))
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let first_next = NaiveDate::from_ymd_opt(ny, nm, 1).unwrap();
    (first_next - Duration::days(1)).day()
}

fn add_months(date: NaiveDate, months: i64) -> NaiveDate {
    let total = date.month0() as i64 + months;
    let year = date.year() as i64 + total.div_euclid(12);
    let month = total.rem_euclid(12) as u32 + 1;
    let last = last_day_of_month(year as i32, month);
    NaiveDate::from_ymd_opt(year as i32, month, date.day().min(last)).unwrap()
}

fn add_years(date: NaiveDate, years: i32) -> NaiveDate {
    let year = date.year() + years;
    let last = last_day_of_month(year, date.month());
    NaiveDate::from_ymd_opt(year, date.month(), date.day().min(last)).unwrap()
}
