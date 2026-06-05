import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { analyzeFrame, runBackgroundReveal, storeBoardState, getBoardState, clearBoardState } from "./vision";
import { LLM_REVEAL_INTERVAL_MS } from "./vision-plan";
import { validateClue } from "./rules";
import { trackReveals } from "./guess-tracking";
import {
  getSession,
  saveSession,
  ensureSession,
  createGame,
  logClue,
  logIntervention,
  getGameHistory,
  defaultSession,
} from "./session";
import { parseClue } from "./voice";
import { buildDemoBoard } from "./demo-board";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] }));

// ---------- Session ----------

app.post("/api/session", async (c) => {
  const sessionId = crypto.randomUUID();
  await ensureSession(sessionId, c.env);
  const state = defaultSession(sessionId);
  await saveSession(state, c.env.BOARD_KV);
  return c.json({ session_id: sessionId });
});

app.get("/api/session/:id", async (c) => {
  const session = await getSession(c.req.param("id"), c.env.BOARD_KV);
  return c.json(session);
});

app.post("/api/session/:id/house-rules", async (c) => {
  const session = await getSession(c.req.param("id"), c.env.BOARD_KV);
  const body = await c.req.json<Partial<typeof session.house_rules>>();
  session.house_rules = { ...session.house_rules, ...body };
  await saveSession(session, c.env.BOARD_KV);
  return c.json({ ok: true, house_rules: session.house_rules });
});

// ---------- Game lifecycle ----------

app.post("/api/session/:id/game/start", async (c) => {
  const sessionId = c.req.param("id");
  await ensureSession(sessionId, c.env);

  const board = await getBoardState(sessionId, c.env.BOARD_KV);
  if (!board) {
    return c.json({ error: "No board state captured yet. Point the camera at the board first." }, 400);
  }

  const gameId = await createGame(sessionId, board, c.env);
  const session = await getSession(sessionId, c.env.BOARD_KV);
  session.game_id = gameId;
  session.current_team = "red";
  session.guesses_this_turn = 0;
  session.turn_reveals = [];
  session.clue_number = null;
  session.clue_word = null;
  await saveSession(session, c.env.BOARD_KV);

  return c.json({ game_id: gameId });
});

app.get("/api/session/:id/history", async (c) => {
  const history = await getGameHistory(c.req.param("id"), c.env);
  return c.json(history);
});

// ---------- Vision ----------

app.post("/api/session/:id/frame", async (c) => {
  const sessionId = c.req.param("id");

  const body = await c.req.json<{
    image: string; // base64
    media_type?: "image/jpeg" | "image/png" | "image/webp";
    engine?: "auto" | "cv"; // "cv" forces the CV service end-to-end (test harness)
  }>();

  if (!body.image) {
    return c.json({ error: "Missing image field" }, 400);
  }

  const mediaType = body.media_type ?? "image/jpeg";
  const engine = body.engine ?? "auto";

  const existingBoard = await getBoardState(sessionId, c.env.BOARD_KV);

  let boardState;
  try {
    boardState = await analyzeFrame(body.image, mediaType, c.env, existingBoard ?? undefined, engine);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }

  // Schedule a NON-BLOCKING LLM reveal read (catches bystanders) when due, so the
  // fast CV result returns now and the LLM verdict lands in KV for the next frame.
  const now = Date.now();
  const hasLlm = !!(c.env.OPENROUTER_API_KEY || c.env.ANTHROPIC_API_KEY);
  const locked = boardState.board.some((card) => !!card.word);
  const dueForReveal =
    engine === "auto" &&
    hasLlm &&
    !!c.env.CV_SERVICE_URL &&
    locked &&
    now - (boardState.llm_at ?? 0) >= LLM_REVEAL_INTERVAL_MS;
  if (dueForReveal) {
    boardState.llm_at = now; // mark kicked-off so we don't double-trigger within the interval
  }

  await storeBoardState(sessionId, boardState, c.env.BOARD_KV);

  // Board-driven guess tracking: cards newly revealed while a clue is active
  // are guesses. Also surface any announcement parked by the background
  // reveal read (bystander verdicts land there, between frames).
  const session = await getSession(sessionId, c.env.BOARD_KV);
  const game = trackReveals(session, existingBoard, boardState);
  if (game && !game.message && session.pending_message) {
    game.message = session.pending_message;
  }
  session.pending_message = null;
  session.board = boardState;
  await saveSession(session, c.env.BOARD_KV);

  if (dueForReveal) {
    const lockedWords = boardState.board.map((card) => card.word ?? null);
    c.executionCtx.waitUntil(
      runBackgroundReveal(body.image, mediaType, c.env, sessionId, lockedWords)
    );
  }

  return c.json({
    board: boardState,
    low_confidence: boardState.metadata.overall_confidence < 0.7,
    game,
  });
});

