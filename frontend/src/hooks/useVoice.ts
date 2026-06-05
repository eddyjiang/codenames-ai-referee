import { useRef, useState, useEffect } from "react";

// ——— Web Speech API (no API key needed) ———

function getSpeechRecognition(): (new () => SpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  return (
    (typeof SpeechRecognition !== "undefined" ? SpeechRecognition : null) ??
    (typeof webkitSpeechRecognition !== "undefined" ? webkitSpeechRecognition : null)
  );
}

export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognition() !== null;
}

interface ContinuousSpeechOptions {
  /** Recognition runs while true (spymaster phase) and is fully off while false. */
  active: boolean;
  /** Called with each finalized utterance. */
  onUtterance: (transcript: string) => void;
}

/**
 * Always-on speech recognition for the spymaster phase. The mic is hot the
 * entire time `active` is true — browsers end recognition after silence, so
 * it auto-restarts until `active` flips false (clue stands → guessers' turn,
 * when nothing may be recorded at all).
 */
export function useContinuousSpeech({ active, onUtterance }: ContinuousSpeechOptions) {
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const activeRef = useRef(active);
  const onUtteranceRef = useRef(onUtterance);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { onUtteranceRef.current = onUtterance; }, [onUtterance]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      setListening(false);
      return;
    }

    const SR = getSpeechRecognition();
    if (!SR) {
      setError("Web Speech API not supported in this browser");
      return;
    }

    let disposed = false;

    const start = () => {
      if (disposed || !activeRef.current) return;
      const recognition = new SR();
      recognition.lang = "en-US";
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result[0]?.transcript.trim();
          if (result.isFinal && transcript) {
            // Ignore the referee's own TTS leaking from the speakers.
            if (isRefereeSpeaking()) continue;
            onUtteranceRef.current(transcript);
          }
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          setError("Microphone access denied");
          setListening(false);
        }
        // 'no-speech' / 'aborted' / 'network': onend fires next and restarts.
      };

      recognition.onend = () => {
        if (!disposed && activeRef.current) {
          setTimeout(start, 150); // silence timeout — relight the mic
        } else {
          setListening(false);
        }
      };

      recognitionRef.current = recognition;
      try {
        recognition.start();
        setListening(true);
        setError(null);
      } catch {
        // start() throws if a previous instance is still winding down; the
        // onend restart loop will retry.
      }
    };

    start();

    return () => {
      disposed = true;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      setListening(false);
    };
  }, [active]);

  return { listening, error };
}

// ——— TTS: Web Speech API (no API key needed) ———

// Timestamp guard for the recognition loop: drop mic results while the referee
// is talking. A hard time ceiling (not just speechSynthesis.speaking, which
// Chrome can leave stuck `true`) guarantees the mic always comes back.
let refereeSpeakingUntil = 0;

export function isRefereeSpeaking(): boolean {
  return Date.now() < refereeSpeakingUntil;
}

export function speakText(text: string, onEnd?: () => void): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel(); // stop any current speech

  // Estimate duration (~380ms/word + lead-in), capped so a stuck utterance
  // can never deafen the mic for long.
  const words = text.split(/\s+/).length;
  refereeSpeakingUntil = Date.now() + Math.min(20_000, 1_200 + words * 380);

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.92;
  utterance.pitch = 0.9;
  // Prefer a deeper voice for authority
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find((v) =>
    v.name.toLowerCase().includes("daniel") ||
    v.name.toLowerCase().includes("alex") ||
    v.name.toLowerCase().includes("english")
  );
  if (preferred) utterance.voice = preferred;
  utterance.onend = () => {
    refereeSpeakingUntil = 0;
    onEnd?.();
  };
  utterance.onerror = () => {
    refereeSpeakingUntil = 0;
  };
  window.speechSynthesis.speak(utterance);
}
