#!/usr/bin/env node
/**
 * Smoke-tests the rules engine logic in pure JS (no build, no Cloudflare needed).
 *
 * Usage:  node scripts/test-rules.mjs
 *
 * This replicates the core rules.ts logic so it can run without compiling TypeScript.
 * When you update rules.ts, update the matching logic here too.
 */

// ——— minimal rules engine (mirrors worker/src/rules.ts) ———

function normalize(word) {
  return word.toLowerCase().trim();
}

function stem(word) {
  const w = normalize(word);
  const suffixes = ["ingly","ation","ness","less","ment","ing","tion","ful","ers","ies","ied","er","es","ed","ly","s"];
  for (const suffix of suffixes) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      return w.slice(0, w.length - suffix.length);
    }
  }
  return w;
}

function sharesRoot(a, b) {
  const sa = stem(a), sb = stem(b);
  if (sa === sb) return true;
  if (sa.length >= 3 && sb.startsWith(sa)) return true;
  if (sb.length >= 3 && sa.startsWith(sb)) return true;
  return false;
}

function makeDummyBoard(words) {
  return {
    board: words.map((word, i) => ({
      position: i,
      word: word.toUpperCase(),
      revealed: false,
      team: null,
      confidence: 1.0,
    })),
    score: { red_remaining: null, blue_remaining: null, confidence: 0 },
    metadata: { overall_confidence: 1.0, issues: [], partial_visibility: false, notes: "" },
    captured_at: Date.now(),
  };
}

function checkWordOnBoard(clue, board) {
  const norm = normalize(clue);
  const match = board.board
    .filter((c) => !c.revealed && c.word)
    .find((c) => normalize(c.word) === norm);
  return match ? { rule: "word_on_board", description: `"${clue}" is on the board`, confidence: 0.98 } : null;
}

function checkRootMatch(clue, board) {
  for (const card of board.board.filter((c) => !c.revealed && c.word)) {
    if (normalize(card.word) === normalize(clue)) continue;
    if (sharesRoot(clue, card.word)) {
      return { rule: "root_match", description: `"${clue}" shares a root with "${card.word}"`, confidence: 0.85 };
    }
  }
  return null;
}

function checkMultipleWords(clue) {
  return clue.trim().split(/\s+/).length > 1
    ? { rule: "multiple_words", description: `"${clue}" contains multiple words`, confidence: 0.99 }
    : null;
}

function checkRepeatClue(clue, cluesGiven) {
  return cluesGiven.map(normalize).includes(normalize(clue))
    ? { rule: "repeat_clue", description: `"${clue}" was already used`, confidence: 1.0 }
    : null;
}

function validateClue(clue, board, cluesGiven = []) {
  const violations = [
    checkMultipleWords(clue),
    checkWordOnBoard(clue, board),
    checkRootMatch(clue, board),
    checkRepeatClue(clue, cluesGiven),
  ].filter(Boolean);

  if (!violations.length) return { valid: true, violations: [], message: "✓ Legal clue" };

  const worst = violations.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
  const level = worst.confidence >= 0.95 ? "STOP" : worst.confidence >= 0.85 ? "NUDGE" : "LOG";
  return { valid: false, violations, level, message: `${level}: ${worst.description}` };
}

// ——— test cases ———

let passed = 0, failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✅  ${label}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${label}`);
    console.log(`      ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? "assertion failed");
}

const BOARD_WORDS = [
  "OCEAN", "PIANO", "SHARK", "LADDER", "FIRE",
  "SWIM", "CASTLE", "BRIDGE", "MOON", "STAR",
  "PLANT", "DRIVER", "LIGHT", "CLUB", "BANK",
  "FOOTBALL", "SPRING", "BEAR", "WAVE", "CHEST",
  "NIGHT", "RING", "ROSE", "TRUNK", "EAGLE",
];

const board = makeDummyBoard(BOARD_WORDS);

console.log("\n🃏  Rules Engine Tests\n");

console.log("— Word on board —");
test("exact match is illegal", () => {
  const r = validateClue("ocean", board);
  assert(!r.valid, "should be invalid");
  assert(r.violations.some((v) => v.rule === "word_on_board"), "should flag word_on_board");
});

test("case-insensitive match is illegal", () => {
  const r = validateClue("PIANO", board);
  assert(!r.valid);
});

test("unrelated word is legal", () => {
  const r = validateClue("telescope", board);
  assert(r.valid, "should be valid");
});

console.log("\n— Root matching —");
test("swimming → SWIM is illegal (root match)", () => {
  const r = validateClue("swimming", board);
  assert(!r.valid);
  assert(r.violations.some((v) => v.rule === "root_match"));
});

test("drives → DRIVER is illegal (root match)", () => {
  const r = validateClue("drives", board);
  assert(!r.valid);
  assert(r.violations.some((v) => v.rule === "root_match" || v.rule === "word_on_board"));
});

test("planetary (no root on board) is legal", () => {
  const r = validateClue("planetary", board);
  assert(r.valid, "should be legal");
});

console.log("\n— Multiple words —");
test("two-word clue is illegal", () => {
  const r = validateClue("dark sky", board);
  assert(!r.valid);
  assert(r.violations.some((v) => v.rule === "multiple_words"));
});

test("hyphenated compound counts as one word", () => {
  // "well-known" — neither part is on the board
  const r = validateClue("well-known", board);
  assert(r.valid, "hyphenated word should be legal");
});

console.log("\n— Repeat clue —");
test("repeating a prior clue is illegal", () => {
  const r = validateClue("telescope", board, ["telescope"]);
  assert(!r.valid);
  assert(r.violations.some((v) => v.rule === "repeat_clue"));
});

test("different clue is fine even if others were used", () => {
  const r = validateClue("telescope", board, ["nebula", "horizon"]);
  assert(r.valid);
});

console.log("\n— Intervention levels —");
test("word-on-board triggers STOP (confidence 0.98)", () => {
  const r = validateClue("ocean", board);
  assert(r.level === "STOP", `expected STOP, got ${r.level}`);
});

test("root match triggers NUDGE (confidence 0.85)", () => {
  const r = validateClue("swimming", board);
  assert(r.level === "NUDGE" || r.level === "STOP", `expected NUDGE or STOP, got ${r.level}`);
});

// ——— summary ———

console.log(`\n${"─".repeat(40)}`);
console.log(`${passed + failed} tests  |  ${passed} passed  |  ${failed} failed\n`);
if (failed > 0) process.exit(1);
