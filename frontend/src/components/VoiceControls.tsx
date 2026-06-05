import { useState, useCallback, useEffect, useRef } from "react";
import {
  useContinuousSpeech,
  speakText,
  isSpeechRecognitionSupported,
} from "../hooks/useVoice";
import type { RulesResult } from "../types";

interface Props {
  sessionId: string;
  hasBoard: boolean;
  onClueTranscript: (transcript: string) => Promise<{
    transcript: string;
    clue: { word: string; number: number | null } | null;
    rules: RulesResult | null;
  }>;
  onTurnEnd: () => void;
  currentTeam: "red" | "blue";
  currentClue: { word: string; number: number } | null;
  guessesThisTurn: number;
  timerSeconds: number | null;
}

type ClueState =
  | { status: "idle" }
  | { status: "processing" }
  | { status: "result"; result: RulesResult; transcript: string; clue: { word: string; number: number | null } | null };

const LEVEL_CONFIG = {
  none:  { label: "Legal",   bg: "rgba(245,165,33,0.07)",  border: "rgba(245,165,33,0.25)",  text: "#f5a521" },
  log:   { label: "Logged",  bg: "rgba(144,31,75,0.06)",   border: "rgba(144,31,75,0.18)",   text: "rgba(255,255,255,0.55)" },
  nudge: { label: "Warning", bg: "rgba(216,91,63,0.08)",   border: "rgba(216,91,63,0.30)",   text: "#d85b3f" },
  stop:  { label: "Illegal", bg: "rgba(144,31,75,0.12)",   border: "rgba(144,31,75,0.40)",   text: "#d85b3f" },
};

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function VoiceControls({
  sessionId: _sessionId,
  hasBoard,
  onClueTranscript,
  onTurnEnd,
  currentTeam,
  currentClue,
  guessesThisTurn,
  timerSeconds,
}: Props) {
  const speechSupported = isSpeechRecognitionSupported();
  const [clueState, setClueState] = useState<ClueState>({ status: "idle" });
  const [lastHeard, setLastHeard] = useState<string | null>(null);
  const processingRef = useRef(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [timesUp, setTimesUp] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Two-phase countdown: restarts when the turn begins (spymaster's time to give
  // a clue) and again when a clue lands (guessers' time to guess).
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    if (!timerSeconds) {
      setTimeLeft(null);
      setTimesUp(false);
      return;
    }

    setTimeLeft(timerSeconds);
    setTimesUp(false);

    intervalRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(intervalRef.current!);
          setTimesUp(true);
          speakText("Time's up!");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [currentClue, currentTeam, timerSeconds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each finalized utterance during the spymaster phase is judged. Ordinary
  // speech with no clue in it is surfaced quietly ("Heard: …"), not as a verdict.
  //
  // Pauses don't wipe context: when an utterance contains a clue word but no
  // number ("your clue is tree" … "3"), it's held and prepended to the next
  // utterance so the pair is judged as one. Utterances finalized while a parse
  // is in flight are queued, not dropped.
  const pendingClueRef = useRef<{ text: string; at: number } | null>(null);
  const queuedRef = useRef<string[]>([]);
  const PENDING_CLUE_WINDOW_MS = 15_000;

  const handleUtterance = useCallback(async (transcript: string) => {
    if (processingRef.current) {
      queuedRef.current.push(transcript); // judged next, in order — never dropped
      return;
    }
    processingRef.current = true;
    setClueState({ status: "processing" });

    const pending = pendingClueRef.current;
    const combined =
      pending && Date.now() - pending.at < PENDING_CLUE_WINDOW_MS
        ? `${pending.text} ${transcript}`
        : transcript;

    try {
      const res = await onClueTranscript(combined);
      if (!res.rules) {
        // Clue word without a number: hold the speech and wait for the number.
        // Anything else (no clue at all) is surfaced but not held.
        pendingClueRef.current =
          res.clue ? { text: combined, at: Date.now() } : null;
        setLastHeard(combined);
        setClueState({ status: "idle" });
        return;
      }
      pendingClueRef.current = null;
      setLastHeard(null);
      if (res.rules.message) speakText(res.rules.message);
      setClueState({ status: "result", result: res.rules, transcript: combined, clue: res.clue });
    } catch {
      setClueState({ status: "idle" });
    } finally {
      processingRef.current = false;
      const queued = queuedRef.current.splice(0).join(" ").trim();
      if (queued) void handleUtterance(queued);
    }
  }, [onClueTranscript]);

  // Mic lifecycle: hot for the whole spymaster phase (no clue yet); fully off
  // once a clue stands — the guessers may say anything, so nothing is recorded.
  // End Turn clears the clue, which relights the mic for the next spymaster.
  const spymasterPhase = hasBoard && !currentClue;
  const { listening, error: micError } = useContinuousSpeech({
    active: spymasterPhase && speechSupported,
    onUtterance: handleUtterance,
  });

  // Reset stale verdict cards and held speech when a new spymaster phase begins.
  useEffect(() => {
    if (!currentClue) {
      setClueState({ status: "idle" });
      setLastHeard(null);
      pendingClueRef.current = null;
      queuedRef.current = [];
    }
  }, [currentClue]);

  const isProcessing = clueState.status === "processing";

  // Red team uses the brand palette; blue team uses its own blue
  const teamGradient = currentTeam === "red"
    ? "linear-gradient(135deg, #3d0a1e 0%, #901f4b 60%, #d85b3f 100%)"
    : "linear-gradient(135deg, #0D2F6B 0%, #1A56A8 100%)";
  const teamLabel  = currentTeam === "red" ? "Red" : "Blue";
  const teamAccent = currentTeam === "red" ? "#d85b3f" : "#60a5fa";

  return (
    <div className="space-y-4">
      {/* Team / clue banner — End Turn stretches the full banner height on the right */}
      <div className="rounded-2xl p-4 flex gap-3" style={{ background: teamGradient }}>
        <div className="flex-1 min-w-0">
          {/* Turn timer — counts down the spymaster's time to give a clue,
              then resets for the guessers. */}
          {timerSeconds != null && (
            <div className="mb-3">
              {timesUp ? (
                <span
                  className="font-heading text-3xl font-bold leading-none tracking-widest uppercase animate-pulse"
                  style={{ color: "#f5a521" }}
                >
                  Time's up
                </span>
              ) : timeLeft !== null && (
                <span
                  className="font-heading text-3xl font-bold tabular-nums leading-none"
                  style={{
                    color: timeLeft <= 10 ? "#d85b3f" : timeLeft <= 30 ? "#f5a521" : "rgba(255,255,255,0.9)",
                  }}
                >
                  {formatTime(timeLeft)}
                </span>
              )}
            </div>
          )}
          <div className="space-y-1">
            <p className="font-heading text-[10px] tracking-[0.3em] uppercase text-white/75">{teamLabel} Spymaster</p>
            {currentClue ? (
              <div>
                <p className="font-heading text-3xl font-bold tracking-wider text-white leading-none">
                  {currentClue.word}
                </p>
                <p className="font-heading text-sm tracking-widest text-white/80 mt-0.5">
                  {currentClue.number === 99 ? "Unlimited" : currentClue.number} &mdash;&nbsp;
                  {guessesThisTurn} guess{guessesThisTurn !== 1 ? "es" : ""} made
                </p>
              </div>
            ) : (
              <p className="font-heading text-sm tracking-widest text-white/65 uppercase">
                Awaiting clue
              </p>
            )}
          </div>
        </div>
        <button
          onClick={onTurnEnd}
          className="self-center shrink-0 font-heading text-[10px] tracking-[0.2em] uppercase text-white/90 bg-red-600/80 border border-red-400/50 rounded-xl px-3 py-2.5 hover:bg-red-600 hover:border-red-300/70 transition-colors active:scale-95"
        >
          End Turn
        </button>
      </div>

      {/* Mic status — automatic: hot all spymaster phase, off while guessing */}
      <div className="flex flex-col items-center gap-3 py-2">
        <div className="relative flex items-center justify-center">
          {/* Pulsing rings while the mic is hot */}
          {listening && (
            <>
              <div className="absolute w-24 h-24 rounded-full border animate-pulse-ring"
                   style={{ borderColor: teamAccent, opacity: 0.5 }} />
              <div className="absolute w-24 h-24 rounded-full border animate-pulse-ring"
                   style={{ borderColor: teamAccent, opacity: 0.3, animationDelay: "0.5s" }} />
            </>
          )}
          <div
            className={[
              "relative w-20 h-20 rounded-full flex items-center justify-center transition-all",
              (!hasBoard || !speechSupported) && "opacity-30",
            ].join(" ")}
            style={{
              background: listening ? teamGradient : "rgba(17,7,9,0.85)",
              border: `2px solid ${listening ? teamAccent : "rgba(144,31,75,0.25)"}`,
              boxShadow: listening
                ? `0 0 32px ${teamAccent}50, 0 0 64px ${teamAccent}20`
                : "0 2px 12px rgba(0,0,0,0.5)",
            }}
          >
            {isProcessing ? (
              <svg className="animate-spin w-6 h-6 text-brand-gold" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
              </svg>
            ) : !spymasterPhase && hasBoard ? (
              /* Guesser phase: mic explicitly off */
              <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                   style={{ color: "rgba(255,255,255,0.35)" }} strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round"
                      d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                <path strokeLinecap="round" d="M4 4l16 16" />
              </svg>
            ) : (
              <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                   style={{ color: listening ? "#fff" : "rgba(255,255,255,0.75)" }} strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round"
                      d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              </svg>
            )}
          </div>
        </div>

        <p className="font-heading text-[10px] tracking-[0.2em] uppercase text-white/60 text-center">
          {!speechSupported
            ? "Voice input isn't supported in this browser — try Chrome or Safari"
            : !hasBoard
              ? "Scan the board first"
              : isProcessing
                ? "Judging clue…"
                : !spymasterPhase
                  ? "Mic off — guessers may talk freely"
                  : listening
                    ? `Listening for the ${teamLabel} spymaster's clue…`
                    : "Mic starting…"}
        </p>
        {lastHeard && spymasterPhase && !isProcessing && (
          <p className="text-[10px] text-white/40 text-center px-4">
            Heard: “{lastHeard}” — say the clue followed by a number
          </p>
        )}
        {micError && (
          <p className="text-red-400 text-xs font-heading tracking-wide text-center">{micError}</p>
        )}
      </div>

      {/* Rules result */}
      {clueState.status === "result" && (
        <RulesResultCard state={clueState} />
      )}

      {/* Guesses are tracked from board reveals — no manual button. If vision
          misses one, tapping the card and setting its team counts it. */}
    </div>
  );
}

function RulesResultCard({ state }: { state: Extract<ClueState, { status: "result" }> }) {
  const { result, transcript, clue } = state;
  const level = result.intervention_level;
  const cfg = LEVEL_CONFIG[level] ?? LEVEL_CONFIG.log;

  return (
    <div
      className="rounded-xl p-4 space-y-2"
      style={{
        // Level tint layered over a translucent dark base — darker than the page.
        background: `linear-gradient(${cfg.bg}, ${cfg.bg}), rgba(0, 0, 0, 0.3)`,
        border: `1px solid ${cfg.border}`,
      }}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5 min-w-0">
          {clue ? (
            <p className="font-heading text-xl font-bold tracking-widest text-card-bg leading-none">
              {clue.word} &mdash; {clue.number ?? "?"}
            </p>
          ) : (
            <p className="text-brand-amber text-xs font-heading tracking-wide">
              Could not parse: "{transcript}"
            </p>
          )}
          {clue && (
            <p className="text-white/55 text-[10px] truncate">"{transcript}"</p>
          )}
        </div>
        <span
          className="font-heading text-[10px] tracking-[0.2em] uppercase shrink-0 mt-0.5"
          style={{ color: cfg.text }}
        >
          {cfg.label}
        </span>
      </div>

      {/* Message — the violation details are already woven into it */}
      {result.message && (
        <p className="text-sm text-white/90 leading-snug">{result.message}</p>
      )}

      {level === "none" && (
        <p className="font-heading text-[10px] tracking-widest uppercase" style={{ color: cfg.text }}>
          Clue is legal
        </p>
      )}
    </div>
  );
}