// ---------- Demo board (no camera, no vision-API spend) ----------

app.post("/api/session/:id/board/demo", async (c) => {
  const sessionId = c.req.param("id");
  const boardState = buildDemoBoard();

  await storeBoardState(sessionId, boardState, c.env.BOARD_KV);

  const session = await getSession(sessionId, c.env.BOARD_KV);
  session.board = boardState;
  await saveSession(session, c.env.BOARD_KV);

  return c.json({ board: boardState, low_confidence: false });
});

// ---------- Board reset (force rescan) ----------

app.delete("/api/session/:id/board", async (c) => {
  const sessionId = c.req.param("id");
  await clearBoardState(sessionId, c.env.BOARD_KV);
  const session = await getSession(sessionId, c.env.BOARD_KV);
  session.board = null;
  await saveSession(session, c.env.BOARD_KV);
  return c.json({ ok: true });
});

// ---------- Card word correction ----------

app.patch("/api/session/:id/board/card", async (c) => {
  const sessionId = c.req.param("id");
  const { position, word, team } = await c.req.json<{
    position: number;
    word?: string;
    // "auto" hands the cell back to CV/LLM; the rest pin it against CV/LLM.
    team?: "red" | "blue" | "bystander" | "assassin" | "unrevealed" | "auto";
  }>();
  const board = await getBoardState(sessionId, c.env.BOARD_KV);
  if (!board) return c.json({ error: "No board state" }, 404);
  const cell = board.board[position];
  if (!cell) return c.json({ error: "Invalid position" }, 400);

  const wasRevealed = cell.revealed;

  if (word !== undefined) cell.word = word.toUpperCase().trim() || null;
  if (team !== undefined) {
    if (team === "auto") {
      cell.manual = false; // resume CV/LLM control
    } else if (team === "unrevealed") {
      cell.team = null;
      cell.revealed = false;
      cell.manual = true;
    } else {
      cell.team = team; // red | blue | bystander | assassin
      cell.revealed = true;
      cell.manual = true;
    }
  }

  await storeBoardState(sessionId, board, c.env.BOARD_KV);

  // A manual reveal/un-reveal is a board mutation like any other — it counts
  // toward (or corrects) the current turn's guesses.
  let game = null;
  if (cell.revealed !== wasRevealed) {
    const session = await getSession(sessionId, c.env.BOARD_KV);
    const prev = structuredClone(board);
    prev.board[position].revealed = wasRevealed;
    game = trackReveals(session, prev, board);
    session.board = board;
    await saveSession(session, c.env.BOARD_KV);
  }

  return c.json({ board, game });
});

// ---------- Clue validation (text) ----------

app.post("/api/session/:id/clue", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json<{ word: string; number: number; team?: string }>();

  if (!body.word || body.number === undefined) {
    return c.json({ error: "Missing word or number" }, 400);
  }

  const session = await getSession(sessionId, c.env.BOARD_KV);
  const board = await getBoardState(sessionId, c.env.BOARD_KV);

  if (!board) {
    return c.json({ error: "No board state available" }, 400);
  }

  const result = validateClue(
    body.word,
    body.number,
    board,
    session.house_rules
  );

  // Log to D1 if there's an active game
  if (session.game_id) {
    const clueId = await logClue(
      session.game_id,
      body.team ?? session.current_team,
      body.word,
      body.number,
      null,
      c.env
    );

    if (result.intervention_level !== "none") {
      const primaryViolation = result.violations[0]?.rule ?? "unknown";
      await logIntervention(
        session.game_id,
        clueId,
        result.intervention_level,
        primaryViolation,
        result.message,
        result.confidence,
        c.env
      );
    }
  }

  // Update session state for valid clues
  // The clue stands unless confidently illegal ("stop") — the guessers already
  // heard it, so nudge/log-level clues remain the active clue and play continues.
  if (result.intervention_level !== "stop") {
    session.clue_word = body.word;
    session.clue_number = body.number;
    session.guesses_this_turn = 0;
    session.turn_reveals = [];
    await saveSession(session, c.env.BOARD_KV);
  }

  return c.json(result);
});

