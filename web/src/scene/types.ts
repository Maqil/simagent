// The scene renderer contract. The Canvas 2D implementation lives in canvas2d.ts; the
// WebGPU renderer (sim-render via wasm, Phase 5) will implement the same interface so
// React code never knows which one is running.
import type { AgentEvent, AgentId, SessionState } from '../protocol';

export interface PushOptions {
  /**
   * The events were reached by seeking (replay scrub, history load), not lived through.
   * Counters still update, but only events within ~2 s of the newest one spawn effects,
   * already part-way through so the scene looks like it was running.
   */
  instant?: boolean;
}

export interface SceneRenderer {
  /** Replaces the rendered session (or clears the scene with `null`). */
  setState(session: SessionState | null): void;
  /**
   * Feeds newly seen events for transient effects: message comets, tool satellites and
   * data particles, receive ripples and inbox counters. Call with each new tail, oldest
   * first; call `setState` with the matching state first.
   */
  pushEvents(events: AgentEvent[], opts?: PushOptions): void;
  /** Drops every transient effect and counter (new session, backward seek). */
  clearEffects(): void;
  /** Speed of effect animations relative to real time (replay at 4x → 4). Default 1. */
  setTimeScale?(k: number): void;
  /** Call when the host element's size or the device pixel ratio changed. */
  resize(): void;
  /** Stops all loops and removes listeners. The renderer is unusable afterwards. */
  destroy(): void;
  /** Highlights one agent (from the side panel), or none. */
  setSelected?(agent: AgentId | null): void;
  /**
   * Writes where a participant (an agent, or `USER_AGENT` for "you") is drawn right now
   * into `out`: CSS pixels relative to the canvas, plus its on-screen radius. Returns false
   * if it is not in the scene. DOM overlays use it to sit next to things on the canvas;
   * the caller owns `out`, so calling this every frame allocates nothing.
   */
  anchorOf?(id: AgentId, out: Anchor): boolean;
}

/** A point on screen (CSS px, relative to the canvas) plus a radius. */
export interface Anchor {
  x: number;
  y: number;
  r: number;
}

export interface SceneOptions {
  /** Called when the user clicks an orb (or empty space, with `null`). */
  onSelectAgent?: (agent: AgentId | null) => void;
  /** Called when the user clicks a "✓ N finished" badge next to a parent agent. */
  onShowFinished?: () => void;
  /**
   * Called after every redrawn frame (the scene only redraws when something changed), so
   * DOM overlays can re-read `anchorOf` when the camera or a node moved.
   */
  onViewChanged?: () => void;
}

export type SceneFactory = (canvas: HTMLCanvasElement, options: SceneOptions) => SceneRenderer;
