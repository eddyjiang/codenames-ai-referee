import type { BoardState, RulesResult, RuleViolation, HouseRules, InterventionLevel } from "./types";

// ---------- helpers ----------

function normalize(word: string): string {
  return word.toLowerCase().trim();
}

// Minimal stemmer: strip common English suffixes to find shared roots.
// Not exhaustive — covers the most common Codenames violations.
function stem(word: string): string {
  const w = normalize(word);
  const suffixes = [
    "ingly", "ingly", "ation", "ness", "less", "ment",
    "ing", "tion", "ful", "ers", "ies", "ied",
    "er", "es", "ed", "ly", "s",
  ];
  for (const suffix of suffixes) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      return w.slice(0, w.length - suffix.length);
    }
  }
  return w;
}

function sharesRoot(a: string, b: string): boolean {
  const sa = stem(a);
  const sb = stem(b);
  // Direct stem match
  if (sa === sb) return true;
  // One is a substring of the other's stem (e.g. "swim"/"swimming")
  if (sa.length >= 3 && sb.startsWith(sa)) return true;
  if (sb.length >= 3 && sa.startsWith(sb)) return true;
  return false;
}

function getActiveBoardWords(board: BoardState): string[] {
  return board.board
    .filter((c) => !c.revealed && c.word !== null)
    .map((c) => c.word as string);
}

// ---------- individual rule checks ----------

function checkWordOnBoard(clue: string, board: BoardState): RuleViolation | null {
  const norm = normalize(clue);
  const match = getActiveBoardWords(board).find((w) => normalize(w) === norm);
  if (match) {
    return {
      rule: "word_on_board",
      description: `"${clue}" is one of the 25 words currently on the board.`,
      confidence: 0.98,
    };
  }
  return null;
}

function checkHomophone(clue: string, board: BoardState): RuleViolation | null {
  // Simple homophone table for the most common pairs in English.
  // A production implementation would use a phoneme dictionary.
  const homophones: Record<string, string[]> = {
    bear: ["bare"], bare: ["bear"],
    here: ["hear"], hear: ["here"],
    knight: ["night"], night: ["knight"],
    sea: ["see"], see: ["sea"],
    sun: ["son"], son: ["sun"],
    hole: ["whole"], whole: ["hole"],
    brake: ["break"], break: ["brake"],
    meet: ["meat"], meat: ["meet"],
    pair: ["pear"], pear: ["pair"],
    write: ["right"], right: ["write"],
    flower: ["flour"], flour: ["flower"],
    plain: ["plane"], plane: ["plain"],
    sale: ["sail"], sail: ["sale"],
    tale: ["tail"], tail: ["tale"],
    waste: ["waist"], waist: ["waste"],
    week: ["weak"], weak: ["week"],
    wood: ["would"], would: ["wood"],
  };

  const norm = normalize(clue);
  const alts = homophones[norm] ?? [];
  const boardWords = getActiveBoardWords(board).map(normalize);

  for (const alt of alts) {
    if (boardWords.includes(alt)) {
      return {
        rule: "homophone",
        description: `"${clue}" sounds like "${alt.toUpperCase()}", which is on the board.`,
        confidence: 0.9,
      };
    }
  }
  return null;
}

function checkRootMatch(clue: string, board: BoardState): RuleViolation | null {
  // Skip if it's an exact match (caught by word_on_board)
  const norm = normalize(clue);
  for (const boardWord of getActiveBoardWords(board)) {
    if (normalize(boardWord) === norm) continue;
    if (sharesRoot(clue, boardWord)) {
      return {
        rule: "root_match",
        description: `"${clue}" shares a root with "${boardWord}", which is on the board.`,
        confidence: 0.85,
      };
    }
  }
  return null;
}

