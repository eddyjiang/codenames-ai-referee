import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { analyzeFrame, storeBoardState, getBoardState } from "./vision";
import { validateClue, checkGuessLimit } from "./rules";
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
import { transcribeAudio, parseClueFromTranscript, synthesizeSpeech } from "./voice";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

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
  session.clue_number = null;
  session.clue_word = null;
  session.clues_given = [];
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
  }>();

  if (!body.image) {
    return c.json({ error: "Missing image field" }, 400);
  }

  const mediaType = body.media_type ?? "image/jpeg";

  let boardState;
  try {
    boardState = await analyzeFrame(body.image, mediaType, c.env);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }

  await storeBoardState(sessionId, boardState, c.env.BOARD_KV);

  // Update session board reference
  const session = await getSession(sessionId, c.env.BOARD_KV);
  session.board = boardState;
  await saveSession(session, c.env.BOARD_KV);

  return c.json({
    board: boardState,
    low_confidence: boardState.metadata.overall_confidence < 0.7,
  });
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
    session.clues_given,
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
  if (result.valid) {
    session.clue_word = body.word;
    session.clue_number = body.number;
    session.guesses_this_turn = 0;
    session.clues_given.push(body.word);
    await saveSession(session, c.env.BOARD_KV);
  }

  return c.json(result);
});

// ---------- Voice: Whisper transcription + clue validation ----------

app.post("/api/session/:id/clue/audio", async (c) => {
  const sessionId = c.req.param("id");
  const formData = await c.req.formData();
  const audioFile = formData.get("audio") as File | null;

  if (!audioFile) {
    return c.json({ error: "Missing audio file" }, 400);
  }

  const audioBuffer = await audioFile.arrayBuffer();

  let transcript: string;
  try {
    transcript = await transcribeAudio(audioBuffer, audioFile.name || "clue.webm", c.env.OPENAI_API_KEY);
  } catch (err) {
    return c.json({ error: `Transcription failed: ${String(err)}` }, 500);
  }

  const parsed = parseClueFromTranscript(transcript);
  if (!parsed) {
    return c.json({
      transcript,
      error: "Could not parse a clue word and number from the audio. Please try again.",
    }, 422);
  }

  // Now validate exactly like the text endpoint
  const session = await getSession(sessionId, c.env.BOARD_KV);
  const board = await getBoardState(sessionId, c.env.BOARD_KV);

  if (!board) {
    return c.json({ error: "No board state available" }, 400);
  }

  const result = validateClue(
    parsed.word,
    parsed.number,
    board,
    session.clues_given,
    session.house_rules
  );

  // Build TTS audio if intervention needs to be spoken
  let ttsBase64: string | null = null;
  if (result.message) {
    try {
      const audioData = await synthesizeSpeech(result.message, c.env.OPENAI_API_KEY);
      ttsBase64 = btoa(String.fromCharCode(...new Uint8Array(audioData)));
    } catch {
      // TTS failure is non-fatal; client falls back to text display
    }
  }

  // Persist
  if (session.game_id) {
    const clueId = await logClue(
      session.game_id,
      session.current_team,
      parsed.word,
      parsed.number,
      transcript,
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

  if (result.valid) {
    session.clue_word = parsed.word;
    session.clue_number = parsed.number;
    session.guesses_this_turn = 0;
    session.clues_given.push(parsed.word);
    await saveSession(session, c.env.BOARD_KV);
  }

  return c.json({
    transcript,
    clue: parsed,
    rules: result,
    tts_audio_base64: ttsBase64,
  });
});

// ---------- Guess tracking ----------

app.post("/api/session/:id/guess", async (c) => {
  const sessionId = c.req.param("id");
  const session = await getSession(sessionId, c.env.BOARD_KV);

  if (session.clue_number === null) {
    return c.json({ error: "No active clue" }, 400);
  }

  session.guesses_this_turn++;

  const limitViolation = checkGuessLimit(
    session.guesses_this_turn,
    session.clue_number
  );

  await saveSession(session, c.env.BOARD_KV);

  let ttsBase64: string | null = null;
  if (limitViolation && session.game_id) {
    const message = `That's guess number ${session.guesses_this_turn}. The clue was ${session.clue_number}, so the maximum is ${session.clue_number + 1}. The turn ends here.`;
    try {
      const audioData = await synthesizeSpeech(message, c.env.OPENAI_API_KEY);
      ttsBase64 = btoa(String.fromCharCode(...new Uint8Array(audioData)));
    } catch { /* non-fatal */ }

    await logIntervention(
      session.game_id,
      null,
      "stop",
      "guess_limit_exceeded",
      message,
      1.0,
      c.env
    );
  }

  return c.json({
    guesses_this_turn: session.guesses_this_turn,
    limit: session.clue_number === 99 ? null : session.clue_number + 1,
    violation: limitViolation,
    tts_audio_base64: ttsBase64,
  });
});

// ---------- Turn management ----------

app.post("/api/session/:id/turn/end", async (c) => {
  const session = await getSession(c.req.param("id"), c.env.BOARD_KV);
  session.current_team = session.current_team === "red" ? "blue" : "red";
  session.guesses_this_turn = 0;
  session.clue_number = null;
  session.clue_word = null;
  await saveSession(session, c.env.BOARD_KV);
  return c.json({ current_team: session.current_team });
});

// ---------- Health ----------

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

export default app;
