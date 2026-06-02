import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { BoardOverlay } from "./BoardOverlay";
import { captureVideoFrame } from "../lib/captureFrame";
import { api } from "../lib/api";
import type { BoardState } from "../types";

type Engine = "auto" | "cv";
type PlaybackMode = "realtime" | "frame";

interface FrameDiag {
  latencyMs: number;
  notes: string;
  confidence: number;
  wordsRead: number;
  revealed: number;
  partial: boolean;
}

interface Props {
  sessionId: string;
}

const ENGINE_HINT: Record<Engine, string> = {
  auto: "LLM reads words once, then the CV service tracks perspective + team colours.",
  cv: "Every frame goes to the CV service — OCR + perspective on the first frame, colour tracking after.",
};
const MODE_HINT: Record<PlaybackMode, string> = {
  realtime: "Plays at speed; captures on an interval. Overlay lags slightly, like a live feed.",
  frame: "Pauses on each captured frame until the result returns, so the overlay is always aligned.",
};

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Resolve once the video has painted the frame at its current time. A paused
 * video may never present a *new* frame (so requestVideoFrameCallback / rAF
 * would never fire), so we race against a short timeout — the loop must always
 * advance even if no fresh frame is presented.
 */
function nextPaintedFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const v = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (typeof v.requestVideoFrameCallback === "function") {
      v.requestVideoFrameCallback(() => finish());
    } else {
      requestAnimationFrame(() => finish());
    }
    setTimeout(finish, 250);
  });
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    // Seeking to the current time fires no 'seeked' event in some browsers —
    // resolve immediately so the caller never hangs.
    if (Math.abs(video.currentTime - time) < 0.001) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", finish);
      video.removeEventListener("error", finish);
      resolve();
    };
    video.addEventListener("seeked", finish);
    video.addEventListener("error", finish);
    video.currentTime = time;
    setTimeout(finish, 1000); // safety net if 'seeked' never fires
  });
}

