import type { SessionState, HouseRules, BoardState, Env } from "./types";

const DEFAULT_HOUSE_RULES: HouseRules = {
  allow_proper_nouns: false,
  allow_compound_parts: false,
  unlimited_guesses: false,
  zero_clue_forbidden: false,
};

export function defaultSession(sessionId: string): SessionState {
  return {
    session_id: sessionId,
    game_id: null,
    current_team: "red",
    guesses_this_turn: 0,
    clue_number: null,
    clue_word: null,
    clues_given: [],
    board: null,
    house_rules: { ...DEFAULT_HOUSE_RULES },
  };
}

export async function getSession(
  sessionId: string,
  kv: KVNamespace
): Promise<SessionState> {
  const raw = await kv.get(`session:${sessionId}`);
  if (!raw) return defaultSession(sessionId);
  return JSON.parse(raw) as SessionState;
}

export async function saveSession(
  state: SessionState,
  kv: KVNamespace
): Promise<void> {
  await kv.put(`session:${state.session_id}`, JSON.stringify(state), {
    expirationTtl: 86400,
  });
}

// ---------- D1 persistence ----------

export async function ensureSession(
  sessionId: string,
  env: Env
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sessions (id, created_at, updated_at, house_rules)
     VALUES (?, ?, ?, ?)`
  )
    .bind(sessionId, now, now, "{}")
    .run();
}

export async function createGame(
  sessionId: string,
  boardSnapshot: BoardState,
  env: Env
): Promise<string> {
  const gameId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO games (id, session_id, started_at, board_snapshot)
     VALUES (?, ?, ?, ?)`
  )
    .bind(gameId, sessionId, now, JSON.stringify(boardSnapshot))
    .run();
  return gameId;
}

export async function logClue(
  gameId: string,
  team: string,
  word: string,
  number: number,
  transcript: string | null,
  env: Env
): Promise<string> {
  const clueId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO clues (id, game_id, team, word, number, given_at, transcript)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(clueId, gameId, team, word, number, Date.now(), transcript)
    .run();
  return clueId;
}

export async function logIntervention(
  gameId: string,
  clueId: string | null,
  level: string,
  ruleViolated: string,
  message: string,
  confidence: number,
  env: Env
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO interventions (id, game_id, clue_id, level, rule_violated, message, confidence, fired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      gameId,
      clueId,
      level,
      ruleViolated,
      message,
      confidence,
      Date.now()
    )
    .run();
}

export async function getGameHistory(
  sessionId: string,
  env: Env
): Promise<unknown> {
  const games = await env.DB.prepare(
    `SELECT g.id, g.started_at, g.ended_at, g.outcome,
            COUNT(DISTINCT c.id) as clue_count,
            COUNT(DISTINCT i.id) as intervention_count
     FROM games g
     LEFT JOIN clues c ON c.game_id = g.id
     LEFT JOIN interventions i ON i.game_id = g.id
     WHERE g.session_id = ?
     GROUP BY g.id
     ORDER BY g.started_at DESC
     LIMIT 20`
  )
    .bind(sessionId)
    .all();

  return games.results;
}
