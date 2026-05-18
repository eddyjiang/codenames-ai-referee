-- Sessions: one per game group/device
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  house_rules TEXT DEFAULT '{}' -- JSON blob for custom rule overrides
);

-- Games: one session can have multiple games
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT, -- 'red_win' | 'blue_win' | 'abandoned'
  board_snapshot TEXT NOT NULL DEFAULT '{}', -- final board state JSON
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Clues: every spymaster clue spoken during a game
CREATE TABLE IF NOT EXISTS clues (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  team TEXT NOT NULL, -- 'red' | 'blue'
  word TEXT NOT NULL,
  number INTEGER NOT NULL,
  given_at INTEGER NOT NULL,
  transcript TEXT, -- raw Whisper output
  FOREIGN KEY (game_id) REFERENCES games(id)
);

-- Interventions: every time the referee spoke up
CREATE TABLE IF NOT EXISTS interventions (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  clue_id TEXT,
  level TEXT NOT NULL, -- 'log' | 'nudge' | 'stop'
  rule_violated TEXT NOT NULL,
  message TEXT NOT NULL,
  confidence REAL NOT NULL,
  fired_at INTEGER NOT NULL,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (clue_id) REFERENCES clues(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_games_session ON games(session_id);
CREATE INDEX IF NOT EXISTS idx_clues_game ON clues(game_id);
CREATE INDEX IF NOT EXISTS idx_interventions_game ON interventions(game_id);
