import type { BoardState } from "./types";

/** Which vision backend to drive a frame through. */
export type VisionEngine = "auto" | "cv";

export interface VisionPlan {
  /** Which backend should handle this frame. */
  backend: "cv" | "llm";
  /** CV service mode (ignored when backend === "llm"). */
  mode: "full" | "track";
  /** Locked words passed to CV track mode; null for full scans. */
  knownWords: (string | null)[] | null;
}

/** Lock words after any scan that produced ≥ 1 word. */
export const LOCK_THRESHOLD = 1;

/**
 * Decide how to process one frame — pure, no I/O, fully unit-testable.
 *
 * - "auto" (production): the LLM reads words on the first/full scan (best OCR),
 *   then the CV service tracks colour/reveal on subsequent frames.
 * - "cv" (pure-CV test): every frame goes to the CV service — full mode
 *   (OCR + perspective + colour) until words are locked, then track mode.
 */
export function selectVisionPlan(
  engine: VisionEngine,
  existingBoard: BoardState | undefined,
  hasCVService: boolean
): VisionPlan {
  const lockedWords = existingBoard?.board.map((c) => c.word ?? null) ?? null;
  const lockedWordCount = lockedWords?.filter(Boolean).length ?? 0;
  const useTrack = lockedWordCount >= LOCK_THRESHOLD;

  if (engine === "cv") {
    return {
      backend: "cv",
      mode: useTrack ? "track" : "full",
      knownWords: useTrack ? lockedWords : null,
    };
  }

  // auto: CV service handles track-mode colour only; LLM handles full OCR scans.
  if (hasCVService && useTrack) {
    return { backend: "cv", mode: "track", knownWords: lockedWords };
  }
  return { backend: "llm", mode: "full", knownWords: null };
}
