import type { BoardState, CardTeam, SessionState } from "./types";
import { checkGuessLimit } from "./rules";

// ---------------------------------------------------------------------------
// Board-driven guess tracking — guesses are inferred from card reveals, not a
// button. A card transitioning unrevealed → revealed while a clue is active IS
// a guess; the reveal's team tells the referee the outcome. Reveal positions
// (not a bare counter) are tracked per turn so vision flicker self-corrects:
// a false reveal that later un-reveals drops back out of the count.
// The referee announces outcomes but never auto-ends the turn — humans do.
// ---------------------------------------------------------------------------

export type GuessOutcome = "correct" | "opponent" | "bystander" | "assassin";

export interface GuessEvent {
  position: number;
  word: string | null;
  team: CardTeam | null;
  outcome: GuessOutcome;
}

export interface GameUpdate {
  current_team: string;
  guesses_this_turn: number;
  limit: number | null;
  events: GuessEvent[];
  /** Referee announcement for the client to speak (browser TTS), if any. */
  message: string | null;
}

function outcomeFor(team: CardTeam | null, currentTeam: string): GuessOutcome {
  if (team === "assassin") return "assassin";
  if (team === "bystander") return "bystander";
  return team === currentTeam ? "correct" : "opponent";
}

function announce(
  event: GuessEvent,
  guesses: number,
  clueNumber: number,
  limit: number | null
): string | null {
  const word = event.word ?? "that card";
  switch (event.outcome) {
    case "assassin":
      return `${word} is the assassin. The game is over.`;
    case "bystander":
      return `${word} is a bystander. The turn should end.`;
    case "opponent":
      return `${word} belongs to the other team. The turn should end.`;
    case "correct":
      if (limit === null) return null; // unlimited clue — nothing to count down
      if (guesses >= limit) {
        return `That's the limit — the clue was ${clueNumber}, so the turn should end.`;
      }
      if (guesses === clueNumber) {
        return `That's ${guesses} of ${clueNumber} — you're allowed one extra guess.`;
      }
      return null;
  }
}

/**
 * Diff reveals between the previous and next board and fold them into the
 * session's per-turn reveal list. Mutates `session` (turn_reveals,
 * guesses_this_turn); caller persists. Returns a GameUpdate for the client,
 * or null when no clue is active (reveals outside a turn aren't guesses —
 * e.g. board-setup corrections).
 */
export function trackReveals(
  session: SessionState,
  prevBoard: BoardState | null,
  nextBoard: BoardState
): GameUpdate | null {
  if (session.clue_number === null) return null;

  const reveals = new Set(session.turn_reveals ?? []);
  const events: GuessEvent[] = [];

  nextBoard.board.forEach((cell, i) => {
    const wasRevealed = prevBoard?.board[i]?.revealed ?? false;
    if (cell.revealed && !wasRevealed && !reveals.has(i)) {
      reveals.add(i);
      events.push({
        position: i,
        word: cell.word,
        team: cell.team,
        outcome: outcomeFor(cell.team, session.current_team),
      });
    } else if (!cell.revealed && wasRevealed) {
      // Vision flicker or a manual correction — this reveal never happened.
      reveals.delete(i);
    }
  });

  session.turn_reveals = [...reveals];
  session.guesses_this_turn = reveals.size;

  const limitViolation = checkGuessLimit(session.guesses_this_turn, session.clue_number);
  const limit = session.clue_number === 99 ? null : session.clue_number + 1;

  const lastEvent = events.at(-1);
  const message = lastEvent
    ? announce(lastEvent, session.guesses_this_turn, session.clue_number, limit)
    : null;

  return {
    current_team: session.current_team,
    guesses_this_turn: session.guesses_this_turn,
    limit,
    events,
    message:
      limitViolation && lastEvent
        ? `That's guess ${session.guesses_this_turn} — the clue was ${session.clue_number}, so the maximum is ${limit}. The turn should end.`
        : message,
  };
}