function Segmented({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: { v: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex rounded-lg overflow-hidden border border-white/10"
      style={disabled ? { opacity: 0.45 } : undefined}
    >
      {options.map((o) => (
        <button
          key={o.v}
          disabled={disabled}
          onClick={() => !disabled && onChange(o.v)}
          className="flex-1 px-2 py-1.5 font-heading text-[10px] tracking-widest uppercase transition-colors disabled:cursor-not-allowed"
          style={
            value === o.v
              ? { background: "rgba(245,165,33,0.18)", color: "#f5a521" }
              : { color: "rgba(255,255,255,0.45)" }
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg px-2 py-1.5" style={{ background: "rgba(255,255,255,0.04)" }}>
      <p className="font-heading text-[8px] tracking-[0.2em] uppercase text-white/40">{label}</p>
      <p className="font-heading text-sm font-bold leading-tight" style={{ color: accent ?? "#fff" }}>
        {value}
      </p>
    </div>
  );
}

export function VideoTestView({ sessionId }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState("16/9");

  const [board, setBoard] = useState<BoardState | null>(null);
  const [lowConfidence, setLowConfidence] = useState(false);

  const [engine, setEngine] = useState<Engine>("auto");
  const [mode, setMode] = useState<PlaybackMode>("realtime");
  const [intervalSec, setIntervalSec] = useState(3);
  const [speed, setSpeed] = useState(1);

  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [diag, setDiag] = useState<FrameDiag | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  // Mirror live-adjustable settings into refs so the async capture loop reads
  // current values rather than the values captured when the loop started.
  const runningRef = useRef(false);
  const engineRef = useRef(engine);
  const modeRef = useRef(mode);
  const intervalRef = useRef(intervalSec);
  useEffect(() => { engineRef.current = engine; }, [engine]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { intervalRef.current = intervalSec; }, [intervalSec]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = speed; }, [speed]);

  useEffect(
    () => () => {
      runningRef.current = false;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    []
  );

  const resetBoard = useCallback(async () => {
    try {
      await api.resetBoard(sessionId);
    } catch {
      /* a missing board is fine */
    }
    setBoard(null);
    setFrameCount(0);
    setDiag(null);
    setError(null);
  }, [sessionId]);

  const loadFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("video/")) {
        setError(`Not a video file: ${file.name}`);
        return;
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      setVideoUrl(url);
      setFileName(file.name);
      runningRef.current = false;
      setRunning(false);
      void resetBoard();
    },
    [resetBoard]
  );

  const processFrame = useCallback(
    async (frame: string) => {
      const t0 = performance.now();
      setBusy(true);
      try {
        const res = await api.sendFrame(sessionId, frame, "image/jpeg", engineRef.current);
        setBoard(res.board);
        setLowConfidence(res.low_confidence);
        setDiag({
          latencyMs: Math.round(performance.now() - t0),
          notes: res.board.metadata.notes || "—",
          confidence: res.board.metadata.overall_confidence,
          wordsRead: res.board.board.filter((c) => c.word).length,
          revealed: res.board.board.filter((c) => c.revealed).length,
          partial: res.board.metadata.partial_visibility,
        });
        setFrameCount((n) => n + 1);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [sessionId]
  );

  // Interruptible wait that bails the moment capture is stopped.
  const waitInterruptible = useCallback(async (ms: number) => {
    const step = 100;
    for (let w = 0; w < ms && runningRef.current; w += step) {
      await new Promise((r) => setTimeout(r, Math.min(step, ms - w)));
    }
  }, []);

  const runRealtime = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    try {
      await video.play();
    } catch {
      /* autoplay may be blocked until user gesture; Start button is the gesture */
    }
    while (runningRef.current && !video.ended) {
      const start = performance.now();
      const frame = captureVideoFrame(video, canvas);
      if (frame) await processFrame(frame);
      if (!runningRef.current) break;
      const elapsed = performance.now() - start;
      await waitInterruptible(Math.max(0, intervalRef.current * 1000 - elapsed));
    }
    runningRef.current = false;
    setRunning(false);
  }, [processFrame, waitInterruptible]);

  const runFrameAccurate = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !isFinite(video.duration) || video.duration <= 0) {
      runningRef.current = false;
      setRunning(false);
      return;
    }
    video.pause();
    // Land just shy of the end so the final frame is a real, decodable position.
    const END = Math.max(0, video.duration - 0.05);
    if (video.currentTime >= END) await seekTo(video, 0);
    await nextPaintedFrame(video);
    // Capture at the top of the loop, then advance — so the clamped final frame
    // (the end-of-game board state) is always captured before we stop.
    while (runningRef.current) {
      const frame = captureVideoFrame(video, canvas);
      if (frame) await processFrame(frame);
      if (!runningRef.current) break;
      if (video.currentTime >= END) break; // just captured the final frame
      const next = Math.min(END, video.currentTime + intervalRef.current);
      if (next <= video.currentTime + 0.001) break; // can't advance further
      await seekTo(video, next);
      await nextPaintedFrame(video);
    }
    runningRef.current = false;
    setRunning(false);
  }, [processFrame]);

  const start = useCallback(() => {
    if (!videoUrl || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    if (modeRef.current === "frame") void runFrameAccurate();
    else void runRealtime();
  }, [videoUrl, runFrameAccurate, runRealtime]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    videoRef.current?.pause();
  }, []);

  const changeEngine = useCallback(
    (e: Engine) => {
      if (e === engineRef.current) return;
      setEngine(e);
      // A different engine should re-read the board from scratch.
      void resetBoard();
    },
    [resetBoard]
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) loadFile(file);
    },
    [loadFile]
  );

  const onScrub = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value);
    if (videoRef.current) videoRef.current.currentTime = t;
    setCurrentTime(t);
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-5 pt-8 pb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="Codenames" className="h-10" />
          <div className="w-0.5 h-8 bg-brand-gold/40" />
          <div>
            <p className="font-heading text-xl font-bold tracking-tight uppercase text-brand-gold leading-none">
              CV Test Harness
            </p>
            <p className="font-heading text-[9px] tracking-[0.25em] uppercase text-white/40 mt-1">
              Video-fed pipeline preview
            </p>
          </div>
        </div>
        <a
          href={typeof window !== "undefined" ? window.location.pathname : "/"}
          className="font-heading text-[10px] tracking-widest uppercase text-white/40 hover:text-brand-gold transition-colors"
        >
          ← Back to live
        </a>
      </header>

      <main className="flex-1 px-5 pb-6">
        <div className="flex flex-col md:flex-row md:items-start gap-4">
          {/* Video + overlay */}
          <div className="md:flex-[3]">
            <div
              className="relative w-full rounded-2xl overflow-hidden bg-surface-800"
              style={{ aspectRatio }}
              onDrop={onDrop}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
            >
              <video
                ref={videoRef}
                src={videoUrl ?? undefined}
                className="w-full h-full object-cover"
                playsInline
                muted
                preload="auto"
                onLoadedMetadata={() => {
                  const v = videoRef.current;
                  if (v?.videoWidth && v?.videoHeight) setAspectRatio(`${v.videoWidth}/${v.videoHeight}`);
                  if (v) {
                    setDuration(v.duration);
                    v.playbackRate = speed;
                  }
                }}
                onDurationChange={() => {
                  const v = videoRef.current;
                  if (v && isFinite(v.duration)) setDuration(v.duration);
                }}
                onTimeUpdate={() => {
                  const v = videoRef.current;
                  if (v) setCurrentTime(v.currentTime);
                }}
                onEnded={stop}
              />
              <canvas ref={canvasRef} className="hidden" />

              {videoUrl && <BoardOverlay board={board} lowConfidence={lowConfidence} overlay />}

              {busy && (
                <div className="absolute top-3 right-3 flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-gold animate-pulse" />
                  <span className="font-heading text-[9px] tracking-widest uppercase text-brand-gold">
                    Analyzing
                  </span>
                </div>
              )}

              {/* Drop zone / empty state */}
              {!videoUrl && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center gap-4 transition-colors"
                  style={{ background: dragOver ? "rgba(245,165,33,0.10)" : "rgba(13,7,9,0.92)" }}
                >
                  <p className="font-heading text-xs tracking-[0.2em] uppercase text-white/60 text-center px-8">
                    Drop a game video here
                  </p>
                  <button onClick={() => fileInputRef.current?.click()} className="btn-primary text-xs px-5 py-2">
                    Choose video…
                  </button>
                </div>
              )}
            </div>

            {/* Playback controls */}
            {videoUrl && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center gap-3">
                  <button
                    onClick={running ? stop : start}
                    className={running ? "btn-ghost text-brand-amber border-brand-amber/40 text-xs px-4 py-2" : "btn-primary text-xs px-5 py-2"}
                  >
                    {running ? "Stop" : "Start capture"}
                  </button>
                  <span className="font-heading text-[11px] tracking-wider text-white/50 tabular-nums">
                    {fmtTime(currentTime)} / {fmtTime(duration)}
                  </span>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="ml-auto font-heading text-[10px] tracking-widest uppercase text-white/40 hover:text-brand-gold transition-colors"
                  >
                    Change video
                  </button>
                </div>
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.05}
                  value={currentTime}
                  onChange={onScrub}
                  className="w-full accent-brand-gold"
                />
                {fileName && (
                  <p className="font-heading text-[9px] tracking-wider uppercase text-white/30 truncate">{fileName}</p>
                )}
              </div>
            )}
          </div>

          {/* Controls + diagnostics */}
          <div className="md:flex-1 md:sticky md:top-4 space-y-4">
            <div className="surface rounded-2xl p-4 space-y-4">
              <div className="space-y-1.5">
                <p className="font-heading text-[10px] tracking-[0.25em] uppercase text-white/50">Backend path</p>
                <Segmented
                  value={engine}
                  options={[
                    { v: "auto", label: "Auto" },
                    { v: "cv", label: "Pure CV" },
                  ]}
                  onChange={(v) => changeEngine(v as Engine)}
                />
                <p className="text-[10px] leading-snug text-white/40">{ENGINE_HINT[engine]}</p>
              </div>

              <div className="space-y-1.5">
                <p className="font-heading text-[10px] tracking-[0.25em] uppercase text-white/50">Playback mode</p>
                <Segmented
                  value={mode}
                  disabled={running}
                  options={[
                    { v: "realtime", label: "Real-time" },
                    { v: "frame", label: "Frame-step" },
                  ]}
                  onChange={(v) => setMode(v as PlaybackMode)}
                />
                <p className="text-[10px] leading-snug text-white/40">
                  {running ? "Stop capture to switch mode." : MODE_HINT[mode]}
                </p>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="font-heading text-[10px] tracking-[0.25em] uppercase text-white/50">Capture interval</p>
                  <span className="font-heading text-[11px] text-brand-gold tabular-nums">{intervalSec.toFixed(1)}s</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={10}
                  step={0.5}
                  value={intervalSec}
                  onChange={(e) => setIntervalSec(Number(e.target.value))}
                  className="w-full accent-brand-gold"
                />
              </div>

              {mode === "realtime" && (
                <div className="space-y-1.5">
                  <p className="font-heading text-[10px] tracking-[0.25em] uppercase text-white/50">Playback speed</p>
                  <Segmented
                    value={String(speed)}
                    options={[
                      { v: "0.5", label: "0.5×" },
                      { v: "1", label: "1×" },
                      { v: "2", label: "2×" },
                    ]}
                    onChange={(v) => setSpeed(Number(v))}
                  />
                </div>
              )}

              <button
                onClick={() => void resetBoard()}
                className="w-full btn-ghost text-[11px] py-2"
              >
                Reset board (force rescan)
              </button>
            </div>

            {/* Diagnostics */}
            <div className="surface rounded-2xl p-4 space-y-3">
              <p className="font-heading text-[10px] tracking-[0.25em] uppercase text-white/50">Diagnostics</p>
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Frames" value={String(frameCount)} />
                <Stat label="Latency" value={diag ? `${diag.latencyMs} ms` : "—"} />
                <Stat
                  label="Confidence"
                  value={diag ? `${Math.round(diag.confidence * 100)}%` : "—"}
                  accent={diag ? (diag.confidence >= 0.85 ? "#f5a521" : diag.confidence >= 0.65 ? "#d85b3f" : "#901f4b") : undefined}
                />
                <Stat label="Words read" value={diag ? `${diag.wordsRead}/25` : "—"} />
                <Stat label="Revealed" value={diag ? `${diag.revealed}/25` : "—"} />
                <Stat label="Partial" value={diag ? (diag.partial ? "yes" : "no") : "—"} />
              </div>
              <div className="rounded-lg px-2 py-1.5" style={{ background: "rgba(255,255,255,0.04)" }}>
                <p className="font-heading text-[8px] tracking-[0.2em] uppercase text-white/40">Backend notes</p>
                <p className="text-[11px] font-mono leading-tight text-white/70 break-words">
                  {diag?.notes ?? "—"}
                </p>
              </div>
              {error && (
                <div className="rounded-lg p-2" style={{ background: "rgba(216,91,63,0.10)", border: "1px solid rgba(216,91,63,0.3)" }}>
                  <p className="text-[11px]" style={{ color: "#d85b3f" }}>{error}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
