import Anthropic from "@anthropic-ai/sdk";
import type { BoardState, Env } from "./types";
import { VISION_PROMPT } from "./prompts";
import { selectVisionPlan } from "./vision-plan";
import type { VisionEngine } from "./vision-plan";

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

// ---------------------------------------------------------------------------
// Public entry point
//
// engine "auto" (production): full scans (first frame) → LLM (best OCR, handles
//   perspective/angle); track scans (subsequent frames) → CV service (colour
//   classification, no OCR).
// engine "cv" (pure-CV test): every frame → CV service — full mode (OCR +
//   perspective + colour) until words lock, then track mode. No LLM.
// ---------------------------------------------------------------------------

export async function analyzeFrame(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  env: Env,
  existingBoard?: BoardState,
  engine: VisionEngine = "auto"
): Promise<BoardState> {
  const plan = selectVisionPlan(engine, existingBoard, !!env.CV_SERVICE_URL);

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
        plan.knownWords ?? undefined
      );
      result.captured_at = Date.now();
      // Track mode: keep locked words and a stable bbox; prefer fresh CV corners.
      if (plan.mode === "track" && plan.knownWords && existingBoard) {
        result.board.forEach((c, i) => {
          c.word = plan.knownWords![i] ?? c.word ?? null;
          const locked = existingBoard.board[i];
          if (locked?.bbox) c.bbox = locked.bbox;
          if (!c.corners && locked?.corners) c.corners = locked.corners;
        });
      }
      return result;
    } catch (e) {
      console.error("CV service error:", (e as Error).message);
      // Pure-cv test mode: surface the error so the tester sees what failed.
      if (engine === "cv") throw e;
      // auto track: freeze the existing board (words/bboxes stay put, no flicker)
      // instead of re-OCRing via the LLM.
      if (plan.mode === "track" && existingBoard) {
        existingBoard.captured_at = Date.now();
        return existingBoard;
      }
      // otherwise fall through to the LLM tier below.
    }
  }

  // ── LLM vision (auto full scans; OpenRouter preferred, Anthropic SDK fallback) ──
  let raw: string;
  if (env.OPENROUTER_API_KEY) {
    raw = await analyzeViaOpenRouter(imageBase64, mediaType, env.OPENROUTER_API_KEY);
  } else if (env.ANTHROPIC_API_KEY) {
    raw = await analyzeViaAnthropic(imageBase64, mediaType, env.ANTHROPIC_API_KEY);
  } else {
    throw new Error(
      "No vision backend configured. Set CV_SERVICE_URL, OPENROUTER_API_KEY, or ANTHROPIC_API_KEY."
    );
  }

  const parsed = parseVisionResponse(raw);
  parsed.captured_at = Date.now();
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
