import Anthropic from "@anthropic-ai/sdk";
import type { BoardState, Env } from "./types";
import { VISION_PROMPT } from "./prompts";
import { selectVisionPlan } from "./vision-plan";
import type { VisionEngine } from "./vision-plan";
import { mergeCvTrack, mergeLlmReveal, applyRevealRead } from "./vision-merge";
import { trackReveals } from "./guess-tracking";
import { getSession, saveSession } from "./session";

const OPENROUTER_MODEL = "anthropic/claude-sonnet-4-5";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// ---------------------------------------------------------------------------
// Tier 1: dedicated CV service (DigitalOcean)
// ---------------------------------------------------------------------------

async function analyzeViaCVService(
  imageBase64: string,
  serviceUrl: string,
  apiSecret: string,
  mode: "full" | "track" = "full",
  knownWords?: (string | null)[]
): Promise<BoardState> {
  const res = await fetch(`${serviceUrl}/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Secret": apiSecret,
    },
    body: JSON.stringify({
      image_base64: imageBase64,
      media_type: "image/jpeg",
      mode,
      known_words: knownWords ?? null,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CV service ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json() as Promise<BoardState>;
}

// ---------------------------------------------------------------------------
// Tier 2: LLM vision fallback (OpenRouter → Anthropic SDK)
// ---------------------------------------------------------------------------

async function analyzeViaOpenRouter(
  imageBase64: string,
  mediaType: string,
  apiKey: string
): Promise<string> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://codenames-rules-guy.workers.dev",
      "X-Title": "Codenames AI Referee",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: 3500,
      messages: [
        { role: "system", content: VISION_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mediaType};base64,${imageBase64}` },
            },
            { type: "text", text: "Analyze this Codenames board and return the JSON board state." },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? "";
}

async function analyzeViaAnthropic(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  apiKey: string
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 3500,
    system: VISION_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: "Analyze this Codenames board and return the JSON board state." },
        ],
      },
    ],
  });
  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}

function parseVisionResponse(raw: string): BoardState {
  const clean = raw
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  try {
    return JSON.parse(clean) as BoardState;
  } catch {
    throw new Error(`Vision model returned invalid JSON: ${clean.slice(0, 200)}`);
  }
}

async function llmVisionRaw(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  env: Env
): Promise<string> {
  if (env.OPENROUTER_API_KEY) {
    return analyzeViaOpenRouter(imageBase64, mediaType, env.OPENROUTER_API_KEY);
  }
  if (env.ANTHROPIC_API_KEY) {
    return analyzeViaAnthropic(imageBase64, mediaType, env.ANTHROPIC_API_KEY);
  }
  throw new Error(
    "No vision backend configured. Set CV_SERVICE_URL, OPENROUTER_API_KEY, or ANTHROPIC_API_KEY."
  );
}

// ---------------------------------------------------------------------------
// Public entry point — the SYNCHRONOUS result (always fast in "auto"):
//   "auto": LLM reads words on the first scan, then CV track every locked frame
//     (perspective + red/blue/assassin). The authoritative LLM reveal read that
//     catches bystanders runs in the BACKGROUND (runBackgroundReveal, scheduled
//     from the /frame handler) so this path never blocks on the LLM.
//   "cv": every frame → CV service. No LLM, so bystanders are parked as
//     unrevealed — the limitation we proved.
// ---------------------------------------------------------------------------

