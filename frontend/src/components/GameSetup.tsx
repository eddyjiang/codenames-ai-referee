import { useEffect, useRef, useState } from "react";
import type { Team } from "../types";

interface Props {
  onStart: (firstTeam: Team, timerSeconds: number | null) => void;
}

const TIMER_PRESETS = [
  { label: "Off",  value: null },
  { label: "1:00", value: 60 },
  { label: "2:00", value: 120 },
  { label: "3:00", value: 180 },
];

export function GameSetup({ onStart }: Props) {
  const [firstTeam, setFirstTeam] = useState<Team>("red");
  const [timerValue, setTimerValue] = useState<number | null | "custom">(null);
  const [customDigits, setCustomDigits] = useState("0000"); // 4-digit MMSS string
  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (timerValue === "custom") {
      customInputRef.current?.focus();
    }
  }, [timerValue]);

  const customMins = parseInt(customDigits.slice(0, 2), 10);
  const customSecs = parseInt(customDigits.slice(2, 4), 10);
  const customTotal = customMins * 60 + customSecs;
  const resolvedTimer: number | null =
    timerValue === "custom"
      ? (customTotal > 0 && customSecs < 60 ? customTotal : null)
      : timerValue;

  const handleCustomKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (/^\d$/.test(e.key)) {
      setCustomDigits((prev) => prev.slice(1) + e.key);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      setCustomDigits((prev) => "0" + prev.slice(0, 3));
    }
  };

  const displayTime = `${customDigits.slice(0, 2)}:${customDigits.slice(2, 4)}`;

  const handleStart = () => onStart(firstTeam, resolvedTimer);

  return (
    <div className="surface rounded-2xl p-4 space-y-5">
      {/* First team */}
      <div className="space-y-2">
        <p className="font-heading text-[10px] tracking-[0.25em] uppercase text-white/50">
          Who goes first?
        </p>
        <div className="flex gap-2">
          {(["red", "blue"] as Team[]).map((team) => {
            const active = firstTeam === team;
            const gradient =
              team === "red"
                ? "linear-gradient(135deg, #901f4b 0%, #d85b3f 100%)"
                : "linear-gradient(135deg, #0D2F6B 0%, #1A56A8 100%)";
            return (
              <button
                key={team}
                onClick={() => setFirstTeam(team)}
                className="flex-1 py-2.5 rounded-xl font-heading text-sm font-bold tracking-widest uppercase transition-all active:scale-95"
                style={
                  active
                    ? { background: gradient, color: "#fff", boxShadow: "0 2px 12px rgba(0,0,0,0.4)", border: "1px solid transparent" }
                    : { background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.35)", border: "1px solid rgba(255,255,255,0.1)" }
                }
              >
                {team === "red" ? "Red" : "Blue"}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] font-heading tracking-widest text-white/30 text-center">
          {firstTeam === "red" ? "Red starts with 9 cards" : "Blue starts with 9 cards"}
        </p>
      </div>

      {/* Turn timer */}
      <div className="space-y-2">
        <p className="font-heading text-[10px] tracking-[0.25em] uppercase text-white/50">
          Turn timer
        </p>
        <div className="flex gap-1.5 flex-wrap">
          {TIMER_PRESETS.map(({ label, value }) => {
            const active = timerValue === value;
            return (
              <button
                key={label}
                onClick={() => setTimerValue(value)}
                className="px-3 py-1.5 rounded-lg font-heading text-[11px] tracking-widest uppercase transition-all active:scale-95"
                style={
                  active
                    ? { background: "linear-gradient(135deg, #f5a521 0%, #d85b3f 100%)", color: "#0c0608", fontWeight: 700, border: "1px solid transparent" }
                    : { background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.45)", fontWeight: 700, border: "1px solid rgba(255,255,255,0.1)" }
                }
              >
                {label}
              </button>
            );
          })}
          <button
            onClick={() => setTimerValue("custom")}
            className="px-3 py-1.5 rounded-lg font-heading text-[11px] tracking-widest uppercase transition-all active:scale-95"
            style={
              timerValue === "custom"
                ? { background: "linear-gradient(135deg, #f5a521 0%, #d85b3f 100%)", color: "#0c0608", fontWeight: 700, border: "1px solid transparent" }
                : { background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.45)", fontWeight: 700, border: "1px solid rgba(255,255,255,0.1)" }
            }
          >
            {timerValue === "custom" ? (
              <input
                ref={customInputRef}
                type="text"
                inputMode="numeric"
                value={displayTime}
                onChange={() => {}}
                onKeyDown={handleCustomKeyDown}
                className="w-12 bg-transparent text-center outline-none font-heading text-[11px] tracking-widest placeholder:text-current"
                style={{ color: "inherit", fontWeight: "inherit" }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : "Custom"}
          </button>
        </div>
      </div>

      {/* Start */}
      <button
        onClick={handleStart}
        disabled={timerValue === "custom" && !resolvedTimer}
        className="btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Start Game
      </button>
    </div>
  );
}