function checkCompoundPart(
  clue: string,
  board: BoardState,
  houseRules: HouseRules
): RuleViolation | null {
  if (houseRules.allow_compound_parts) return null;

  const norm = normalize(clue);
  for (const boardWord of getActiveBoardWords(board)) {
    const bNorm = normalize(boardWord);
    // Check if board word contains the clue as a component (e.g. clue=ball, board=football)
    if (bNorm.includes(norm) && bNorm !== norm) {
      return {
        rule: "compound_part",
        description: `"${clue}" appears inside "${boardWord}" on the board.`,
        confidence: 0.88,
      };
    }
    // Also check reverse: clue contains a board word (e.g. clue=football, board=ball) — less common but also illegal
    if (norm.includes(bNorm) && norm !== bNorm && bNorm.length >= 3) {
      return {
        rule: "compound_part",
        description: `"${boardWord}" (on the board) appears inside "${clue}".`,
        confidence: 0.88,
      };
    }
  }
  return null;
}

function checkMultipleWords(clue: string): RuleViolation | null {
  const words = clue.trim().split(/\s+/);
  if (words.length > 1) {
    return {
      rule: "multiple_words",
      description: `A clue must be a single word. "${clue}" contains multiple words.`,
      confidence: 0.99,
    };
  }
  return null;
}

function checkZeroClue(
  number: number,
  houseRules: HouseRules
): RuleViolation | null {
  if (houseRules.zero_clue_forbidden && number === 0) {
    return {
      rule: "zero_clue_forbidden",
      description: "House rules forbid using 0 as the clue number.",
      confidence: 1.0,
    };
  }
  return null;
}

export function checkGuessLimit(
  guessesThisTurn: number,
  clueNumber: number
): RuleViolation | null {
  const limit = clueNumber + 1;
  if (guessesThisTurn > limit) {
    return {
      rule: "guess_limit_exceeded",
      description: `The clue number was ${clueNumber}, so the maximum is ${limit} guess${limit === 1 ? "" : "es"}. This is guess ${guessesThisTurn}.`,
      confidence: 1.0,
    };
  }
  return null;
}

function checkExtraCommunication(extra: string | null | undefined): RuleViolation | null {
  if (!extra) return null;
  return {
    rule: "extra_communication",
    description: `The spymaster said more than the clue and number: "${extra}". Spymasters may only say a one-word clue and a number.`,
    confidence: 0.95,
  };
}

// ---------- main validation entry point ----------

export function validateClue(
  clue: string,
  number: number,
  board: BoardState,
  houseRules: HouseRules,
  extraSpeech?: string | null
): RulesResult {
  const violations: RuleViolation[] = [];

  // Note: no repeat-clue check — the official rules don't forbid reusing a clue.
  const checks = [
    checkMultipleWords(clue),
    checkWordOnBoard(clue, board),
    checkHomophone(clue, board),
    checkRootMatch(clue, board),
    checkCompoundPart(clue, board, houseRules),
    checkZeroClue(number, houseRules),
    checkExtraCommunication(extraSpeech),
  ];

  for (const v of checks) {
    if (v) violations.push(v);
  }

  if (violations.length === 0) {
    return {
      valid: true,
      violations: [],
      intervention_level: "none",
      message: "",
      confidence: 1.0,
    };
  }

  // Severity: pick the highest-confidence violation to drive the intervention level
  const maxConfidence = Math.max(...violations.map((v) => v.confidence));
  const primaryViolation = violations.find((v) => v.confidence === maxConfidence)!;

  let level: InterventionLevel;
  if (maxConfidence >= 0.95) {
    level = "stop";
  } else if (maxConfidence >= 0.85) {
    level = "nudge";
  } else {
    level = "log";
  }

  const message = buildMessage(level, primaryViolation);

  return {
    valid: false,
    violations,
    intervention_level: level,
    message,
    confidence: maxConfidence,
  };
}

function buildMessage(level: InterventionLevel, v: RuleViolation): string {
  if (level === "log") return "";

  if (level === "nudge") {
    // The guessers already heard the clue — offering a do-over would be unfair.
    // The clue stands; the referee advises the rule and play continues.
    return `Heads up — ${v.description.charAt(0).toLowerCase() + v.description.slice(1)} The clue stands, but please avoid clues like that going forward.`;
  }

  // stop — an illegal clue forfeits the turn (no guesses); the referee
  // announces it but humans end the turn themselves.
  return `That clue isn't legal. ${v.description} No guesses may be made — the turn should pass to the other team.`;
}
