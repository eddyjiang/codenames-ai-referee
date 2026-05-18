export type Team = "red" | "blue";
export type CardTeam = "red" | "blue" | "bystander" | "assassin";
export type InterventionLevel = "none" | "log" | "nudge" | "stop";

export interface CardState {
  position: number; // 0–24, row-major
  word: string | null;
  revealed: boolean;
  team: CardTeam | null;
  confidence: number;
}

export interface BoardScore {
  red_remaining: number | null;
  blue_remaining: number | null;
  confidence: number;
}

export interface BoardMetadata {
  overall_confidence: number;
  issues: string[];
  partial_visibility: boolean;
  notes: string;
}

export interface BoardState {
  board: CardState[];
  score: BoardScore;
  metadata: BoardMetadata;
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
  clues_given: string[]; // track for repeat-clue rule
  board: BoardState | null;
  house_rules: HouseRules;
}

export interface HouseRules {
  allow_proper_nouns: boolean;
  allow_compound_parts: boolean;
  unlimited_guesses: boolean;
  zero_clue_forbidden: boolean;
}

export interface Env {
  BOARD_KV: KVNamespace;
  DB: D1Database;
  // Vision: set OPENROUTER_API_KEY (takes priority) or ANTHROPIC_API_KEY
  OPENROUTER_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  // Voice: optional — voice I/O degrades gracefully without it
  OPENAI_API_KEY: string;
  ENVIRONMENT: string;
}
