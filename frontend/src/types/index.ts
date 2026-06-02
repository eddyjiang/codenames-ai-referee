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
  // Per-cell median HSV + text-ink fraction from the CV classifier (tuning aid).
  debug?: { h: number; s: number; v: number; ink?: number } | null;
}

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

export interface SessionState {
  session_id: string;
  game_id: string | null;
  current_team: Team;
  guesses_this_turn: number;
  clue_number: number | null;
  clue_word: string | null;
  clues_given: string[];
  board: BoardState | null;
}