// ---------- Voice: browser-STT transcript → LLM parse + clue validation ----------

app.post("/api/session/:id/clue/transcript", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json<{ transcript: string }>();

  if (!body.transcript) {
    return c.json({ error: "Missing transcript" }, 400);
  }

  const parsed = await parseClue(body.transcript, c.env.OPENROUTER_API_KEY);
  if (!parsed) {
    // 200 with a null clue: "no clue heard" is a normal outcome, not an error.
    return c.json({ transcript: body.transcript, clue: null, rules: null });
  }

  // Heard a clue word but no number, and nothing else suspicious — incomplete.
  // Return the partial clue (number: null) so the client can hold the utterance
  // and combine it with the number when it arrives after a pause. (When extra
  // speech is present we proceed anyway: the utterance gets judged regardless.)
  if (parsed.number === null && !parsed.extra) {
    return c.json({
      transcript: body.transcript,
      clue: { word: parsed.word, number: null },
      rules: null,
    });
  }

  // Now validate exactly like the text endpoint
  const session = await getSession(sessionId, c.env.BOARD_KV);
  const board = await getBoardState(sessionId, c.env.BOARD_KV);

  if (!board) {
    return c.json({ error: "No board state available" }, 400);
  }

  const result = validateClue(
    parsed.word,
    parsed.number ?? 1, // number only feeds the zero-clue check; moot here — extra speech forfeits the turn
    board,
    session.house_rules,
    parsed.extra
  );

  // No TTS here — the live-browser path speaks via free client-side speechSynthesis.

  // Persist
  if (session.game_id) {
    const clueId = await logClue(
      session.game_id,
      session.current_team,
      parsed.word,
      parsed.number ?? 0,
      body.transcript,
      c.env
    );
    if (result.intervention_level !== "none") {
      await logIntervention(
        session.game_id,
        clueId,
        result.intervention_level,
        result.violations[0]?.rule ?? "unknown",
        result.message,
        result.confidence,
        c.env
      );
    }
  }

  // Same as /clue: anything short of a "stop" verdict stands as the active clue.
  // (A null number can't reach here without a stop — see the incomplete gate above.)
  if (result.intervention_level !== "stop" && parsed.number !== null) {
    session.clue_word = parsed.word;
    session.clue_number = parsed.number;
    session.guesses_this_turn = 0;
    session.turn_reveals = [];
    await saveSession(session, c.env.BOARD_KV);
  }

  return c.json({
    transcript: body.transcript,
    clue: { word: parsed.word, number: parsed.number },
    rules: result,
  });
});

// ---------- Turn management ----------

app.post("/api/session/:id/turn/end", async (c) => {
  const session = await getSession(c.req.param("id"), c.env.BOARD_KV);

  // Official rules: the team must make at least one guess per clue. The
  // referee announces the violation but still passes the turn — humans rule.
  let message: string | null = null;
  if (session.clue_number !== null && (session.turn_reveals ?? []).length === 0) {
    message = "Heads up — the rules require at least one guess per clue.";
    if (session.game_id) {
      await logIntervention(session.game_id, null, "nudge", "no_guess_made", message, 0.9, c.env);
    }
  }

  session.current_team = session.current_team === "red" ? "blue" : "red";
  session.guesses_this_turn = 0;
  session.turn_reveals = [];
  session.clue_number = null;
  session.clue_word = null;
  await saveSession(session, c.env.BOARD_KV);
  return c.json({ current_team: session.current_team, message });
});

// ---------- Health ----------

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

export default app;
