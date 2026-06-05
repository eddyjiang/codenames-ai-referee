// Clue parsing from browser-STT transcripts.
// STT and TTS both happen client-side via the free Web Speech API — no OpenAI.

// ---------------------------------------------------------------------------
// LLM clue extraction — handles natural speech the regex can't ("your clue is
// iceberg for one" → ICEBERG 1, where the regex grabs "FOR"). Cheap model,
// ~200 tokens per parse. parseClueFromTranscript below remains the offline
// fallback when OpenRouter is unconfigured or errors.
// ---------------------------------------------------------------------------

const CLUE_PARSE_MODEL = "google/gemini-2.5-flash-lite";

export interface ParsedClue {
  word: string;
  /** null when the spymaster didn't say a number — never fabricated. */
  number: number | null;
  /** Substantive speech beyond clue + number (illegal communication), if any. */
  extra: string | null;
}

// Deterministic guard on the LLM's "extra" verdict: the parse model sometimes
// over-flags harmless lead-ins ("okay your clue is") as illegal communication,
// which wrongly voids the clue. If the flagged speech is nothing but known
// filler, it isn't extra communication — drop it rather than trust the LLM.
const FILLER_PHRASES = [
  "here's my clue",
  "here is my clue",
  "i have a clue",
  "i've got a clue",
  "your clue is",
  "the clue is",
  "my clue is",
  "clue is",
];
const FILLER_WORDS = new Set([
  "um", "uh", "er", "ah", "hmm", "okay", "ok", "alright", "all", "right",
  "so", "well", "yeah", "yes", "clue", "for",
]);

export function isHarmlessFiller(extra: string): boolean {
  let s = ` ${extra.toLowerCase().replace(/[^a-z\s']/g, " ")} `;
  for (const phrase of FILLER_PHRASES) {
    s = s.replaceAll(` ${phrase} `, " ");
  }
  return s.split(/\s+/).filter(Boolean).every((w) => FILLER_WORDS.has(w));
}

export async function parseClueWithLLM(
  transcript: string,
  openrouterApiKey: string
): Promise<ParsedClue | null> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLUE_PARSE_MODEL,
      temperature: 0,
      max_tokens: 60,
      messages: [
        {
          role: "user",
          content: `A Codenames spymaster spoke their clue aloud. Extract what was ACTUALLY said — you transcribe, the referee judges.

Transcript: "${transcript}"

Rules:
- Extract the clue EXACTLY as spoken. Clues are supposed to be a single word, but spymasters sometimes illegally say several ("fruit tree for two" → clue FRUIT TREE, number 2) — preserve every clue word so the referee can judge it. Do NOT shorten a multi-word clue.
- The trailing number phrase is NOT part of the clue: "lettuce one" → clue LETTUCE, number 1 (not "LETTUCE ONE"); "sunshine unlimited" → clue SUNSHINE, number 99.
- The number is 0-10, or 99 for "unlimited"/"infinity". If NO number was spoken, use null — NEVER invent one.
- ANNOUNCEMENTS ARE NOT CLUES. "I have a clue", "okay okay I have a really good clue", "here's my clue" deliver no clue — respond null. The literal word "clue" in such phrases is never the clue word.
- "extra": any substantive speech beyond the clue, the number, and harmless filler. Filler ("um", "okay", "your clue is", "I have a clue") is NOT extra, even combined — "okay your clue is tall for three" → clue TALL, number 3, extra: null. Commentary, stories, asides, or quality hints alongside a delivered clue ARE extra — e.g. "remember what you did for winter break your clue is lettuce" → extra: "remember what you did for winter break"; "this may be a stretch lettuce one" → extra: "this may be a stretch". Use null if there is none.
- Watch homophones and prepositions: "iceberg for one" → clue ICEBERG, number 1 ("for" is a preposition); "iceberg four" → clue ICEBERG, number 4.

Respond with ONLY JSON, no prose:
{"word": "CLUE WORDS", "number": N or null, "extra": "substantive extra speech" or null}
or, if no clue is present at all:
null`,
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Clue parse API error ${res.status}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = (data.choices?.[0]?.message?.content ?? "").replace(/```(?:json)?/g, "").trim();
  if (!content || content === "null") return null;

  const parsed = JSON.parse(content) as { word?: unknown; number?: unknown; extra?: unknown };
  const word = typeof parsed.word === "string"
    ? parsed.word.trim().toUpperCase().replace(/\s+/g, " ")
    : "";
  // Spaces allowed: multi-word clues must reach the rules engine (which stops
  // them) rather than being silently trimmed to one word here.
  if (!/^[A-Z][A-Z' -]*$/.test(word)) return null;

  let number: number | null = null;
  if (typeof parsed.number === "number") {
    if (!Number.isInteger(parsed.number) || parsed.number < 0 || parsed.number > 99) return null;
    number = parsed.number;
  }

  const rawExtra =
    typeof parsed.extra === "string" && parsed.extra.trim() ? parsed.extra.trim() : null;
  const extra = rawExtra && !isHarmlessFiller(rawExtra) ? rawExtra : null;

  return { word, number, extra };
}

/** LLM parse with regex fallback (no key, network/model error). */
export async function parseClue(
  transcript: string,
  openrouterApiKey: string | undefined
): Promise<ParsedClue | null> {
  if (openrouterApiKey) {
    try {
      return await parseClueWithLLM(transcript, openrouterApiKey);
    } catch {
      // fall through to the regex heuristic
    }
  }
  const parsed = parseClueFromTranscript(transcript);
  return parsed ? { ...parsed, extra: null } : null;
}

export function parseClueFromTranscript(
  transcript: string
): { word: string; number: number } | null {
  // Expected format: "WORD NUMBER" e.g. "ocean 3" or "CLIMB 2"
  // Also handles: "the clue is ocean three"
  const numberWords: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    unlimited: 99, infinity: 99,
  };

  const clean = transcript.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  const tokens = clean.split(/\s+/).filter(Boolean);

  // Find the last token that is a number (digit or word)
  for (let i = tokens.length - 1; i >= 1; i--) {
    const token = tokens[i];
    const asDigit = parseInt(token, 10);
    const asWord = numberWords[token];
    const num = !isNaN(asDigit) ? asDigit : asWord;

    if (num !== undefined) {
      // The word is everything before the number, take last word if multiple
      const wordTokens = tokens.slice(0, i);
      const word = wordTokens[wordTokens.length - 1];
      if (word && /^[a-z]+$/.test(word)) {
        return { word: word.toUpperCase(), number: num };
      }
    }
  }

  return null;
}

