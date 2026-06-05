import type { BoardState, GameUpdate, RulesResult, SessionState, TeamEdit } from "../types";

const BASE = "/api";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(res.statusText);
  return res.json() as Promise<T>;
}

export const api = {
  createSession(): Promise<{ session_id: string }> {
    return post("/session", {});
  },

  getSession(id: string): Promise<SessionState> {
    return get(`/session/${id}`);
  },

  sendFrame(
    sessionId: string,
    imageBase64: string,
    mediaType = "image/jpeg",
    engine: "auto" | "cv" = "auto"
  ): Promise<{ board: BoardState; low_confidence: boolean; game: GameUpdate | null }> {
    return post(`/session/${sessionId}/frame`, {
      image: imageBase64,
      media_type: mediaType,
      engine,
    });
  },

  startGame(sessionId: string): Promise<{ game_id: string }> {
    return post(`/session/${sessionId}/game/start`, {});
  },

  validateClue(
    sessionId: string,
    word: string,
    number: number
  ): Promise<RulesResult> {
    return post(`/session/${sessionId}/clue`, { word, number });
  },

  /** Live-browser path: raw transcript → server-side LLM parse + validation.
      number is null when the spymaster never said one (never fabricated). */
  validateClueTranscript(
    sessionId: string,
    transcript: string
  ): Promise<{
    transcript: string;
    clue: { word: string; number: number | null } | null;
    rules: RulesResult | null;
  }> {
    return post(`/session/${sessionId}/clue/transcript`, { transcript });
  },

  endTurn(sessionId: string): Promise<{ current_team: string; message: string | null }> {
    return post(`/session/${sessionId}/turn/end`, {});
  },

  setHouseRules(
    sessionId: string,
    rules: Record<string, boolean>
  ): Promise<unknown> {
    return post(`/session/${sessionId}/house-rules`, rules);
  },

  /** Seed a static demo board — exercises the game UI with no camera / vision credits. */
  seedDemoBoard(sessionId: string): Promise<{ board: BoardState; low_confidence: boolean }> {
    return post(`/session/${sessionId}/board/demo`, {});
  },

  async resetBoard(sessionId: string): Promise<void> {
    const res = await fetch(`${BASE}/session/${sessionId}/board`, { method: "DELETE" });
    if (!res.ok) throw new Error(res.statusText);
  },

  async updateCard(
    sessionId: string,
    position: number,
    edit: { word?: string; team?: TeamEdit }
  ): Promise<{ board: BoardState; game: GameUpdate | null }> {
    const res = await fetch(`${BASE}/session/${sessionId}/board/card`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position, ...edit }),
    });
    if (!res.ok) throw new Error(res.statusText);
    return (await res.json()) as { board: BoardState; game: GameUpdate | null };
  },
};
