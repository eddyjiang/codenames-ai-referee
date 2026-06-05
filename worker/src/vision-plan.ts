import type { BoardState } from "./types";

/** Which vision backend to drive a frame through. */
export type VisionEngine = "auto" | "cv";

export interface VisionPlan {
  /** Which backend should handle this frame. */
  backend: "cv" | "llm";
  /** CV service mode (ignored when backend === "llm"). */
  mode: "full" | "track";
  /** Locked words to pass through; null for a fresh full scan. */
  knownWords: (string | null)[] | null;
  /** Why this plan was chosen (drives merge behaviour + diagnostics). */
  reason: "first-scan" | "cv-track" | "llm-reveal" | "cv-full";
}

/** Lock words after any scan that produced ≥ 1 word. */
export const LOCK_THRESHOLD = 1;

/** How often "auto" re-runs the LLM for an authoritative reveal/team read. */
export const LLM_REVEAL_INTERVAL_MS = 9_000;

/**
 * Decide the SYNCHRONOUS backend for one frame — pure, no I/O, unit-testable.
 *
 * - "cv": every frame to the CV service (full until locked, then track). No LLM.
 * - "auto" (production): the LLM reads words on the first scan, then fast CV track
 *   on every locked frame (perspective + red/blue/assassin). The authoritative
 *   LLM reveal read (which catches bystanders) is NOT chosen here — it runs in the
 *   BACKGROUND from the /frame handler, so the sync path never blocks on the LLM.
 *   Only when there's no CV service does the sync path fall back to LLM per frame.
 */
export function selectVisionPlan(
  engine: VisionEngine,
  existingBoard: BoardState | undefined,
  caps: { cv: boolean; llm: boolean }
): VisionPlan {
  const lockedWords = existingBoard?.board.map((c) => c.word ?? null) ?? null;
  const useTrack = (lockedWords?.filter(Boolean).length ?? 0) >= LOCK_THRESHOLD;

  if (engine === "cv") {
    return {
      backend: "cv",
      mode: useTrack ? "track" : "full",
      knownWords: useTrack ? lockedWords : null,
      reason: useTrack ? "cv-track" : "cv-full",
    };
  }

  // ── auto ──
  if (!useTrack) {
    return { backend: "llm", mode: "full", knownWords: null, reason: "first-scan" };
  }
  if (caps.cv) {
    return { backend: "cv", mode: "track", knownWords: lockedWords, reason: "cv-track" };
  }
  // No CV service: fall back to a (blocking) LLM read every locked frame.
  return { backend: "llm", mode: "full", knownWords: lockedWords, reason: "llm-reveal" };
}
