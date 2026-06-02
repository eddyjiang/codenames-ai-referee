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
 * Decide how to process one frame — pure, no I/O, fully unit-testable.
 *
 * - "cv": every frame to the CV service (full until locked, then track). No LLM.
 * - "auto" (production): the LLM reads words on the first scan, then the CV
 *   service tracks colour/perspective fast on most frames — but every
 *   `llmIntervalMs` the LLM does an authoritative reveal/team read, because CV
 *   alone can't tell a bystander tile from an unrevealed word card. CV frames
 *   carry the LLM's last verdict forward (see the merge in analyzeFrame).
 */
export function selectVisionPlan(
  engine: VisionEngine,
  existingBoard: BoardState | undefined,
  caps: { cv: boolean; llm: boolean },
  now = 0,
  lastLlmAt = 0,
  llmIntervalMs: number = LLM_REVEAL_INTERVAL_MS
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
  // Locked: periodic LLM reveal read (authoritative teams incl. bystander), else
  // fast CV track. Also use the LLM if it's due, or if there's no CV service.
  const dueForLlm = now - lastLlmAt >= llmIntervalMs;
  if (caps.llm && (dueForLlm || !caps.cv)) {
    return { backend: "llm", mode: "full", knownWords: lockedWords, reason: "llm-reveal" };
  }
  if (caps.cv) {
    return { backend: "cv", mode: "track", knownWords: lockedWords, reason: "cv-track" };
  }
  // No CV and no LLM is a misconfiguration; analyzeFrame will surface it.
  return { backend: "llm", mode: "full", knownWords: lockedWords, reason: "llm-reveal" };
}
