import { useCallback } from "react";
import { useCamera } from "../hooks/useCamera";
import type { BoardState } from "../types";

interface Props {
  sessionId: string;
  onBoardUpdate: (board: BoardState, lowConfidence: boolean) => void;
  onError: (msg: string) => void;
  onFrameSend: (frame: string) => Promise<{ board: BoardState; low_confidence: boolean }>;
}

export function CameraCapture({ onBoardUpdate, onError, onFrameSend }: Props) {
  const handleFrame = useCallback(
    async (base64: string) => {
      try {
        const result = await onFrameSend(base64);
        onBoardUpdate(result.board, result.low_confidence);
      } catch (err) {
        onError(err instanceof Error ? err.message : "Frame send failed");
      }
    },
    [onFrameSend, onBoardUpdate, onError]
  );

  const {
    videoRef,
    canvasRef,
    active,
    scanning,
    error,
    startCamera,
    stopCamera,
    startScanning,
    stopScanning,
  } = useCamera({ onFrame: handleFrame, intervalMs: 5000 });

  return (
    <div className="relative w-full rounded-2xl overflow-hidden bg-surface-800" style={{ aspectRatio: "4/3" }}>
      {/* Video feed */}
      <video
        ref={videoRef}
        className="w-full h-full object-cover"
        playsInline
        muted
        autoPlay
      />
      <canvas ref={canvasRef} className="hidden" />

      {/* Scanning indicator — amber pulsing ring */}
      {scanning && (
        <div className="absolute inset-0 pointer-events-none">
          {/* Corner brackets */}
          <div className="absolute inset-4">
            <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-brand-gold rounded-tl" />
            <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-brand-gold rounded-tr" />
            <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-brand-gold rounded-bl" />
            <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-brand-gold rounded-br" />
          </div>
          {/* Status label */}
          <div className="absolute top-4 inset-x-0 flex justify-center">
            <div className="bg-black/50 backdrop-blur-sm rounded-full px-4 py-1 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-gold animate-scan-line" />
              <span className="font-heading text-[10px] tracking-[0.3em] uppercase text-brand-gold">
                Scanning
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 5×5 alignment guide (shown when active but not scanning) */}
      {active && !scanning && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div
            className="grid opacity-15"
            style={{ gridTemplateColumns: "repeat(5, 1fr)", gap: "2px", width: "82%", aspectRatio: "5/3" }}
          >
            {Array.from({ length: 25 }).map((_, i) => (
              <div key={i} className="border border-brand-gold rounded-sm" />
            ))}
          </div>
          <div className="absolute bottom-4 inset-x-0 flex justify-center">
            <span className="font-heading text-[10px] tracking-[0.25em] uppercase text-white/70">
              Align board to grid
            </span>
          </div>
        </div>
      )}

      {/* Idle state */}
      {!active && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-surface-900/90">
          {error && (
            <p className="text-red-400 text-xs text-center px-6 font-heading tracking-wide">{error}</p>
          )}
          {!error && (
            <p className="text-white/70 text-xs text-center px-8 font-heading tracking-[0.15em] uppercase">
              Point your phone at the Codenames board
            </p>
          )}
          <button onClick={startCamera} className="btn-primary">
            Start Camera
          </button>
        </div>
      )}

      {/* Controls bar */}
      {active && (
        <div className="absolute bottom-0 inset-x-0 flex justify-center gap-3 p-3 bg-gradient-to-t from-black/70 to-transparent">
          {!scanning ? (
            <button onClick={startScanning} className="btn-primary text-xs px-5 py-2">
              Start Scanning
            </button>
          ) : (
            <button
              onClick={stopScanning}
              className="btn-ghost text-brand-amber border-brand-amber/30 text-xs px-5 py-2"
            >
              Pause
            </button>
          )}
          <button onClick={stopCamera} className="btn-ghost text-xs px-4 py-2">
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
