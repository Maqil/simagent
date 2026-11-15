//! Token pricing and context-window sizes per model family.
//!
//! Prices are USD per million tokens. Kept as a table so new families are one line.

use crate::event::Usage;

/// Pricing and context size for one model family.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelInfo {
    /// Family name matched as a substring of the model id.
    pub family: &'static str,
    /// Context window in tokens.
    pub context_window: u64,
    /// USD per million uncached input tokens.
    pub input_per_mtok: f64,
    /// USD per million output tokens.
    pub output_per_mtok: f64,
}

/// Known model families, matched in order against the lowercased model id.
const MODELS: &[ModelInfo] = &[
    ModelInfo {
        family: "fable",
        context_window: 1_000_000,
        input_per_mtok: 10.0,
        output_per_mtok: 50.0,
    },
    ModelInfo {
        family: "mythos",
        context_window: 1_000_000,
        input_per_mtok: 10.0,
        output_per_mtok: 50.0,
    },
    ModelInfo {
        family: "opus",
        context_window: 1_000_000,
        input_per_mtok: 5.0,
        output_per_mtok: 25.0,
    },
    ModelInfo {
        family: "sonnet",
        context_window: 1_000_000,
        input_per_mtok: 3.0,
        output_per_mtok: 15.0,
    },
    ModelInfo {
        family: "haiku",
        context_window: 200_000,
        input_per_mtok: 1.0,
        output_per_mtok: 5.0,
    },
];

/// Cache writes cost this multiple of the input price.
const CACHE_WRITE_FACTOR: f64 = 1.25;
/// Cache reads cost this multiple of the input price.
const CACHE_READ_FACTOR: f64 = 0.1;

/// Looks up a model by id. Unknown models get `None`.
#[must_use]
pub fn model_info(model: &str) -> Option<ModelInfo> {
    let id = model.to_ascii_lowercase();
    MODELS.iter().find(|m| id.contains(m.family)).copied()
}

/// Context window for a model id, with a default for unknown models.
#[must_use]
pub fn context_window(model: &str) -> u64 {
    model_info(model).map_or(200_000, |m| m.context_window)
}

/// Estimated USD cost of one response.
#[must_use]
pub fn cost_usd(model: &str, usage: &Usage) -> f64 {
    let Some(info) = model_info(model) else {
        return 0.0;
    };
    // Token counts fit comfortably in f64's 53-bit mantissa.
    #[allow(clippy::cast_precision_loss)]
    let tokens = |n: u64| n as f64;
    let input_side = tokens(usage.input)
        + tokens(usage.cache_write) * CACHE_WRITE_FACTOR
        + tokens(usage.cache_read) * CACHE_READ_FACTOR;
    (input_side * info.input_per_mtok + tokens(usage.output) * info.output_per_mtok) / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_families_case_insensitively() {
        assert_eq!(
            model_info("claude-opus-5-5").map(|m| m.family),
            Some("opus")
        );
        assert_eq!(
            model_info("Claude-Fable-5-1").map(|m| m.family),
            Some("fable")
        );
        assert_eq!(
            model_info("claude-mythos-1").map(|m| m.family),
            Some("mythos")
        );
        assert_eq!(
            model_info("claude-haiku-4-5").map(|m| m.context_window),
            Some(200_000)
        );
        assert_eq!(model_info("gpt-x"), None);
        assert_eq!(context_window("gpt-x"), 200_000);
        assert_eq!(context_window("claude-sonnet-5"), 1_000_000);
    }

    #[test]
    fn prices_all_token_kinds() {
        let usage = Usage {
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 1_000_000,
            cache_write: 1_000_000,
        };
        // opus: 5 + 5*1.25 + 5*0.1 + 25 = 36.75
        assert!((cost_usd("claude-opus-5-5", &usage) - 36.75).abs() < 1e-9);
        assert!(cost_usd("unknown", &usage).abs() < f64::EPSILON);
    }
}
