import { useState, useCallback, useEffect } from "react";
import { CameraCapture } from "./components/CameraCapture";
import { BoardOverlay } from "./components/BoardOverlay";
import { VoiceControls } from "./components/VoiceControls";
import { GameSetup } from "./components/GameSetup";
import { VideoTestView } from "./components/VideoTestView";
import { CardEditModal } from "./components/CardEditModal";
import { api } from "./lib/api";
import { speakText } from "./hooks/useVoice";
import type { BoardState, GameUpdate, Team, CardTeam, TeamEdit } from "./types";

const testMode =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("test")
    : null;
const isVideoTest = testMode === "video";
// Demo mode: static board seeded server-side — no camera, no vision-API credits.
const isBoardDemo = testMode === "board";

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
  const [editingCard, setEditingCard] = useState<
    { position: number; word: string; team: CardTeam | null; manual: boolean } | null
  >(null);

  useEffect(() => {
    let ignore = false;
    api.createSession()
      .then(({ session_id }) => { if (!ignore) setSessionId(session_id); })
      .catch((e: Error) => { if (!ignore) setInitError(e.message); });
    return () => { ignore = true; };
  }, []);

  // Demo mode: seed the static board as soon as the session exists.
  useEffect(() => {
    if (!isBoardDemo || !sessionId) return;
    let ignore = false;
    api.seedDemoBoard(sessionId)
      .then(({ board: b }) => { if (!ignore) setBoard(b); })
      .catch((e: Error) => { if (!ignore) setInitError(e.message); });
    return () => { ignore = true; };
  }, [sessionId]);

  const handleBoardUpdate = useCallback((b: BoardState, low: boolean) => {
    setBoard(b);
    setLowConfidence(low);
  }, []);

  // Board-driven guess tracking: every board mutation (frame or card edit)
  // returns the turn's guess state; the referee speaks any announcement.
  const applyGameUpdate = useCallback((game: GameUpdate | null) => {
    if (!game) return;
    setGuessesThisTurn(game.guesses_this_turn);
    if (game.message) speakText(game.message);
  }, []);

  const handleFrameSend = useCallback(
    async (base64: string) => {
      if (!sessionId) throw new Error("No session");
      const res = await api.sendFrame(sessionId, base64);
      applyGameUpdate(res.game);
      return res;
    },
    [sessionId, applyGameUpdate]
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

  const handleTranscriptClue = useCallback(
    async (transcript: string) => {
      if (!sessionId) throw new Error("No session");
      const res = await api.validateClueTranscript(sessionId, transcript);
      // The clue stands unless confidently illegal — matches the worker.
      if (res.clue && res.clue.number !== null && res.rules && res.rules.intervention_level !== "stop") {
        setCurrentClue({ word: res.clue.word, number: res.clue.number });
        setGuessesThisTurn(0);
      }
      return res;
    },
    [sessionId]
  );

  const handleRescan = useCallback(async () => {
    if (!sessionId) return;
    // Demo mode: re-seed a fresh board (clears simulated reveals) — there's no
    // camera to rescan from.
    if (isBoardDemo) {
      const { board: b } = await api.seedDemoBoard(sessionId);
      setBoard(b);
      return;
    }
    await api.resetBoard(sessionId);
    setBoard(null);
  }, [sessionId]);

  const handleCardEdit = useCallback(
    (position: number, word: string, team: CardTeam | null, manual: boolean) => {
      setEditingCard({ position, word, team, manual });
    },
    []
  );

  const handleCardApply = useCallback(
    async (word: string, team?: TeamEdit) => {
      if (!sessionId || !editingCard) return;
      const { board: updated, game } = await api.updateCard(sessionId, editingCard.position, { word, team });
      setBoard(updated);
      applyGameUpdate(game);
      setEditingCard(null);
    },
    [sessionId, editingCard, applyGameUpdate]
  );

  const handleTurnEnd = useCallback(async () => {
    if (!sessionId) return;
    const res = await api.endTurn(sessionId);
    if (res.message) speakText(res.message); // e.g. ended with zero guesses
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

  // CV test harness — feed a recorded game video through the pipeline instead of
  // the live camera. Reachable at ?test=video.
  if (isVideoTest) {
    return <VideoTestView sessionId={sessionId} />;
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
        <div className="flex items-center gap-3">
          <a
            href="?test=video"
            className="font-heading text-[10px] tracking-widest uppercase text-white/40 hover:text-brand-gold transition-colors"
          >
            🎬 Video test
          </a>
          <a
            href="?test=board"
            className="font-heading text-[10px] tracking-widest uppercase text-white/40 hover:text-brand-gold transition-colors"
          >
            🎲 Demo board
          </a>
          {gameId && (
            <div
              className="flex items-center gap-1.5 rounded-full px-3 py-1"
              style={{ background: "rgba(245,165,33,0.08)", border: "1px solid rgba(245,165,33,0.25)" }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-brand-gold animate-pulse" />
              <span className="font-heading text-[10px] tracking-widest uppercase text-brand-gold">Live</span>
            </div>
          )}
        </div>
      </header>

      {/* Main layout: camera+board left (75%), game panel right (25%) */}
      <main className="flex-1 px-5 pb-6">
        <div className="flex flex-col md:flex-row md:items-start gap-4">

          {/* Camera + board overlay — full width on mobile, 75% on desktop.
              Demo mode swaps the camera for a static surface (zero credits). */}
          <div className="md:flex-[3]">
            <div className="relative">
              {isBoardDemo ? (
                <div className="w-full rounded-2xl bg-surface-800" style={{ aspectRatio: "4/3" }} />
              ) : (
                <CameraCapture
                  sessionId={sessionId}
                  onBoardUpdate={handleBoardUpdate}
                  onError={console.error}
                  onFrameSend={handleFrameSend}
                  autoStart
                />
              )}
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
            {isBoardDemo && (
              <p className="mt-2 text-center font-heading text-[10px] tracking-[0.25em] uppercase text-white/40">
                🎲 Demo board — camera off, no API credits. Tap a card to simulate a reveal.
              </p>
            )}
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
                onClueTranscript={handleTranscriptClue}
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
      {/* Card edit modal — word + team (team override pins against CV/LLM) */}
      {editingCard !== null && (
        <CardEditModal
          position={editingCard.position}
          word={editingCard.word}
          team={editingCard.team}
          manual={editingCard.manual}
          onApply={handleCardApply}
          onClose={() => setEditingCard(null)}
        />
      )}
    </div>
  );
}
