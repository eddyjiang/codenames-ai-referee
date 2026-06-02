import type { BoardState } from "./types";

/** Teams the CV service can classify confidently on its own (by colour). */
const CV_TEAMS = new Set(["red", "blue", "assassin"]);

/**
 * CV track frame merge: keep locked words + stable geometry, and CARRY FORWARD
 * the LLM's last verdict for any cell CV can't positively classify (red/blue/
 * assassin). This keeps an LLM-detected bystander from being reset to unrevealed
 * between periodic LLM reads, while still letting CV flip a cell to red/blue fast
 * when a coloured tile appears.
 */
export function mergeCvTrack(
  result: BoardState,
  existingBoard: BoardState,
  lockedWords: (string | null)[]
): void {
  result.board.forEach((c, i) => {
    c.word = lockedWords[i] ?? c.word ?? null;
    const prev = existingBoard.board[i];
    if (prev?.bbox) c.bbox = prev.bbox;
    if (!c.corners && prev?.corners) c.corners = prev.corners;
    const cvPositive = c.revealed && c.team != null && CV_TEAMS.has(c.team);
    if (!cvPositive && prev) {
      c.team = prev.team;
      c.revealed = prev.revealed;
      c.confidence = prev.confidence;
    }
  });
}

/**
 * Periodic LLM reveal read merge: the LLM owns reveal/team (incl. bystander);
 * keep the locked words and the CV-derived perspective quads (better than the
 * LLM's axis-aligned bboxes).
 */
export function mergeLlmReveal(
  result: BoardState,
  existingBoard: BoardState,
  lockedWords: (string | null)[]
): void {
  result.board.forEach((c, i) => {
    c.word = lockedWords[i] ?? c.word ?? null;
    const prev = existingBoard.board[i];
    if (prev?.corners) c.corners = prev.corners;
    if (!c.bbox && prev?.bbox) c.bbox = prev.bbox;
  });
}
