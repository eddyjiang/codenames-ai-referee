import { useEffect, useRef, useState } from "react";
import type { CardTeam, TeamEdit } from "../types";

interface Props {
  position: number;
  word: string;
  team: CardTeam | null;
  manual: boolean;
  /** Apply edits. `team` undefined ⇒ leave team to CV/LLM (word-only edit). */
  onApply: (word: string, team?: TeamEdit) => void;
  onClose: () => void;
}

const TEAM_OPTIONS: { v: TeamEdit; label: string; bg: string }[] = [
  { v: "red", label: "Red", bg: "#901f4b" },
  { v: "blue", label: "Blue", bg: "#1A56A8" },
  { v: "bystander", label: "Bystander", bg: "#b89a6a" },
  { v: "assassin", label: "Assassin", bg: "#181010" },
  { v: "unrevealed", label: "Unrevealed", bg: "#3d1428" },
  { v: "auto", label: "Auto (CV/LLM)", bg: "#2a2a2a" },
];

export function CardEditModal({ position, word, team, manual, onApply, onClose }: Props) {
  const [editWord, setEditWord] = useState(word);
  const [picked, setPicked] = useState<TeamEdit | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.select(), 50);
    return () => clearTimeout(t);
  }, []);

  // The cell's current state, used to highlight a button when the user hasn't
  // picked yet: not pinned ⇒ "auto"; pinned face-up ⇒ "unrevealed"; else the team.
  const current: TeamEdit = !manual ? "auto" : team === null ? "unrevealed" : team;
  const active = picked ?? current;

  const save = () => onApply(editWord, picked);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="surface rounded-2xl p-5 space-y-4 w-80 mx-4" onClick={(e) => e.stopPropagation()}>
        <p className="font-heading text-[10px] tracking-[0.25em] uppercase text-white/50">
          Edit card {position + 1}
        </p>

        <input
          ref={inputRef}
          type="text"
          value={editWord}
          onChange={(e) => setEditWord(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") onClose();
          }}
          autoFocus
          className="w-full px-3 py-2 rounded-lg bg-transparent border border-white/20 focus:border-brand-gold outline-none font-heading text-lg text-white tracking-widest uppercase"
          placeholder="WORD"
        />

        <div className="space-y-1.5">
          <p className="font-heading text-[10px] tracking-[0.25em] uppercase text-white/50">
            Team — overrides CV / LLM
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {TEAM_OPTIONS.map((o) => {
              const on = active === o.v;
              return (
                <button
                  key={o.v}
                  onClick={() => setPicked(o.v)}
                  className="font-heading text-[11px] tracking-wider uppercase px-2 py-1.5 rounded-lg border transition-all"
                  style={{
                    background: on ? o.bg : "transparent",
                    color: on ? "#fff" : "rgba(255,255,255,0.6)",
                    borderColor: on ? o.bg : "rgba(255,255,255,0.15)",
                  }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 btn-ghost text-sm">Cancel</button>
          <button onClick={save} className="flex-1 btn-primary text-sm">Save</button>
        </div>
      </div>
    </div>
  );
}
