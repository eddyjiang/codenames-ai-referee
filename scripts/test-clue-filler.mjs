#!/usr/bin/env node
/**
 * Unit tests for isHarmlessFiller — the deterministic guard that keeps
 * harmless clue lead-ins ("okay your clue is …") from being treated as
 * illegal extra communication when the parse LLM over-flags them.
 * No network, no Cloudflare.
 *   node scripts/test-clue-filler.mjs
 */
import assert from "node:assert/strict";
import { isHarmlessFiller } from "../worker/src/voice.ts";

let passed = 0;
function check(name, actual, expected) {
  assert.equal(actual, expected);
  console.log("✓", name);
  passed++;
}

// Harmless lead-ins — must scrub to nothing.
check("okay your clue is", isHarmlessFiller("okay your clue is"), true);
check("your clue is", isHarmlessFiller("your clue is"), true);
check("the clue is", isHarmlessFiller("the clue is"), true);
check("um okay", isHarmlessFiller("um okay"), true);
check("alright here's my clue", isHarmlessFiller("alright here's my clue"), true);
check("okay okay I have a clue", isHarmlessFiller("okay okay I have a clue"), true);
check("so um the clue is", isHarmlessFiller("so um the clue is"), true);
check("punctuation/case", isHarmlessFiller("Okay, your clue is..."), true);

// Substantive speech — must stay flagged.
check("quality hint", isHarmlessFiller("this may be a stretch"), false);
check("story", isHarmlessFiller("remember what you did for winter break"), false);
check("mixed filler + commentary",
  isHarmlessFiller("okay your clue is and it's a really good one"), false);
check("targeting hint", isHarmlessFiller("not the one you guessed last turn"), false);

console.log(`\n${passed} checks passed`);
