import type { BoardState } from "./types";

/** Teams the CV service can classify confidently on its own (by colour). */
const CV_TEAMS = new Set(["red", "blue", "assassin"]);

/**
 * CV track frame merge: keep locked words + stable geometry. CV OWNS red/blue/
 * assassin — it both SETS them (sees a coloured tile) and CLEARS them: if CV now
 * reads a cell as tan, there is no coloured tile there, so a stale or false
 * red/blue/assassin reveal is dropped (CV reliably reads a real tile as coloured).
 * Only a previously-detected BYSTANDER is carried forward, since CV can't see
 * bystander tiles — that's the LLM's job.
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

    if (prev?.manual) {
      // User pinned this cell — CV never changes its team/revealed.
      c.team = prev.team;
      c.revealed = prev.revealed;
      c.manual = true;
      c.confidence = prev.confidence;
      return;
    }

    const cvPositive = c.revealed && c.team != null && CV_TEAMS.has(c.team);
    if (cvPositive) return; // CV sees a coloured tile → trust it (set/keep red/blue/assassin)

    // CV reads no colour here: keep ONLY a bystander; let a stale red/blue/assassin
    // fall back to CV's tan reading (unrevealed), which corrects the stuck reveal.
    if (prev?.team === "bystander") {
      c.team = "bystander";
      c.revealed = true;
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
    if (prev?.manual) {
      // User pinned this cell — the LLM never changes its team/revealed.
      c.team = prev.team;
      c.revealed = prev.revealed;
      c.manual = true;
    }
  });
}

/**
 * Background LLM reveal read: apply the LLM's verdict ONTO the latest live board.
 * The LLM OWNS the bystander-vs-unrevealed call (CV can't see bystander; CV owns
 * red/blue/assassin). So here the LLM can both:
 *   - SET a bystander (it sees a bystander tile), and
 *   - CLEAR a stale/false bystander — but only when it reports the cell
 *     UNREVEALED, which it does only when it can actually read the printed word,
 *     so a real *covered* bystander is never wrongly un-revealed.
 * It never applies/removes red/blue/assassin (CV's job) — that avoids a stale LLM
 * frame fighting CV's fresh colours and the resulting flicker.
 */
export function applyRevealRead(
  latest: BoardState,
  llmBoard: BoardState,
  lockedWords: (string | null)[]
): void {
  latest.board.forEach((c, i) => {
    c.word = lockedWords[i] ?? c.word ?? null;
    if (c.manual) return; // user pinned this cell — the LLM never changes it
    const llmCell = llmBoard.board[i];
    if (!llmCell) return;
    if (llmCell.revealed && llmCell.team === "bystander") {
      c.team = "bystander";
      c.revealed = true;
    } else if (!llmCell.revealed && c.team === "bystander") {
      // LLM can read the word here → this was a false bystander; clear it.
      c.team = null;
      c.revealed = false;
    }
    // LLM red/blue/assassin, and LLM-unrevealed over a CV colour, are left to CV.
  });
}
