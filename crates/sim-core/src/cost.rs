//! Token pricing and context-window sizes per model version.
//!
//! Prices are USD per million tokens at Anthropic's first-party API rates (checked
//! 2026-11-15). For a Pro/Max subscription these are an *API-equivalent* estimate, not a
//! bill. Kept as a table so a new model is one row; rows are matched in order, so a
//! specific version (`opus-5-5`) must come before its family fallback (`opus`).

use std::ops::AddAssign;

use serde::{Deserialize, Serialize};

use crate::event::Usage;

/// Pricing and context size for one model version (or family fallback).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelInfo {
    /// Matched as a substring of the lowercased model id.
    pub pattern: &'static str,
    /// Context window in tokens.
    pub context_window: u64,
    /// USD per million uncached input tokens.
    pub input_per_mtok: f64,
    /// USD per million output tokens.
    pub output_per_mtok: f64,
    /// USD per million cache-read tokens. Explicit because the ratio to input differs
    /// by model (0.025x on Fable 5.1+, 0.05x on Opus/Sonnet 5.5, 0.1x elsewhere).
    pub cache_read_per_mtok: f64,
    /// Higher rates for long prompts, when the model has them.
    pub long_prompt: Option<LongPrompt>,
}

/// A price tier for prompts above a size: every rate is multiplied by `factor`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LongPrompt {
    /// Prompt size (input side tokens) above which the tier applies.
    pub above_tokens: u64,
    /// Multiplier on all rates.
    pub factor: f64,
}

/// One table row, written compactly: pattern, context, input, output, cache read.
const fn row(pattern: &'static str, context: u64, i: f64, o: f64, r: f64) -> ModelInfo {
    ModelInfo {
        pattern,
        context_window: context,
        input_per_mtok: i,
        output_per_mtok: o,
        cache_read_per_mtok: r,
        long_prompt: None,
    }
}

const M: u64 = 1_000_000;

/// Known models, most specific first.
const MODELS: &[ModelInfo] = &[
    row("fable-5-2", M, 8.0, 40.0, 0.20),
    row("mythos-5-2", M, 8.0, 40.0, 0.20),
    row("fable-5-1", M, 10.0, 50.0, 0.25),
    row("mythos-5-1", M, 10.0, 50.0, 0.25),
    row("fable", M, 10.0, 50.0, 1.00),
    row("mythos", M, 10.0, 50.0, 1.00),
    row("opus-5-5", M, 4.0, 20.0, 0.20),
    row("opus", M, 5.0, 25.0, 0.50),
    row("sonnet-5-5", M, 2.0, 10.0, 0.10),
    row("sonnet-5", M, 2.0, 10.0, 0.20),
    row("sonnet", M, 3.0, 15.0, 0.30),
    ModelInfo {
        // $0.10 / $0.50 up to 100K prompt tokens, $0.50 / $2.50 beyond.
        long_prompt: Some(LongPrompt {
            above_tokens: 100_000,
            factor: 5.0,
        }),
        ..row("haiku-5-5", M, 0.10, 0.50, 0.01)
    },
    row("haiku", 200_000, 1.0, 5.0, 0.10),
];

/// 5-minute cache writes cost this multiple of the input price.
const CACHE_WRITE_5M_FACTOR: f64 = 1.25;
/// 1-hour cache writes cost this multiple of the input price.
const CACHE_WRITE_1H_FACTOR: f64 = 2.0;

/// Looks up a model by id. Unknown models get `None`.
#[must_use]
pub fn model_info(model: &str) -> Option<ModelInfo> {
    let id = model.to_ascii_lowercase();
    MODELS.iter().find(|m| id.contains(m.pattern)).copied()
}

/// Context window for a model id, with a default for unknown models.
#[must_use]
pub fn context_window(model: &str) -> u64 {
    model_info(model).map_or(200_000, |m| m.context_window)
}

/// Estimated USD cost split by what was paid for. Summable, so totals per day, model or
/// session keep the split and the UI can show where the money went.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct CostBreakdown {
    /// Uncached input.
    pub input: f64,
    /// Output, including thinking.
    pub output: f64,
    /// Cache reads.
    pub cache_read: f64,
    /// Cache writes (both lifetimes).
    pub cache_write: f64,
}

impl CostBreakdown {
    /// Sum of all parts.
    #[must_use]
    pub fn total(&self) -> f64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

impl AddAssign<&CostBreakdown> for CostBreakdown {
    fn add_assign(&mut self, other: &CostBreakdown) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
    }
}

