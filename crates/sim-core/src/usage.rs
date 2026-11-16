//! Usage aggregation across responses: hour buckets and estimated 5-hour windows.
//!
//! **Why here and not in the server:** bucketing and block splitting are pure arithmetic
//! over [`EventKind::UsageReported`](crate::EventKind::UsageReported) events, so they
//! belong with the rest of the IO-free logic and are unit-testable without files. The
//! server only decides *which* transcripts to read and when.
//!
//! **Why hours are the unit:** a 5-hour window starts at a response floored to the hour
//! and lasts whole hours, so every response of one hour lands in the same window. Blocks
//! computed from hour totals are therefore exact, and the hour map stays small (one row
//! per active hour, model and main-or-subagent) however many responses a session has.

use std::collections::BTreeMap;
use std::ops::AddAssign;

use crate::cost::{CostBreakdown, cost_breakdown};
use crate::event::{TimestampMs, Usage};

/// One hour in milliseconds.
pub const HOUR_MS: i64 = 60 * 60 * 1000;
/// Length of an estimated usage window (the unit Pro/Max limits use): 5 hours.
pub const BLOCK_MS: i64 = 5 * HOUR_MS;

/// Start of the UTC hour containing `at`.
///
/// `div_euclid` rounds toward negative infinity, so times before the epoch floor to the
/// earlier hour (`-1` -> `-HOUR_MS`) instead of toward zero like `/` would.
#[must_use]
pub fn hour_floor(at: TimestampMs) -> i64 {
    at.div_euclid(HOUR_MS) * HOUR_MS
}

/// Summed usage of some responses: the value stored per hour bucket and per block.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Totals {
    /// Number of API responses.
    pub requests: u32,
    /// Summed tokens.
    pub usage: Usage,
    /// Summed estimated cost.
    pub cost: CostBreakdown,
    /// Latest response time seen, epoch ms (0 when empty).
    pub last_ms: TimestampMs,
}

impl Totals {
    /// Adds one API response of `model` at `at`, pricing it with [`cost_breakdown`].
    pub fn add_response(&mut self, at: TimestampMs, model: &str, usage: &Usage) {
        self.requests = self.requests.saturating_add(1);
        self.usage += usage;
        self.cost += &cost_breakdown(model, usage);
        self.last_ms = self.last_ms.max(at);
    }
}

/// Merging totals: counts and costs add, `last_ms` keeps the later time.
impl AddAssign<&Totals> for Totals {
    fn add_assign(&mut self, other: &Totals) {
        self.requests = self.requests.saturating_add(other.requests);
        self.usage += &other.usage;
        self.cost += &other.cost;
        self.last_ms = self.last_ms.max(other.last_ms);
    }
}

/// Identifies one hour bucket. Field order is the sort order: hour, then model, then
/// main agent (`false`) before subagents (`true`), matching the wire contract.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BucketKey {
    /// Start of the UTC hour, epoch ms.
    pub hour_ms: i64,
    /// Model id as reported by the API.
    pub model: String,
    /// True for responses from subagent transcripts.
    pub subagent: bool,
}

/// Usage per (hour, model, main-or-subagent).
///
/// A `BTreeMap` rather than a `HashMap` so iteration is sorted: reports and snapshots
/// come out deterministic with no extra sort.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HourBuckets(BTreeMap<BucketKey, Totals>);

impl HourBuckets {
    /// Creates an empty map.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds one response to the bucket of its hour, model and agent kind.
    pub fn add(&mut self, at: TimestampMs, model: &str, subagent: bool, usage: &Usage) {
        let key = BucketKey {
            hour_ms: hour_floor(at),
            model: model.to_owned(),
            subagent,
        };
        self.0
            .entry(key)
            .or_default()
            .add_response(at, model, usage);
    }

    /// Adds every bucket of `other` into this map.
    pub fn merge(&mut self, other: &HourBuckets) {
        for (key, totals) in &other.0 {
            *self.0.entry(key.clone()).or_default() += totals;
        }
    }

    /// Buckets in (hour, model, subagent) order.
    pub fn iter(&self) -> impl Iterator<Item = (&BucketKey, &Totals)> {
        self.0.iter()
    }

    /// Number of buckets.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// True when no response was added.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// An estimated 5-hour usage window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Block {
    /// Window start (an hour boundary), epoch ms.
    pub start_ms: i64,
    /// Window end, `start_ms + BLOCK_MS`.
    pub end_ms: i64,
    /// True when `now` falls inside `[start_ms, end_ms)`.
    pub active: bool,
    /// Everything used inside the window; `totals.last_ms` is the last response in it.
    pub totals: Totals,
}

