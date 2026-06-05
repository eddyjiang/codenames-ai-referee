import type { BoardState, CardState } from "./types";

// ---------------------------------------------------------------------------
// Demo board — a static 25-word board for exercising the game interface
// (setup, timer, clues, guesses) with zero camera and zero vision-API spend.
// All cards start unrevealed; reveals are simulated through the card edit
// modal (PATCH /board/card), which pins cells as manual.
// ---------------------------------------------------------------------------

const DEMO_WORDS = [
  "APPLE", "BERLIN", "CRANE", "DIAMOND", "EAGLE",
  "FOREST", "GLOVE", "HOLLYWOOD", "ICEBERG", "JUPITER",
  "KANGAROO", "LEMON", "MOSCOW", "NIGHT", "OCTOPUS",
  "PIANO", "QUEEN", "ROBOT", "SATELLITE", "TIGER",
  "UMBRELLA", "VOLCANO", "WHALE", "YARD", "ZEBRA",
];

const MARGIN = 0.04; // grid inset, fraction of the frame
const GAP = 0.012;   // spacing between cards, fraction of the frame

export function buildDemoBoard(): BoardState {
  const size = (1 - 2 * MARGIN - 4 * GAP) / 5;

  const board: CardState[] = DEMO_WORDS.map((word, position) => {
    const row = Math.floor(position / 5);
    const col = position % 5;
    return {
      position,
      word,
      revealed: false,
      team: null,
      confidence: 1,
      bbox: {
        x: MARGIN + col * (size + GAP),
        y: MARGIN + row * (size + GAP),
        w: size,
        h: size,
      },
    };
  });

  const now = Date.now();
  return {
    board,
    score: { red_remaining: null, blue_remaining: null, confidence: 1 },
    metadata: { overall_confidence: 1, issues: [], partial_visibility: false, notes: "demo" },
    captured_at: now,
    llm_at: now, // looks freshly read, so nothing schedules an LLM reveal
  };
}
