import type { BoardState, CardState, CardTeam } from "../types";

interface Props {
  board: BoardState | null;
  lowConfidence: boolean;
}

const TEAM_CLASS: Record<CardTeam, string> = {
  red:       "cn-card cn-card-revealed-red",
  blue:      "cn-card cn-card-revealed-blue",
  bystander: "cn-card cn-card-revealed-bystander",
  assassin:  "cn-card cn-card-revealed-assassin",
};

// Confidence: gold (high) → terracotta (medium) → crimson (low)
function confColor(conf: number): string {
  if (conf >= 0.85) return "#f5a521";
  if (conf >= 0.65) return "#d85b3f";
  return "#901f4b";
}

function WordCard({ card }: { card: CardState }) {
  const isRevealed = card.revealed && card.team;
  const baseClass = isRevealed ? TEAM_CLASS[card.team!] : "cn-card";
  const dimmed = card.confidence < 0.7;

  return (
    <div
      className={`${baseClass} relative text-[8px] sm:text-[9px] leading-none px-0.5`}
      style={{ opacity: dimmed ? 0.5 : 1 }}
    >
      {card.word ?? "—"}
      {dimmed && (
        <span
          className="absolute bottom-0.5 right-0.5 text-[6px] opacity-60"
          style={{ color: isRevealed ? "rgba(255,255,255,0.6)" : "#d85b3f" }}
        >
          {Math.round(card.confidence * 100)}%
        </span>
      )}
    </div>
  );
}

export function BoardOverlay({ board, lowConfidence }: Props) {
  if (!board) {
    return (
      <div className="surface rounded-2xl p-8 text-center space-y-3">
        <div className="brand-rule mb-4" />
        <p className="font-heading text-lg tracking-widest uppercase" style={{ color: "rgba(255,255,255,0.75)" }}>
          No Board Detected
        </p>
        <p className="text-xs" style={{ color: "rgba(255,255,255,0.55)" }}>
          Start scanning to see board state here.
        </p>
      </div>
    );
  }

  const conf = board.metadata.overall_confidence;
  const color = confColor(conf);
  const confLabel = conf >= 0.85 ? "High" : conf >= 0.65 ? "Medium" : "Low";

  const red  = board.score.red_remaining;
  const blue = board.score.blue_remaining;
  const revealed     = board.board.filter((c) => c.revealed);
  const redRevealed  = revealed.filter((c) => c.team === "red").length;
  const blueRevealed = revealed.filter((c) => c.team === "blue").length;

  return (
    <div className="space-y-3">
      {/* Confidence row */}
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[10px] font-heading tracking-widest uppercase" style={{ color: "rgba(255,255,255,0.55)" }}>
          {new Date(board.captured_at).toLocaleTimeString()}
        </span>
        <div className="flex items-center gap-2">
          {/* Segmented confidence bar using brand colors */}
          <div className="flex gap-0.5">
            {[0.33, 0.66, 1.0].map((threshold, i) => (
              <div
                key={i}
                className="w-4 h-1 rounded-full transition-all"
                style={{
                  background: conf >= threshold - 0.1
                    ? i === 0 ? "#901f4b" : i === 1 ? "#d85b3f" : "#f5a521"
                    : "rgba(255,255,255,0.07)",
                }}
              />
            ))}
          </div>
          <span className="text-[10px] font-heading tracking-wider" style={{ color }}>
            {lowConfidence ? "Low" : confLabel}
          </span>
        </div>
      </div>

      {/* Score strips */}
      {(red !== null || blue !== null || redRevealed > 0 || blueRevealed > 0) && (
        <div className="grid grid-cols-2 gap-2">
          <div
            className="rounded-xl px-3 py-2"
            style={{
              background: "rgba(144,31,75,0.12)",
              border: "1px solid rgba(144,31,75,0.3)",
            }}
          >
            <p className="font-heading text-[9px] tracking-[0.25em] uppercase" style={{ color: "rgba(216,91,63,0.6)" }}>Red</p>
            <p className="font-heading text-base font-bold leading-none" style={{ color: "#d85b3f" }}>
              {red !== null ? `${red} left` : `${redRevealed} found`}
            </p>
          </div>
          <div
            className="rounded-xl px-3 py-2"
            style={{
              background: "rgba(26,86,168,0.12)",
              border: "1px solid rgba(26,86,168,0.3)",
            }}
          >
            <p className="font-heading text-[9px] tracking-[0.25em] uppercase text-blue-300/70">Blue</p>
            <p className="font-heading text-base font-bold text-blue-400 leading-none">
              {blue !== null ? `${blue} left` : `${blueRevealed} found`}
            </p>
          </div>
        </div>
      )}

      {/* Card grid */}
      <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
        {board.board.map((card) => (
          <WordCard key={card.position} card={card} />
        ))}
      </div>

      {/* Issues */}
      {board.metadata.issues.length > 0 && (
        <div
          className="rounded-xl p-3 space-y-1"
          style={{
            background: "rgba(216,91,63,0.07)",
            border: "1px solid rgba(216,91,63,0.2)",
          }}
        >
          {board.metadata.issues.map((issue, i) => (
            <p key={i} className="text-[11px]" style={{ color: "#d85b3f" }}>{issue}</p>
          ))}
        </div>
      )}
    </div>
  );
}
