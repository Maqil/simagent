//! # sim-render
//!
//! The WebGPU scene renderer. Placeholder until Phase 5, when it gains `wgpu`,
//! `wasm-bindgen` and WGSL shaders and is compiled to `wasm32-unknown-unknown`.
//!
//! It exists now so the workspace layout, lints and CI cover it from day one.

/// CPU time budget per frame, in milliseconds, from the project's perf budgets.
/// The render loop will measure itself against this.
pub const FRAME_BUDGET_MS: f64 = 2.0;
