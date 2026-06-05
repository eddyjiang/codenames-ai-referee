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
  tl: Corner;
  tr: Corner;
  br: Corner;
  bl: Corner;
}

export interface CardState {
  position: number; // 0–24, row-major
  word: string | null;
  revealed: boolean;
  team: CardTeam | null;
  confidence: number;
  bbox?: BBox | null;
  corners?: CardCorners | null;
  // Per-cell median HSV + text contrast-depth ratio from the CV classifier (passes through).
  debug?: { h: number; s: number; v: number; dr?: number } | null;
  // User-pinned team/revealed: when true, CV and LLM never change this cell.
  manual?: boolean;
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

export interface SessionState {
  session_id: string;
  game_id: string | null;
  current_team: Team;
  guesses_this_turn: number;
  /** Positions revealed during the current clue — guesses are board-driven. */
  turn_reveals?: number[];
  /** Referee announcement from the background reveal read, spoken on the next frame. */
  pending_message?: string | null;
  clue_number: number | null;
  clue_word: string | null;
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
  // Tier 1: dedicated CV service on DigitalOcean (fast, cheap, precise bboxes)
  CV_SERVICE_URL: string;   // e.g. https://cv-service-xxxxx.ondigitalocean.app
  CV_API_SECRET: string;    // shared secret with the CV service
  // Tier 2 fallback: LLM vision via OpenRouter or Anthropic SDK
  OPENROUTER_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  ENVIRONMENT: string;
}
