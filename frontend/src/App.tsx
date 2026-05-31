import { useState, useCallback, useEffect, useRef } from "react";
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
  const [editingCard, setEditingCard] = useState<{ position: number; word: string } | null>(null);
  const [editWord, setEditWord] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

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

  const handleRescan = useCallback(async () => {
    if (!sessionId) return;
    await api.resetBoard(sessionId);
    setBoard(null);
  }, [sessionId]);

  const handleCardEdit = useCallback((position: number, word: string) => {
    setEditingCard({ position, word });
    setEditWord(word);
    setTimeout(() => editInputRef.current?.select(), 50);
  }, []);

  const handleCardSave = useCallback(async () => {
    if (!sessionId || !editingCard) return;
    const updated = await api.updateCard(sessionId, editingCard.position, editWord);
    setBoard(updated);
    setEditingCard(null);
  }, [sessionId, editingCard, editWord]);

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
                <BoardOverlay
                  board={board}
                  lowConfidence={lowConfidence}
                  overlay
                  onRescan={handleRescan}
                  onCardEdit={handleCardEdit}
                />
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
      {/* Card edit modal */}
      {editingCard !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setEditingCard(null)}>
          <div className="surface rounded-2xl p-5 space-y-4 w-72 mx-4" onClick={(e) => e.stopPropagation()}>
            <p className="font-heading text-[10px] tracking-[0.25em] uppercase text-white/50">
              Edit card {editingCard.position + 1}
            </p>
            <input
              ref={editInputRef}
              type="text"
              value={editWord}
              onChange={(e) => setEditWord(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter") handleCardSave(); if (e.key === "Escape") setEditingCard(null); }}
              autoFocus
              className="w-full px-3 py-2 rounded-lg bg-transparent border border-white/20 focus:border-brand-gold outline-none font-heading text-lg text-white tracking-widest uppercase"
              placeholder="WORD"
            />
            <div className="flex gap-2">
              <button onClick={() => setEditingCard(null)} className="flex-1 btn-ghost text-sm">Cancel</button>
              <button onClick={handleCardSave} className="flex-1 btn-primary text-sm">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
