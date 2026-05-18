// Whisper transcription and OpenAI TTS

export async function transcribeAudio(
  audioBuffer: ArrayBuffer,
  filename: string,
  openaiApiKey: string
): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: "audio/webm" });
  formData.append("file", blob, filename);
  formData.append("model", "whisper-1");
  formData.append("language", "en");
  // Prompt helps Whisper recognize Codenames-style single words + numbers
  formData.append(
    "prompt",
    "Codenames board game. The spymaster is giving a one-word clue followed by a number, like: OCEAN 3, or CLIMB 2."
  );

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiApiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Whisper API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { text: string };
  return data.text.trim();
}

export function parseClueFromTranscript(
  transcript: string
): { word: string; number: number } | null {
  // Expected format: "WORD NUMBER" e.g. "ocean 3" or "CLIMB 2"
  // Also handles: "the clue is ocean three"
  const numberWords: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    unlimited: 99, infinity: 99,
  };

  const clean = transcript.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  const tokens = clean.split(/\s+/).filter(Boolean);

  // Find the last token that is a number (digit or word)
  for (let i = tokens.length - 1; i >= 1; i--) {
    const token = tokens[i];
    const asDigit = parseInt(token, 10);
    const asWord = numberWords[token];
    const num = !isNaN(asDigit) ? asDigit : asWord;

    if (num !== undefined) {
      // The word is everything before the number, take last word if multiple
      const wordTokens = tokens.slice(0, i);
      const word = wordTokens[wordTokens.length - 1];
      if (word && /^[a-z]+$/.test(word)) {
        return { word: word.toUpperCase(), number: num };
      }
    }
  }

  return null;
}

export async function synthesizeSpeech(
  text: string,
  openaiApiKey: string
): Promise<ArrayBuffer> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text,
      voice: "onyx", // calm, authoritative
      speed: 0.95,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TTS API error ${res.status}: ${err}`);
  }

  return res.arrayBuffer();
}
