//! A day-level usage ledger that outlives Claude Code's transcript cleanup.
//!
//! Claude Code deletes session transcripts older than `cleanupPeriodDays`
//! (default 30), so scanning `~/.claude/projects` only ever sees a rolling
//! window. That is why the all-time "tokens processed" number went *down*
//! every night: another day aged off the back and nothing remembered it. This
//! banks each day's totals to `~/.claude/cipher-manager/usage-ledger.json` and
//! folds pruned days back in, so cleanup can keep reclaiming disk without the
//! headline losing history.
//!
//! It can only bank what it has seen. Days deleted before the first run with
//! this code are gone for good.

use std::collections::HashMap;

use crate::model::{DayUsage, TokenTotals, UsageStats};

const KEY: &str = "usage-ledger";

/// Fold the banked ledger into a fresh scan, then re-bank the merged result.
pub fn merge_and_bank(by_day: &mut HashMap<String, DayUsage>, usage: &mut UsageStats) {
    let banked: HashMap<String, DayUsage> = crate::commands::read_app_state(KEY)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    fold(banked, by_day, usage);

    // Both the app and `serve` scan, so this is last-writer-wins. Harmless:
    // each writes a max-merge of the same disk, so a lost update is re-derived
    // on the next scan.
    if let Ok(s) = serde_json::to_string(by_day) {
        let _ = crate::commands::write_app_state(KEY, &s);
    }
}

/// The pure half: per day the bigger grand total wins.
///
/// That single rule is what makes this monotone. A day still fully on disk
/// stays authoritative, and today keeps growing as it fills in — the live
/// scan is always ahead there, so the stale bank never wins. A day that has
/// been pruned, or half-pruned when the deleted file was a session spanning
/// two days, falls back to what was banked.
///
/// ponytail: days only — `by_model`/`by_project`/`message_count` still shrink
/// with the window, so the donut can sum to less than the headline. Fixing
/// that means banking a model breakdown per day; do it if that ever bites.
fn fold(
    banked: HashMap<String, DayUsage>,
    by_day: &mut HashMap<String, DayUsage>,
    usage: &mut UsageStats,
) {
    for (day, old) in banked {
        let (lt, lc) = by_day
            .get(&day)
            .map(|d| (d.tokens, d.cost_usd))
            .unwrap_or((TokenTotals::default(), 0.0));
        if old.tokens.grand_total() <= lt.grand_total() {
            continue;
        }
        // Add back only the missing part — whatever survived on disk is
        // already counted in `usage.tokens`.
        usage.tokens.add(&TokenTotals {
            input: old.tokens.input.saturating_sub(lt.input),
            output: old.tokens.output.saturating_sub(lt.output),
            cache_read: old.tokens.cache_read.saturating_sub(lt.cache_read),
            cache_write_5m: old.tokens.cache_write_5m.saturating_sub(lt.cache_write_5m),
            cache_write_1h: old.tokens.cache_write_1h.saturating_sub(lt.cache_write_1h),
        });
        usage.total_cost += (old.cost_usd - lc).max(0.0);
        by_day.insert(day, old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(d: &str, read: u64, cost: f64) -> DayUsage {
        DayUsage {
            day: d.to_string(),
            tokens: TokenTotals { cache_read: read, ..Default::default() },
            cost_usd: cost,
            message_count: 1,
        }
    }

    #[test]
    fn fold_restores_pruned_days_without_double_counting_live_ones() {
        let banked = HashMap::from([
            ("2026-06-01".into(), day("2026-06-01", 100, 1.0)), // pruned off disk
            ("2026-08-01".into(), day("2026-08-01", 40, 0.4)),  // half-pruned
            ("2026-08-04".into(), day("2026-08-04", 10, 0.1)),  // stale: today grew
        ]);
        let mut by_day = HashMap::from([
            ("2026-08-01".into(), day("2026-08-01", 30, 0.3)),
            ("2026-08-04".into(), day("2026-08-04", 70, 0.7)),
        ]);
        // What the live scan alone totalled: 30 + 70.
        let mut usage = UsageStats {
            tokens: TokenTotals { cache_read: 100, ..Default::default() },
            total_cost: 1.0,
            ..Default::default()
        };

        fold(banked, &mut by_day, &mut usage);

        // 100 restored whole, 10 restored as the 40-vs-30 delta, today untouched.
        assert_eq!(usage.tokens.cache_read, 210);
        assert!((usage.total_cost - 2.1).abs() < 1e-9);
        assert_eq!(by_day["2026-06-01"].tokens.cache_read, 100);
        assert_eq!(by_day["2026-08-01"].tokens.cache_read, 40);
        assert_eq!(by_day["2026-08-04"].tokens.cache_read, 70, "today must stay live");
    }

    #[test]
    fn fold_is_idempotent() {
        let banked = HashMap::from([("2026-06-01".into(), day("2026-06-01", 100, 1.0))]);
        let mut by_day = HashMap::new();
        let mut usage = UsageStats::default();

        fold(banked.clone(), &mut by_day, &mut usage);
        fold(banked, &mut by_day, &mut usage);

        assert_eq!(usage.tokens.cache_read, 100, "re-folding must not re-add");
    }
}
