import Anthropic from "@anthropic-ai/sdk";
import type { BoardState, Env } from "./types";
import { VISION_PROMPT } from "./prompts";

const OPENROUTER_MODEL = "anthropic/claude-sonnet-4-5";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// Minimum quality bar to accept a CV service result without LLM fallback
const CV_MIN_CONFIDENCE = 0.72;
const CV_MIN_WORDS = 20;

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
// Public entry point — tries CV service first, falls back to LLM
// ---------------------------------------------------------------------------

export async function analyzeFrame(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  env: Env,
  existingBoard?: BoardState
): Promise<BoardState> {
  // Use track mode if we already have a locked board with ≥20 words
  const lockedWords = existingBoard?.board.map((c) => c.word ?? null) ?? null;
  const lockedWordCount = lockedWords?.filter(Boolean).length ?? 0;
  const useTrack = lockedWordCount >= CV_MIN_WORDS;

  // Tier 1: fast dedicated CV service
  if (env.CV_SERVICE_URL) {
    try {
      const result = await analyzeViaCVService(
        imageBase64,
        env.CV_SERVICE_URL,
        env.CV_API_SECRET ?? "",
        useTrack ? "track" : "full",
        useTrack ? lockedWords! : undefined
      );
      // Track mode: always accept (color-only is reliable); full mode: quality threshold
      if (useTrack || (result.metadata.overall_confidence >= CV_MIN_CONFIDENCE && result.board.filter((c) => c.word).length >= CV_MIN_WORDS)) {
        result.captured_at = Date.now();
        // Carry locked words forward so they're never lost
        if (useTrack && lockedWords) {
          result.board.forEach((c, i) => { c.word = lockedWords[i] ?? c.word ?? null; });
        }
        return result;
      }
      console.log(
        `CV service below threshold (conf=${result.metadata.overall_confidence}, words=${result.board.filter((c) => c.word).length}) — falling back to LLM`
      );
    } catch (e) {
      console.error("CV service unavailable, falling back to LLM:", (e as Error).message);
    }
  }

  // Tier 2: LLM vision (OpenRouter preferred, Anthropic SDK as final fallback)
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
