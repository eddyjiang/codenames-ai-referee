import { useState, useCallback } from "react";
import {
  useVoiceRecorder,
  useSpeechInput,
  speakText,
  playBase64Audio,
  isSpeechRecognitionSupported,
} from "../hooks/useVoice";
import type { RulesResult } from "../types";

interface Props {
  sessionId: string;
  hasBoard: boolean;
  onClueAudio: (blob: Blob) => Promise<{
    transcript: string;
    clue: { word: string; number: number } | null;
    rules: RulesResult;
    tts_audio_base64: string | null;
  }>;
  onClueText: (word: string, number: number) => Promise<RulesResult>;
  onGuess: () => Promise<{
    guesses_this_turn: number;
    limit: number | null;
    violation: unknown;
    tts_audio_base64: string | null;
  }>;
  onTurnEnd: () => void;
  currentTeam: "red" | "blue";
  currentClue: { word: string; number: number } | null;
  guessesThisTurn: number;
}

type ClueState =
  | { status: "idle" }
  | { status: "listening" }
  | { status: "processing" }
  | { status: "result"; result: RulesResult; transcript: string; clue: { word: string; number: number } | null };

function parseClue(transcript: string): { word: string; number: number } | null {
  const numberWords: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10, unlimited: 99, infinity: 99,
  };
  const clean = transcript.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  const tokens = clean.split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 1; i--) {
    const n = parseInt(tokens[i], 10);
    const num = !isNaN(n) ? n : numberWords[tokens[i]];
    if (num !== undefined) {
      const word = tokens.slice(0, i).at(-1);
      if (word && /^[a-z]+$/.test(word)) return { word: word.toUpperCase(), number: num };
    }
  }
  return null;
}

const LEVEL_CONFIG = {
  none:  { label: "Legal",   bg: "rgba(245,165,33,0.07)",  border: "rgba(245,165,33,0.25)",  text: "#f5a521" },
  log:   { label: "Logged",  bg: "rgba(144,31,75,0.06)",   border: "rgba(144,31,75,0.18)",   text: "rgba(255,255,255,0.55)" },
  nudge: { label: "Warning", bg: "rgba(216,91,63,0.08)",   border: "rgba(216,91,63,0.30)",   text: "#d85b3f" },
  stop:  { label: "Illegal", bg: "rgba(144,31,75,0.12)",   border: "rgba(144,31,75,0.40)",   text: "#d85b3f" },
};

