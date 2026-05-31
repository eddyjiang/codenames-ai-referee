import type { BoardState, RulesResult, SessionState } from "../types";

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
    mediaType = "image/jpeg"
  ): Promise<{ board: BoardState; low_confidence: boolean }> {
    return post(`/session/${sessionId}/frame`, {
      image: imageBase64,
      media_type: mediaType,
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

  async sendAudioClue(
    sessionId: string,
    audioBlob: Blob
  ): Promise<{
    transcript: string;
    clue: { word: string; number: number } | null;
    rules: RulesResult;
    tts_audio_base64: string | null;
  }> {
    const form = new FormData();
    form.append("audio", audioBlob, "clue.webm");
    const res = await fetch(`${BASE}/session/${sessionId}/clue/audio`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error: string }).error ?? res.statusText);
    }
    return res.json();
  },

  recordGuess(sessionId: string): Promise<{
    guesses_this_turn: number;
    limit: number | null;
    violation: unknown;
    tts_audio_base64: string | null;
  }> {
    return post(`/session/${sessionId}/guess`, {});
  },

  endTurn(sessionId: string): Promise<{ current_team: string }> {
    return post(`/session/${sessionId}/turn/end`, {});
  },

  setHouseRules(
    sessionId: string,
    rules: Record<string, boolean>
  ): Promise<unknown> {
    return post(`/session/${sessionId}/house-rules`, rules);
  },

  async resetBoard(sessionId: string): Promise<void> {
    const res = await fetch(`${BASE}/session/${sessionId}/board`, { method: "DELETE" });
    if (!res.ok) throw new Error(res.statusText);
  },

  async updateCard(sessionId: string, position: number, word: string): Promise<BoardState> {
    const res = await fetch(`${BASE}/session/${sessionId}/board/card`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position, word }),
    });
    if (!res.ok) throw new Error(res.statusText);
    return ((await res.json()) as { board: BoardState }).board;
  },
};