export async function analyzeFrame(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  env: Env,
  existingBoard?: BoardState,
  engine: VisionEngine = "auto"
): Promise<BoardState> {
  const now = Date.now();
  const caps = {
    cv: !!env.CV_SERVICE_URL,
    llm: !!(env.OPENROUTER_API_KEY || env.ANTHROPIC_API_KEY),
  };
  const lastLlmAt = existingBoard?.llm_at ?? 0;
  const plan = selectVisionPlan(engine, existingBoard, caps);
  const lockedWords = plan.knownWords;

  // ── CV service backend (track for auto; full + track for pure-cv) ──
  if (plan.backend === "cv") {
    if (!env.CV_SERVICE_URL) {
      throw new Error("CV engine requested but CV_SERVICE_URL is not configured.");
    }
    try {
      const result = await analyzeViaCVService(
        imageBase64,
        env.CV_SERVICE_URL,
        env.CV_API_SECRET ?? "",
        plan.mode,
        lockedWords ?? undefined
      );
      result.captured_at = now;
      result.llm_at = lastLlmAt; // CV doesn't refresh the LLM clock
      if (plan.mode === "track" && lockedWords && existingBoard) {
        mergeCvTrack(result, existingBoard, lockedWords);
      }
      return result;
    } catch (e) {
      console.error("CV service error:", (e as Error).message);
      if (engine === "cv") throw e; // pure-cv test: surface the error
      // auto track: freeze the existing board instead of re-OCRing via the LLM.
      if (plan.mode === "track" && existingBoard) {
        existingBoard.captured_at = now;
        return existingBoard;
      }
      // otherwise fall through to the LLM tier below.
    }
  }

  // ── LLM vision (first scan, periodic reveal read, or fallback) ──
  const raw = await llmVisionRaw(imageBase64, mediaType, env);
  const parsed = parseVisionResponse(raw);
  parsed.captured_at = now;
  parsed.llm_at = now;
  if (!parsed.metadata) {
    parsed.metadata = { overall_confidence: 0.8, issues: [], partial_visibility: false, notes: "" };
  }
  parsed.metadata.notes = `llm:${plan.reason === "llm-reveal" ? "reveal" : "full"}`;
  // Periodic reveal read: LLM owns teams/reveal; keep locked words + CV geometry.
  if (plan.reason === "llm-reveal" && lockedWords && existingBoard) {
    mergeLlmReveal(parsed, existingBoard, lockedWords);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// KV helpers (unchanged)
// ---------------------------------------------------------------------------

export async function storeBoardState(
  sessionId: string,
  state: BoardState,
  kv: KVNamespace
): Promise<void> {
  await kv.put(`board:${sessionId}`, JSON.stringify(state), { expirationTtl: 86400 });
}

export async function getBoardState(
  sessionId: string,
  kv: KVNamespace
): Promise<BoardState | null> {
  const raw = await kv.get(`board:${sessionId}`);
  if (!raw) return null;
  return JSON.parse(raw) as BoardState;
}

export async function clearBoardState(sessionId: string, kv: KVNamespace): Promise<void> {
  await kv.delete(`board:${sessionId}`);
}

// ---------------------------------------------------------------------------
// Background LLM reveal read ("auto" mode)
//
// Scheduled from the /frame handler via ctx.waitUntil so the frame response is
// never blocked by the ~2–4s LLM call. It reads the frame's image, then merges
// the LLM's reveal/team verdict (the value-add being bystanders) ONTO the latest
// live board in KV — so the next CV frame picks it up. Never un-reveals a card,
// so a fresh CV red/blue isn't reverted by a slightly-older LLM frame.
// ---------------------------------------------------------------------------

export async function runBackgroundReveal(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  env: Env,
  sessionId: string,
  lockedWords: (string | null)[]
): Promise<void> {
  try {
    const raw = await llmVisionRaw(imageBase64, mediaType, env);
    const llmBoard = parseVisionResponse(raw);
    const latest = await getBoardState(sessionId, env.BOARD_KV);
    if (!latest) return; // board was reset while we were reading; drop this result
    const prev = structuredClone(latest); // applyRevealRead mutates in place
    applyRevealRead(latest, llmBoard, lockedWords);
    latest.llm_at = Date.now();
    if (latest.metadata) latest.metadata.notes = "llm:reveal(bg)";
    await storeBoardState(sessionId, latest, env.BOARD_KV);

    // Reveals landing here (bystanders especially) are guesses too. There's no
    // response to attach the announcement to, so park it on the session — the
    // next /frame response picks it up and the client speaks it.
    const session = await getSession(sessionId, env.BOARD_KV);
    const game = trackReveals(session, prev, latest);
    if (game?.message) session.pending_message = game.message;
    session.board = latest;
    await saveSession(session, env.BOARD_KV);
  } catch (e) {
    console.error("background reveal failed:", (e as Error).message);
  }
}
