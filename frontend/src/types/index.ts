export type Team = "red" | "blue";
export type CardTeam = "red" | "blue" | "bystander" | "assassin";
export type InterventionLevel = "none" | "log" | "nudge" | "stop";

export interface BBox {
  x: number; // left edge, 0–1 fraction of image width
  y: number; // top edge,  0–1 fraction of image height
  w: number; // width,     0–1 fraction of image width
  h: number; // height,    0–1 fraction of image height
}

export interface Corner {
  x: number; // 0–1 fraction of image width
  y: number; // 0–1 fraction of image height
}

export interface CardCorners {
  tl: Corner; // top-left
  tr: Corner; // top-right
  br: Corner; // bottom-right
  bl: Corner; // bottom-left
}

export interface CardState {
  position: number;
  word: string | null;
  revealed: boolean;
  team: CardTeam | null;
  confidence: number;
  bbox?: BBox | null;
  corners?: CardCorners | null;
  // Per-cell median HSV + text contrast-depth ratio from the CV classifier (tuning aid).
  debug?: { h: number; s: number; v: number; dr?: number } | null;
  // User-pinned team/revealed: when true, CV and LLM never change this cell.
  manual?: boolean;
}

// A team edit from the card editor. "unrevealed" pins the cell as face-up;
// "auto" releases the pin so CV/LLM resume control.
export type TeamEdit = "red" | "blue" | "bystander" | "assassin" | "unrevealed" | "auto";

export interface BoardState {
  board: CardState[];
  score: {
    red_remaining: number | null;
    blue_remaining: number | null;
    confidence: number;
  };
  metadata: {
    overall_confidence: number;
    issues: string[];
    partial_visibility: boolean;
    notes: string;
  };
  captured_at: number;
  // Timestamp of the last authoritative LLM reveal/team read ("auto" engine).
  llm_at?: number;
}

export interface RuleViolation {
  rule: string;
  description: string;
  confidence: number;
}

export interface RulesResult {
  valid: boolean;
  violations: RuleViolation[];
  intervention_level: InterventionLevel;
  message: string;
  confidence: number;
}

// Board-driven guess tracking: the worker diffs reveals on every board
// mutation and reports the turn's state back with the response.
export interface GuessEvent {
  position: number;
  word: string | null;
  team: CardTeam | null;
  outcome: "correct" | "opponent" | "bystander" | "assassin";
}

export interface GameUpdate {
  current_team: string;
  guesses_this_turn: number;
  limit: number | null;
  events: GuessEvent[];
  /** Referee announcement to speak via browser TTS, if any. */
  message: string | null;
}

export interface SessionState {
  session_id: string;
  game_id: string | null;
  current_team: Team;
  guesses_this_turn: number;
  clue_number: number | null;
  clue_word: string | null;
  board: BoardState | null;
}
