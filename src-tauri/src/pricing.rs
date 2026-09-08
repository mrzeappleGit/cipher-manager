//! Estimated Anthropic API pricing (USD per million tokens).
//!
//! These are public list prices used to *estimate* spend. Claude Code
//! subscriptions are not billed per-token, so treat these as a relative
//! signal of where tokens are going rather than an invoice.
//!
//! Rates are matched by model-family substring so new dated model ids keep
//! working without edits here.

use crate::model::{PriceRow, TokenTotals};

pub struct Rates {
    pub input: f64,
    pub output: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
    pub cache_read: f64,
}

const OPUS: Rates = Rates {
    input: 15.0,
    output: 75.0,
    cache_write_5m: 18.75,
    cache_write_1h: 30.0,
    cache_read: 1.5,
};

const SONNET: Rates = Rates {
    input: 3.0,
    output: 15.0,
    cache_write_5m: 3.75,
    cache_write_1h: 6.0,
    cache_read: 0.3,
};

const HAIKU: Rates = Rates {
    input: 1.0,
    output: 5.0,
    cache_write_5m: 1.25,
    cache_write_1h: 2.0,
    cache_read: 0.1,
};

// Estimated mid/high tier for the Claude 5 "Fable"/"Mythos" family, which is
// not Sonnet-priced. Approximate — adjust if official rates are published.
const FABLE: Rates = Rates {
    input: 10.0,
    output: 50.0,
    cache_write_5m: 12.5,
    cache_write_1h: 20.0,
    cache_read: 1.0,
};

/// Fallback for unknown models (assume Sonnet-tier).
const DEFAULT: Rates = SONNET;

pub fn rates_for(model: &str) -> &'static Rates {
    let m = model.to_lowercase();
    if m.contains("opus") {
        &OPUS
    } else if m.contains("haiku") {
        &HAIKU
    } else if m.contains("sonnet") {
        &SONNET
    } else if m.contains("fable") || m.contains("mythos") {
        &FABLE
    } else {
        &DEFAULT
    }
}

/// Estimated USD cost of one message's token usage.
pub fn cost(model: &str, t: &TokenTotals) -> f64 {
    let r = rates_for(model);
    (t.input as f64 * r.input
        + t.output as f64 * r.output
        + t.cache_read as f64 * r.cache_read
        + t.cache_write_5m as f64 * r.cache_write_5m
        + t.cache_write_1h as f64 * r.cache_write_1h)
        / 1_000_000.0
}

/// The price table, for display in settings.
pub fn table() -> Vec<PriceRow> {
    let mk = |family: &str, r: &Rates| PriceRow {
        family: family.to_string(),
        input: r.input,
        output: r.output,
        cache_write_5m: r.cache_write_5m,
        cache_write_1h: r.cache_write_1h,
        cache_read: r.cache_read,
    };
    vec![
        mk("Opus", &OPUS),
        mk("Fable / Mythos*", &FABLE),
        mk("Sonnet", &SONNET),
        mk("Haiku", &HAIKU),
    ]
}