export function VoiceControls({
  sessionId: _sessionId,
  hasBoard,
  onClueAudio,
  onClueText,
  onGuess,
  onTurnEnd,
  currentTeam,
  currentClue,
  guessesThisTurn,
}: Props) {
  const [mode, setMode] = useState<"live" | "upload">(
    isSpeechRecognitionSupported() ? "live" : "upload"
  );
  const [clueState, setClueState] = useState<ClueState>({ status: "idle" });
  const [guessMsg, setGuessMsg] = useState<string | null>(null);

  const { recording, error: recError, startRecording, stopRecording } = useVoiceRecorder();
  const { listening, error: speechError, listen, cancel } = useSpeechInput();

  const handleLiveMic = useCallback(async () => {
    if (listening) { cancel(); setClueState({ status: "idle" }); return; }
    setClueState({ status: "listening" });
    try {
      const { transcript } = await listen();
      setClueState({ status: "processing" });
      const parsed = parseClue(transcript);
      if (!parsed) {
        setClueState({ status: "result", result: { valid: false, violations: [], intervention_level: "none", message: "", confidence: 0 }, transcript, clue: null });
        return;
      }
      const result = await onClueText(parsed.word, parsed.number);
      if (result.message) speakText(result.message);
      setClueState({ status: "result", result, transcript, clue: parsed });
    } catch {
      setClueState({ status: "idle" });
    }
  }, [listening, cancel, listen, onClueText]);

  const handleUploadMic = useCallback(async () => {
    if (!recording) {
      await startRecording();
    } else {
      const blob = await stopRecording();
      setClueState({ status: "processing" });
      try {
        const res = await onClueAudio(blob);
        if (res.tts_audio_base64) playBase64Audio(res.tts_audio_base64);
        else if (res.rules.message) speakText(res.rules.message);
        setClueState({ status: "result", result: res.rules, transcript: res.transcript, clue: res.clue });
      } catch {
        setClueState({ status: "idle" });
      }
    }
  }, [recording, startRecording, stopRecording, onClueAudio]);

  const handleGuess = useCallback(async () => {
    const res = await onGuess();
    if (res.tts_audio_base64) playBase64Audio(res.tts_audio_base64);
    if (res.violation) {
      const msg = `Turn ends — limit reached (${res.guesses_this_turn} of ${res.limit ?? "unlimited"})`;
      speakText(msg);
      setGuessMsg(msg);
    } else {
      setGuessMsg(`Guess ${res.guesses_this_turn} of ${res.limit ?? "unlimited"}`);
    }
  }, [onGuess]);

  const isActive   = mode === "live" ? listening : recording;
  const isProcessing = clueState.status === "processing";
  const micError   = mode === "live" ? speechError : recError;

  // Red team uses the brand palette; blue team uses its own blue
  const teamGradient = currentTeam === "red"
    ? "linear-gradient(135deg, #3d0a1e 0%, #901f4b 60%, #d85b3f 100%)"
    : "linear-gradient(135deg, #0D2F6B 0%, #1A56A8 100%)";
  const teamLabel  = currentTeam === "red" ? "Red" : "Blue";
  const teamAccent = currentTeam === "red" ? "#d85b3f" : "#60a5fa";

  return (
    <div className="space-y-4">
      {/* Team / clue banner */}
      <div className="rounded-2xl p-4 flex items-start justify-between" style={{ background: teamGradient }}>
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
        <button
          onClick={onTurnEnd}
          className="font-heading text-[10px] tracking-[0.2em] uppercase text-white/65 border border-white/25 rounded-full px-3 py-1.5 hover:text-white/90 hover:border-white/45 transition-colors active:scale-95"
        >
          End Turn
        </button>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-1 p-1 rounded-xl surface">
        <button
          onClick={() => setMode("live")}
          disabled={!isSpeechRecognitionSupported()}
          className={[
            "flex-1 py-1.5 rounded-lg font-heading text-[10px] tracking-[0.2em] uppercase transition-all",
            mode === "live" ? "text-surface-900 font-bold shadow-md" : "text-white/55",
            !isSpeechRecognitionSupported() && "opacity-30 cursor-not-allowed",
          ].join(" ")}
          style={mode === "live" ? { background: "linear-gradient(135deg, #f5a521 0%, #d85b3f 100%)" } : {}}
        >
          Live · Browser
        </button>
        <button
          onClick={() => setMode("upload")}
          className={[
            "flex-1 py-1.5 rounded-lg font-heading text-[10px] tracking-[0.2em] uppercase transition-all",
            mode === "upload" ? "text-surface-900 font-bold shadow-md" : "text-white/55",
          ].join(" ")}
          style={mode === "upload" ? { background: "linear-gradient(135deg, #E8A830, #D4711E)" } : {}}
        >
          Record · Whisper
        </button>
      </div>

      {/* Microphone button */}
      <div className="flex flex-col items-center gap-3 py-2">
        <div className="relative flex items-center justify-center">
          {/* Pulsing rings when active */}
          {isActive && (
            <>
              <div className="absolute w-24 h-24 rounded-full border animate-pulse-ring"
                   style={{ borderColor: teamAccent, opacity: 0.5 }} />
              <div className="absolute w-24 h-24 rounded-full border animate-pulse-ring"
                   style={{ borderColor: teamAccent, opacity: 0.3, animationDelay: "0.5s" }} />
            </>
          )}
          <button
            disabled={!hasBoard || isProcessing}
            onClick={mode === "live" ? handleLiveMic : handleUploadMic}
            className={[
              "relative w-20 h-20 rounded-full flex items-center justify-center transition-all active:scale-95",
              !hasBoard && "opacity-30 cursor-not-allowed",
            ].join(" ")}
            style={{
              background: isActive
                ? teamGradient
                : isProcessing
                  ? "rgba(17,7,9,0.9)"
                  : "rgba(17,7,9,0.85)",
              border: `2px solid ${isActive ? teamAccent : "rgba(144,31,75,0.25)"}`,
              boxShadow: isActive
                ? `0 0 32px ${teamAccent}50, 0 0 64px ${teamAccent}20`
                : "0 2px 12px rgba(0,0,0,0.5)",
            }}
          >
            {isProcessing ? (
              <svg className="animate-spin w-6 h-6 text-brand-gold" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor"
                   style={{ color: isActive ? "#fff" : "rgba(255,255,255,0.75)" }} strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round"
                      d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              </svg>
            )}
          </button>
        </div>

        <p className="font-heading text-[10px] tracking-[0.2em] uppercase text-white/60">
          {!hasBoard
            ? "Scan the board first"
            : isProcessing
              ? "Analyzing…"
              : mode === "live"
                ? isActive ? "Listening — tap to cancel" : "Tap to speak the clue"
                : isActive ? "Recording — tap to stop" : "Tap to record"}
        </p>
        {micError && (
          <p className="text-red-400 text-xs font-heading tracking-wide text-center">{micError}</p>
        )}
      </div>

      {/* Rules result */}
      {clueState.status === "result" && (
        <RulesResultCard state={clueState} />
      )}

      {/* Guess + turn controls */}
      {currentClue && (
        <div className="space-y-2">
          <button
            onClick={handleGuess}
            className="w-full py-3 rounded-xl font-heading text-sm tracking-widest uppercase transition-all active:scale-95 surface text-white/75 hover:text-white/95"
          >
            Record Guess
          </button>
          {guessMsg && (
            <p className="text-center font-heading text-[10px] tracking-widest uppercase text-white/60">
              {guessMsg}
            </p>
          )}
        </div>
      )}
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
      style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5 min-w-0">
          {clue ? (
            <p className="font-heading text-xl font-bold tracking-widest text-card-bg leading-none">
              {clue.word} &mdash; {clue.number}
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

      {/* Message */}
      {result.message && (
        <p className="text-sm text-white/90 leading-snug">{result.message}</p>
      )}

      {/* Violations */}
      {result.violations.map((v, i) => (
        <div key={i} className="flex gap-2 items-start">
          <code className="text-[10px] text-brand-amber shrink-0 font-mono mt-px">{v.rule}</code>
          <p className="text-[11px] text-white/70">{v.description}</p>
        </div>
      ))}

      {level === "none" && (
        <p className="font-heading text-[10px] tracking-widest uppercase" style={{ color: cfg.text }}>
          Clue is legal
        </p>
      )}
    </div>
  );
}
