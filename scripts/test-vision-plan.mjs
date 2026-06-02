#!/usr/bin/env node
/**
 * Unit tests for selectVisionPlan — the pure frame-routing decision.
 * No network, no Cloudflare. Run:
 *
 *   node scripts/test-vision-plan.mjs
 *
 * (Node ≥ 23.6 strips TypeScript types on import automatically.)
 */
import assert from "node:assert/strict";
import { selectVisionPlan } from "../worker/src/vision-plan.ts";

function board(words) {
  return {
    board: words.map((w, i) => ({
      position: i,
      word: w,
      revealed: false,
      team: null,
      confidence: 1,
    })),
    score: { red_remaining: null, blue_remaining: null, confidence: 0 },
    metadata: { overall_confidence: 1, issues: [], partial_visibility: false, notes: "" },
    captured_at: 0,
  };
}

const noBoard = undefined;
const zeroWords = board(Array(25).fill(null));
const oneWord = board(["AMAZON", ...Array(24).fill(null)]);
const lockedList = ["AMAZON", ...Array(24).fill(null)];

let passed = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected);
  console.log("✓", name);
  passed++;
}

// ── auto engine ──────────────────────────────────────────────────────────────
check(
  "auto + no board → LLM full",
  selectVisionPlan("auto", noBoard, true),
  { backend: "llm", mode: "full", knownWords: null }
);
check(
  "auto + board with 0 readable words → LLM full (no lock yet)",
  selectVisionPlan("auto", zeroWords, true),
  { backend: "llm", mode: "full", knownWords: null }
);
check(
  "auto + locked words + CV available → CV track",
  selectVisionPlan("auto", oneWord, true),
  { backend: "cv", mode: "track", knownWords: lockedList }
);
check(
  "auto + locked words but NO CV service → LLM full (fallback)",
  selectVisionPlan("auto", oneWord, false),
  { backend: "llm", mode: "full", knownWords: null }
);

// ── pure-cv engine ───────────────────────────────────────────────────────────
check(
  "cv + no board → CV full (OCR)",
  selectVisionPlan("cv", noBoard, true),
  { backend: "cv", mode: "full", knownWords: null }
);
check(
  "cv + board with 0 words → CV full (still needs OCR)",
  selectVisionPlan("cv", zeroWords, true),
  { backend: "cv", mode: "full", knownWords: null }
);
check(
  "cv + locked words → CV track",
  selectVisionPlan("cv", oneWord, true),
  { backend: "cv", mode: "track", knownWords: lockedList }
);
check(
  "cv requested plans CV regardless of hasCVService flag (caller enforces URL)",
  selectVisionPlan("cv", noBoard, false),
  { backend: "cv", mode: "full", knownWords: null }
);

console.log(`\n${passed}/8 passed`);
