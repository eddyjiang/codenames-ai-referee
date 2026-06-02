#!/usr/bin/env node
/**
 * Standalone vision test — no Worker, no Cloudflare needed.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... node scripts/test-vision.mjs path/to/board.jpg
 *
 * Or with an Anthropic key:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/test-vision.mjs path/to/board.jpg
 *
 * Optional second arg: OpenRouter model name (default: anthropic/claude-sonnet-4-5)
 *   node scripts/test-vision.mjs board.jpg anthropic/claude-3-5-sonnet
 */

import { readFileSync, existsSync } from "fs";
import { extname } from "path";

const VISION_PROMPT = `You are a precise board game vision system. Your sole job is to analyze images of a Codenames board and return structured JSON describing exactly what you observe.

A Codenames board is a 5×5 grid of 25 cards. An UNREVEALED card shows a printed English WORD (all caps, dark text) on a light cream/off-white face (≈#e5e0cc). A REVEALED card is covered by an illustrated agent card, identified by its dominant BACKGROUND colour: warm RED ≈#d35a3e (red team), saturated BLUE ≈#517ebd (blue team), NEUTRAL GRAY ≈#bdbbb3 with a sepia figure (innocent bystander — gray, NOT tan/beige, NOT blue, NOT the assassin), near-BLACK (assassin). Judge team by the background colour, ignoring colours inside the figure; a gray card with an ordinary person is the bystander.

Return ONLY valid JSON — no prose, no markdown fences — matching this exact schema:
{
  "board": [
    { "position": 0, "word": "WORD", "revealed": false, "team": null, "confidence": 0.97 }
  ],
  "score": { "red_remaining": null, "blue_remaining": null, "confidence": 0.0 },
  "metadata": { "overall_confidence": 0.95, "issues": [], "partial_visibility": false, "notes": "" }
}

Rules:
- board: exactly 25 objects, position 0 (top-left) to 24 (bottom-right), row-major.
- word: uppercase string as printed; null if unreadable.
- revealed: true if covered by colored tile, false if face-up word card.
- team: "red" | "blue" | "bystander" | "assassin" | null (null if unrevealed or uncertain).
- confidence: per-card float 0.0–1.0.
- Never guess a word you cannot see at least 60% of — use null.
- Shadows do not make a card revealed.`;

const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function loadImage(imagePath) {
  if (!existsSync(imagePath)) {
    console.error(`❌  File not found: ${imagePath}`);
    process.exit(1);
  }
  const ext = extname(imagePath).toLowerCase();
  const mediaType = MIME_TYPES[ext];
  if (!mediaType) {
    console.error(`❌  Unsupported format: ${ext}. Use .jpg, .png, or .webp`);
    process.exit(1);
  }
  const data = readFileSync(imagePath);
  return { base64: data.toString("base64"), mediaType };
}

async function callOpenRouter(base64, mediaType, apiKey, model) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://codenames-rules-guy.local",
      "X-Title": "Codenames AI Referee - test",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [
        { role: "system", content: VISION_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mediaType};base64,${base64}` },
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
    throw new Error(`OpenRouter ${res.status}: ${err.slice(0, 400)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(base64, mediaType, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: VISION_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
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
    throw new Error(`Anthropic API ${res.status}: ${err.slice(0, 400)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

function printBoardSummary(boardState) {
  const { board, score, metadata } = boardState;

  console.log(`\n📊 Overall confidence: ${(metadata.overall_confidence * 100).toFixed(0)}%`);
  if (metadata.partial_visibility) console.log("⚠️  Partial visibility detected");
  if (metadata.issues.length > 0) {
    console.log("⚠️  Issues:", metadata.issues.join("; "));
  }
  if (metadata.notes) console.log("📝 Notes:", metadata.notes);

  // Score
  if (score.red_remaining !== null || score.blue_remaining !== null) {
    console.log(
      `🔴 Red remaining: ${score.red_remaining ?? "?"}  🔵 Blue remaining: ${score.blue_remaining ?? "?"}`
    );
  }

  // Board grid
  console.log("\n📋 Board (5×5):\n");
  const TEAM_SYMBOL = { red: "🔴", blue: "🔵", bystander: "🟡", assassin: "⬛" };
  const rows = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) {
      const card = board[r * 5 + c];
      const sym = card.revealed && card.team ? TEAM_SYMBOL[card.team] : "⬜";
      const word = (card.word ?? "?????").padEnd(12);
      const conf = card.confidence < 0.7 ? ` [${(card.confidence * 100).toFixed(0)}%?]` : "";
      row.push(`${sym} ${word}${conf}`);
    }
    rows.push(row.join("  "));
  }
  console.log(rows.join("\n"));

  // Stats
  const revealed = board.filter((c) => c.revealed).length;
  const missing = board.filter((c) => !c.word).length;
  const lowConf = board.filter((c) => c.confidence < 0.7).length;
  console.log(
    `\n${board.length} cards total  |  ${revealed} revealed  |  ${missing} unreadable  |  ${lowConf} low-confidence`
  );
}

// ——— main ———

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("Usage: node scripts/test-vision.mjs <image-path> [openrouter-model]");
  console.log("       OPENROUTER_API_KEY=... or ANTHROPIC_API_KEY=... must be set.");
  process.exit(1);
}

const imagePath = args[0];
const model = args[1] ?? "anthropic/claude-sonnet-4-5";

const openrouterKey = process.env.OPENROUTER_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;

if (!openrouterKey && !anthropicKey) {
  console.error("❌  Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY as an environment variable.");
  process.exit(1);
}

console.log(`🔍 Analyzing: ${imagePath}`);
if (openrouterKey) {
  console.log(`🤖 Via OpenRouter — model: ${model}`);
} else {
  console.log("🤖 Via Anthropic API — model: claude-sonnet-4-20250514");
}

const { base64, mediaType } = loadImage(imagePath);
console.log(`📦 Image loaded: ${(base64.length * 0.75 / 1024).toFixed(0)} KB\n`);

let rawText;
try {
  rawText = openrouterKey
    ? await callOpenRouter(base64, mediaType, openrouterKey, model)
    : await callAnthropic(base64, mediaType, anthropicKey);
} catch (err) {
  console.error("❌  API call failed:", err.message);
  process.exit(1);
}

// Strip code fences if the model wrapped the JSON
const clean = rawText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();

let boardState;
try {
  boardState = JSON.parse(clean);
} catch {
  console.error("❌  Model returned invalid JSON. Raw output:\n");
  console.log(rawText);
  process.exit(1);
}

// Human-readable summary
printBoardSummary(boardState);

// Full JSON for piping / inspection
console.log("\n--- Full JSON ---\n");
console.log(JSON.stringify(boardState, null, 2));