/// Estimated cost of one response, split by token kind. Unknown models cost zero.
#[must_use]
pub fn cost_breakdown(model: &str, usage: &Usage) -> CostBreakdown {
    let Some(info) = model_info(model) else {
        return CostBreakdown::default();
    };
    let factor = info
        .long_prompt
        .filter(|t| usage.context_tokens() > t.above_tokens)
        .map_or(1.0, |t| t.factor);
    // USD for `n` tokens at `per_mtok`. Token counts fit in f64's 53-bit mantissa.
    #[allow(clippy::cast_precision_loss)]
    let usd = |n: u64, per_mtok: f64| n as f64 * per_mtok * factor / 1_000_000.0;
    let write_5m = usage.cache_write.saturating_sub(usage.cache_write_1h);
    CostBreakdown {
        input: usd(usage.input, info.input_per_mtok),
        output: usd(usage.output, info.output_per_mtok),
        cache_read: usd(usage.cache_read, info.cache_read_per_mtok),
        cache_write: usd(write_5m, info.input_per_mtok * CACHE_WRITE_5M_FACTOR)
            + usd(
                usage.cache_write_1h,
                info.input_per_mtok * CACHE_WRITE_1H_FACTOR,
            ),
    }
}

/// Estimated USD cost of one response.
#[must_use]
pub fn cost_usd(model: &str, usage: &Usage) -> f64 {
    cost_breakdown(model, usage).total()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    fn mtok(input: u64, output: u64, cache_read: u64, cache_write: u64) -> Usage {
        Usage {
            input: input * M,
            output: output * M,
            cache_read: cache_read * M,
            cache_write: cache_write * M,
            ..Usage::default()
        }
    }

    #[test]
    fn matches_most_specific_version_first() {
        let pattern = |id: &str| model_info(id).map(|m| m.pattern);
        assert_eq!(pattern("claude-opus-5-5"), Some("opus-5-5"));
        assert_eq!(pattern("claude-opus-4-8"), Some("opus"));
        assert_eq!(pattern("Claude-Fable-5-1"), Some("fable-5-1"));
        assert_eq!(pattern("claude-fable-5"), Some("fable"));
        assert_eq!(pattern("claude-sonnet-5-5[1m]"), Some("sonnet-5-5"));
        assert_eq!(pattern("claude-sonnet-5"), Some("sonnet-5"));
        assert_eq!(pattern("claude-sonnet-4-6"), Some("sonnet"));
        assert_eq!(pattern("claude-mythos-5-2"), Some("mythos-5-2"));
        assert_eq!(pattern("gpt-x"), None);
        assert_eq!(context_window("claude-haiku-4-5"), 200_000);
        assert_eq!(context_window("claude-haiku-5-5"), 1_000_000);
        assert_eq!(context_window("gpt-x"), 200_000);
    }

    #[test]
    fn prices_each_token_kind_at_its_own_rate() {
        // opus 5.5: input 4, output 20, cache read 0.20, 5m write 4 * 1.25 = 5.
        let c = cost_breakdown("claude-opus-5-5", &mtok(1, 1, 1, 1));
        assert!(close(c.input, 4.0) && close(c.output, 20.0));
        assert!(close(c.cache_read, 0.20) && close(c.cache_write, 5.0));
        assert!(close(c.total(), 29.2));
        assert!(close(cost_usd("unknown", &mtok(1, 1, 1, 1)), 0.0));
    }

    #[test]
    fn one_hour_cache_writes_cost_twice_input() {
        let mut u = mtok(0, 0, 0, 3);
        u.cache_write_1h = 2 * M;
        // sonnet 5.5 input 2: 1M at 5m (2.5) + 2M at 1h (8.0).
        assert!(close(
            cost_breakdown("claude-sonnet-5-5", &u).cache_write,
            10.5
        ));
    }

    #[test]
    fn long_prompts_switch_haiku_to_the_higher_tier() {
        let short = Usage {
            input: 100_000,
            ..Usage::default()
        };
        let long = Usage {
            input: 100_001,
            ..Usage::default()
        };
        assert!(close(cost_usd("claude-haiku-5-5", &short), 0.01));
        assert!(close(
            cost_usd("claude-haiku-5-5", &long),
            100_001.0 * 0.5 / 1e6
        ));
    }

    #[test]
    fn breakdowns_sum() {
        let mut total = CostBreakdown::default();
        let one = cost_breakdown("claude-opus-5-5", &mtok(1, 0, 0, 0));
        total += &one;
        total += &one;
        assert!(close(total.input, 8.0));
    }
}
