#!/usr/bin/env node
/**
 * Unit tests for selectVisionPlan — the pure SYNCHRONOUS frame-routing decision.
 * (The periodic LLM reveal read is scheduled in the background by the /frame
 * handler, not chosen here.) No network, no Cloudflare.
 *   node scripts/test-vision-plan.mjs
 */
import assert from "node:assert/strict";
import { selectVisionPlan } from "../worker/src/vision-plan.ts";

function board(words) {
  return {
    board: words.map((w, i) => ({ position: i, word: w, revealed: false, team: null, confidence: 1 })),
    score: { red_remaining: null, blue_remaining: null, confidence: 0 },
    metadata: { overall_confidence: 1, issues: [], partial_visibility: false, notes: "" },
    captured_at: 0,
  };
}
const noBoard = undefined;
const zeroWords = board(Array(25).fill(null));
const locked = board(["AMAZON", ...Array(24).fill(null)]);
const lockedList = ["AMAZON", ...Array(24).fill(null)];
const BOTH = { cv: true, llm: true };
const NO_CV = { cv: false, llm: true };

let passed = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected);
  console.log("✓", name);
  passed++;
}

// pure-cv engine
check("cv + no board → CV full",
  selectVisionPlan("cv", noBoard, BOTH),
  { backend: "cv", mode: "full", knownWords: null, reason: "cv-full" });
check("cv + locked → CV track",
  selectVisionPlan("cv", locked, BOTH),
  { backend: "cv", mode: "track", knownWords: lockedList, reason: "cv-track" });

// auto: first scan
check("auto + no board → LLM first-scan",
  selectVisionPlan("auto", noBoard, BOTH),
  { backend: "llm", mode: "full", knownWords: null, reason: "first-scan" });
check("auto + 0 words → LLM first-scan",
  selectVisionPlan("auto", zeroWords, BOTH),
  { backend: "llm", mode: "full", knownWords: null, reason: "first-scan" });

// auto: locked → fast CV track every frame (LLM reveal is backgrounded elsewhere)
check("auto + locked + CV → CV track (sync; LLM reveal is background)",
  selectVisionPlan("auto", locked, BOTH),
  { backend: "cv", mode: "track", knownWords: lockedList, reason: "cv-track" });

// auto: locked, no CV service → blocking LLM per frame
check("auto + locked + no CV → LLM reveal (blocking fallback)",
  selectVisionPlan("auto", locked, NO_CV),
  { backend: "llm", mode: "full", knownWords: lockedList, reason: "llm-reveal" });

console.log(`\n${passed}/6 passed`);
