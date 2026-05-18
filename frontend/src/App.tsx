import { useState, useCallback, useEffect } from "react";
import { CameraCapture } from "./components/CameraCapture";
import { BoardOverlay } from "./components/BoardOverlay";
import { VoiceControls } from "./components/VoiceControls";
import { api } from "./lib/api";
import type { BoardState, Team, RulesResult } from "./types";

type View = "camera" | "board" | "game";

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardState | null>(null);
  const [lowConfidence, setLowConfidence] = useState(false);
  const [currentTeam, setCurrentTeam] = useState<Team>("red");
  const [currentClue, setCurrentClue] = useState<{ word: string; number: number } | null>(null);
  const [guessesThisTurn, setGuessesThisTurn] = useState(0);
  const [view, setView] = useState<View>("camera");
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

  const handleStartGame = useCallback(async () => {
    if (!sessionId) return;
    try {
      const { game_id } = await api.startGame(sessionId);
      setGameId(game_id);
      setCurrentTeam("red");
      setCurrentClue(null);
      setGuessesThisTurn(0);
      setView("game");
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

  const navItems: { id: View; label: string }[] = [
    { id: "camera", label: "Camera" },
    { id: "board",  label: "Board" },
    { id: "game",   label: "Game" },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="px-5 pt-8 pb-4 flex items-center justify-between">
        <div>
          <img src="/logo.png" alt="Codenames" className="h-8 mb-0.5" />
          <p className="font-heading text-[10px] tracking-[0.3em] uppercase text-brand-gold/70">
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

      {/* Header divider */}
      <div className="brand-rule mx-5 mb-4" />

      {/* Navigation */}
      <nav className="px-5 pb-4">
        <div className="flex gap-1 p-1 rounded-xl surface">
          {navItems.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={[
                "flex-1 py-2 rounded-lg font-heading text-xs tracking-widest uppercase transition-all",
                view === id
                  ? "text-surface-900 font-bold shadow-md"
                  : "text-white/60 hover:text-white/90",
              ].join(" ")}
              style={view === id ? { background: "linear-gradient(135deg, #f5a521 0%, #d85b3f 100%)" } : {}}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      {/* Content */}
      <main className="flex-1 px-5 space-y-4">
        {view === "camera" && (
          <div className="space-y-4">
            <CameraCapture
              sessionId={sessionId}
              onBoardUpdate={handleBoardUpdate}
              onError={console.error}
              onFrameSend={handleFrameSend}
            />
            {board && (
              <div className="flex items-center justify-between text-xs px-1">
                <span className="text-white/70">
                  {board.board.filter((c) => c.word).length} / 25 cards detected
                </span>
                <button
                  onClick={() => setView("board")}
                  className="font-heading tracking-widest uppercase text-brand-gold text-[10px] hover:text-brand-amber transition-colors"
                >
                  View board
                </button>
              </div>
            )}
          </div>
        )}

        {view === "board" && (
          <div className="space-y-4">
            <BoardOverlay board={board} lowConfidence={lowConfidence} />
            {board && !gameId && (
              <button onClick={handleStartGame} className="btn-primary w-full">
                Start Game
              </button>
            )}
          </div>
        )}

        {view === "game" && (
          <div className="space-y-4">
            {!gameId ? (
              <div className="text-center py-12 space-y-4">
                <p className="font-heading text-lg tracking-widest uppercase text-white/70">No active game</p>
                <p className="text-sm text-white/55">Scan the board first, then start a game.</p>
                <button onClick={() => setView("camera")} className="btn-ghost">
                  Open Camera
                </button>
              </div>
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
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
