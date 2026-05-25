import { useState, useCallback, useEffect } from "react";
import { CameraCapture } from "./components/CameraCapture";
import { BoardOverlay } from "./components/BoardOverlay";
import { VoiceControls } from "./components/VoiceControls";
import { GameSetup } from "./components/GameSetup";
import { api } from "./lib/api";
import type { BoardState, Team, RulesResult } from "./types";

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardState | null>(null);
  const [lowConfidence, setLowConfidence] = useState(false);
  const [currentTeam, setCurrentTeam] = useState<Team>("red");
  const [currentClue, setCurrentClue] = useState<{ word: string; number: number } | null>(null);
  const [guessesThisTurn, setGuessesThisTurn] = useState(0);
  const [timerSeconds, setTimerSeconds] = useState<number | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    api.createSession()
      .then(({ session_id }) => setSessionId(session_id))
      .catch((e: Error) => setInitError(e.message));
  }, []);

  const handleBoardUpdate = useCallback((b: BoardState, low: boolean) => {
    setBoard(b);
    setLowConfidence(low);
  }, []);

  const handleFrameSend = useCallback(
    async (base64: string) => {
      if (!sessionId) throw new Error("No session");
      return api.sendFrame(sessionId, base64);
    },
    [sessionId]
  );

  const handleStartGame = useCallback(async (firstTeam: Team, timer: number | null) => {
    if (!sessionId) return;
    try {
      const { game_id } = await api.startGame(sessionId);
      setGameId(game_id);
      setCurrentTeam(firstTeam);
      setCurrentClue(null);
      setGuessesThisTurn(0);
      setTimerSeconds(timer);
    } catch (e) {
      alert((e as Error).message);
    }
  }, [sessionId]);

  const handleAudioClue = useCallback(
    async (blob: Blob) => {
      if (!sessionId) throw new Error("No session");
      const res = await api.sendAudioClue(sessionId, blob);
      if (res.rules.valid && res.clue) {
        setCurrentClue(res.clue);
        setGuessesThisTurn(0);
      }
      return res;
    },
    [sessionId]
  );

  const handleTextClue = useCallback(
    async (word: string, number: number): Promise<RulesResult> => {
      if (!sessionId) throw new Error("No session");
      const result = await api.validateClue(sessionId, word, number);
      if (result.valid) {
        setCurrentClue({ word, number });
        setGuessesThisTurn(0);
      }
      return result;
    },
    [sessionId]
  );

  const handleGuess = useCallback(async () => {
    if (!sessionId) throw new Error("No session");
    const res = await api.recordGuess(sessionId);
    setGuessesThisTurn(res.guesses_this_turn);
    return res;
  }, [sessionId]);

  const handleTurnEnd = useCallback(async () => {
    if (!sessionId) return;
    const res = await api.endTurn(sessionId);
    setCurrentTeam(res.current_team as Team);
    setCurrentClue(null);
    setGuessesThisTurn(0);
  }, [sessionId]);

  if (initError) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center space-y-3">
          <p className="font-heading text-2xl font-bold tracking-widest text-brand-gold uppercase">Connection Failed</p>
          <p className="text-sm text-red-400">{initError}</p>
          <p className="text-xs text-white/50">Is the worker running? (npm run dev:worker)</p>
        </div>
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="space-y-3 text-center">
          <img src="/logo.png" alt="Codenames" className="h-10 mx-auto opacity-80" />
          <p className="font-heading text-xs tracking-[0.25em] text-brand-gold uppercase">Initializing session…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="px-5 pt-8 pb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="Codenames" className="h-10" />
          <div className="w-0.5 h-8 bg-brand-gold/40" />
          <p className="font-heading text-2xl font-bold tracking-tight uppercase text-brand-gold leading-none">
            AI Referee
          </p>
        </div>
        {gameId && (
          <div
            className="flex items-center gap-1.5 rounded-full px-3 py-1"
            style={{ background: "rgba(245,165,33,0.08)", border: "1px solid rgba(245,165,33,0.25)" }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-brand-gold animate-pulse" />
            <span className="font-heading text-[10px] tracking-widest uppercase text-brand-gold">Live</span>
          </div>
        )}
      </header>

      {/* Main layout: camera+board left (75%), game panel right (25%) */}
      <main className="flex-1 px-5 pb-6">
        <div className="flex flex-col md:flex-row md:items-start gap-4">

          {/* Camera + board overlay — full width on mobile, 75% on desktop */}
          <div className="md:flex-[3]">
            <div className="relative">
              <CameraCapture
                sessionId={sessionId}
                onBoardUpdate={handleBoardUpdate}
                onError={console.error}
                onFrameSend={handleFrameSend}
                autoStart
              />
              {board && (
                <BoardOverlay board={board} lowConfidence={lowConfidence} overlay />
              )}
            </div>
          </div>

          {/* Game panel — full width on mobile (scrolls below), 25% sidebar on desktop */}
          <div className="md:flex-1 md:sticky md:top-4 space-y-4">
            {!gameId ? (
              board ? (
                <GameSetup onStart={handleStartGame} />
              ) : (
                <p className="text-center font-heading text-sm tracking-widest uppercase text-white/40 py-4">
                  Scan the board to begin
                </p>
              )
            ) : (
              <VoiceControls
                sessionId={sessionId}
                hasBoard={!!board}
                onClueAudio={handleAudioClue}
                onClueText={handleTextClue}
                onGuess={handleGuess}
                onTurnEnd={handleTurnEnd}
                currentTeam={currentTeam}
                currentClue={currentClue}
                guessesThisTurn={guessesThisTurn}
                timerSeconds={timerSeconds}
              />
            )}
          </div>

        </div>
      </main>
    </div>
  );
}