/// Splits hour totals into estimated 5-hour windows, oldest first.
///
/// `hours` may come from many sessions, in any order and with repeated hours: they are
/// merged by hour first. A window starts at the first hour with usage and ends 5 hours
/// later; the first hour at or after that end starts the next window, so idle gaps never
/// belong to any window.
#[must_use]
pub fn five_hour_blocks<'a>(
    hours: impl IntoIterator<Item = (i64, &'a Totals)>,
    now: TimestampMs,
) -> Vec<Block> {
    let mut by_hour: BTreeMap<i64, Totals> = BTreeMap::new();
    for (hour, totals) in hours {
        *by_hour.entry(hour_floor(hour)).or_default() += totals;
    }
    let mut blocks: Vec<Block> = Vec::new();
    for (hour, totals) in &by_hour {
        match blocks.last_mut() {
            Some(block) if *hour < block.end_ms => block.totals += totals,
            _ => blocks.push(Block {
                start_ms: *hour,
                end_ms: hour + BLOCK_MS,
                active: false,
                totals: *totals,
            }),
        }
    }
    for block in &mut blocks {
        block.active = block.start_ms <= now && now < block.end_ms;
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: u64, output: u64) -> Usage {
        Usage {
            input,
            output,
            ..Usage::default()
        }
    }

    fn one(at: TimestampMs) -> Totals {
        let mut t = Totals::default();
        t.add_response(at, "claude-opus-5-5", &usage(1_000, 100));
        t
    }

    #[test]
    fn hour_floor_rounds_down_including_negatives() {
        assert_eq!(hour_floor(0), 0);
        assert_eq!(hour_floor(HOUR_MS - 1), 0);
        assert_eq!(hour_floor(HOUR_MS), HOUR_MS);
        assert_eq!(hour_floor(-1), -HOUR_MS);
        assert_eq!(hour_floor(-HOUR_MS), -HOUR_MS);
        assert_eq!(hour_floor(-HOUR_MS - 1), -2 * HOUR_MS);
    }

    #[test]
    fn add_response_counts_prices_and_tracks_last_time() {
        let mut t = Totals::default();
        t.add_response(50, "claude-opus-5-5", &usage(1_000_000, 0));
        t.add_response(20, "claude-opus-5-5", &usage(0, 1_000_000));
        assert_eq!(t.requests, 2);
        assert_eq!(t.usage.input, 1_000_000);
        assert_eq!(t.usage.output, 1_000_000);
        assert!((t.cost.input - 4.0).abs() < 1e-9);
        assert!((t.cost.output - 20.0).abs() < 1e-9);
        assert_eq!(t.last_ms, 50, "last_ms is the max, not the latest added");
    }

    #[test]
    fn totals_add_assign_sums_and_keeps_max_last() {
        let mut a = one(10);
        a += &one(5);
        assert_eq!(a.requests, 2);
        assert_eq!(a.usage.input, 2_000);
        assert_eq!(a.last_ms, 10);
    }

    #[test]
    fn buckets_split_by_hour_model_and_subagent_in_order() {
        let mut b = HourBuckets::new();
        let u = usage(10, 1);
        b.add(HOUR_MS + 5, "sonnet", false, &u);
        b.add(HOUR_MS + 9, "sonnet", false, &u);
        b.add(HOUR_MS + 1, "sonnet", true, &u);
        b.add(HOUR_MS + 2, "opus", false, &u);
        b.add(7, "sonnet", false, &u);
        let rows: Vec<(i64, &str, bool, u32, i64)> = b
            .iter()
            .map(|(k, t)| {
                (
                    k.hour_ms,
                    k.model.as_str(),
                    k.subagent,
                    t.requests,
                    t.last_ms,
                )
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                (0, "sonnet", false, 1, 7),
                (HOUR_MS, "opus", false, 1, HOUR_MS + 2),
                (HOUR_MS, "sonnet", false, 2, HOUR_MS + 9),
                (HOUR_MS, "sonnet", true, 1, HOUR_MS + 1),
            ]
        );
    }

    #[test]
    fn merge_adds_matching_buckets() {
        let mut a = HourBuckets::new();
        a.add(1, "m", false, &usage(1, 1));
        let mut b = HourBuckets::new();
        b.add(2, "m", false, &usage(2, 2));
        b.add(HOUR_MS, "m", false, &usage(3, 3));
        a.merge(&b);
        assert_eq!(a.len(), 2);
        let first = a.iter().next().unwrap().1;
        assert_eq!(
            (first.requests, first.usage.input, first.last_ms),
            (2, 3, 2)
        );
    }

    #[test]
    fn block_splits_at_exactly_five_hours() {
        let t0 = one(10);
        let t4 = one(4 * HOUR_MS + 10);
        let t5 = one(5 * HOUR_MS + 10);
        let hours = [(0, &t0), (4 * HOUR_MS, &t4), (5 * HOUR_MS, &t5)];
        let blocks = five_hour_blocks(hours, 0);
        assert_eq!(blocks.len(), 2);
        assert_eq!((blocks[0].start_ms, blocks[0].end_ms), (0, BLOCK_MS));
        assert_eq!(blocks[0].totals.requests, 2);
        assert_eq!(blocks[0].totals.last_ms, 4 * HOUR_MS + 10);
        assert_eq!(blocks[1].start_ms, 5 * HOUR_MS);
        assert_eq!(blocks[1].totals.requests, 1);
    }

    #[test]
    fn gap_longer_than_a_block_starts_fresh_at_next_hour() {
        let a = one(0);
        let b = one(12 * HOUR_MS + 30);
        // Unsorted input with a repeated hour, as when merging many sessions.
        let blocks = five_hour_blocks([(12 * HOUR_MS, &b), (0, &a), (0, &a)], 0);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].totals.requests, 2);
        assert_eq!(blocks[1].start_ms, 12 * HOUR_MS);
        assert_eq!(blocks[1].end_ms, 17 * HOUR_MS);
    }

    #[test]
    fn active_flag_is_half_open_window() {
        let t = one(HOUR_MS);
        let at = |now| five_hour_blocks([(HOUR_MS, &t)], now)[0].active;
        assert!(!at(HOUR_MS - 1));
        assert!(at(HOUR_MS));
        assert!(at(HOUR_MS + BLOCK_MS - 1));
        assert!(!at(HOUR_MS + BLOCK_MS));
    }

    #[test]
    fn no_hours_no_blocks() {
        assert_eq!(five_hour_blocks(std::iter::empty(), 0), Vec::<Block>::new());
    }
}
