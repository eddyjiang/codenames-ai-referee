import Anthropic from "@anthropic-ai/sdk";
import type { BoardState, Env } from "./types";
import { VISION_PROMPT } from "./prompts";

// OpenRouter uses the OpenAI chat completions format with base64 image_url.
// Model name: check https://openrouter.ai/models — filter by "vision" + "claude".
// At time of writing: "anthropic/claude-sonnet-4-5" or "anthropic/claude-3-5-sonnet"
const OPENROUTER_MODEL = "anthropic/claude-sonnet-4-5";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

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
      max_tokens: 2048,
      messages: [
        {
          role: "system",
          content: VISION_PROMPT,
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${mediaType};base64,${imageBase64}`,
              },
            },
            {
              type: "text",
              text: "Analyze this Codenames board and return the JSON board state.",
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
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
    max_tokens: 2048,
    system: VISION_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageBase64 },
          },
          {
            type: "text",
            text: "Analyze this Codenames board and return the JSON board state.",
          },
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

export async function analyzeFrame(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  env: Env
): Promise<BoardState> {
  let raw: string;

  if (env.OPENROUTER_API_KEY) {
    raw = await analyzeViaOpenRouter(imageBase64, mediaType, env.OPENROUTER_API_KEY);
  } else if (env.ANTHROPIC_API_KEY) {
    raw = await analyzeViaAnthropic(imageBase64, mediaType, env.ANTHROPIC_API_KEY);
  } else {
    throw new Error("No vision API key configured. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY in worker/.dev.vars");
  }

  const parsed = parseVisionResponse(raw);
  parsed.captured_at = Date.now();
  return parsed;
}

export async function storeBoardState(
  sessionId: string,
  state: BoardState,
  kv: KVNamespace
): Promise<void> {
  await kv.put(`board:${sessionId}`, JSON.stringify(state), {
    expirationTtl: 86400,
  });
}

export async function getBoardState(
  sessionId: string,
  kv: KVNamespace
): Promise<BoardState | null> {
  const raw = await kv.get(`board:${sessionId}`);
  if (!raw) return null;
  return JSON.parse(raw) as BoardState;
}
