import type { ReflowInput, ReflowResult } from "./types.js";

/**
 * Entry point for the reflow algorithm: takes the current settlement tasks,
 * channels, and trade orders, and produces a valid, constraint-respecting
 * schedule (see README for the full algorithm approach).
 */
export class ReflowService {
  reflow(_input: ReflowInput): ReflowResult {
    // @upgrade Phase 3: DAG build + topological sort, then walk-forward
    // placement per task (dependencies -> channel conflicts -> operating
    // hours -> blackout windows).
    throw new Error("ReflowService.reflow is not implemented yet");
  }
}
