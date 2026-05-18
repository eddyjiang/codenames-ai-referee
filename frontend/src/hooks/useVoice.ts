import { useRef, useState, useCallback, useEffect } from "react";

// ——— MediaRecorder (for Whisper upload path) ———

export function useVoiceRecorder() {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startRecording = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.start(100);
      recorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone access denied");
    }
  }, []);

  const stopRecording = useCallback((): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const recorder = recorderRef.current;
      if (!recorder) { reject(new Error("No active recording")); return; }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        (recorder.stream as MediaStream).getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        setRecording(false);
        resolve(blob);
      };
      recorder.stop();
    });
  }, []);

  return { recording, error, startRecording, stopRecording };
}

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

export interface SpeechInputResult {
  transcript: string;
  confidence: number;
}

export function useSpeechInput() {
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = isSpeechRecognitionSupported();

  // Cleanup on unmount
  useEffect(() => {
    return () => { recognitionRef.current?.abort(); };
  }, []);

  const listen = useCallback((): Promise<SpeechInputResult> => {
    return new Promise((resolve, reject) => {
      const SR = getSpeechRecognition();
      if (!SR) { reject(new Error("Web Speech API not supported in this browser")); return; }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recognition = new SR();
      recognition.lang = "en-US";
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognitionRef.current = recognition;
      setError(null);
      setListening(true);

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        const result = event.results[0][0];
        setListening(false);
        resolve({ transcript: result.transcript, confidence: result.confidence });
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        setListening(false);
        const msg = event.error === "no-speech"
          ? "No speech detected — try again"
          : `Speech recognition error: ${event.error}`;
        setError(msg);
        reject(new Error(msg));
      };

      recognition.onend = () => { setListening(false); };

      recognition.start();
    });
  }, []);

  const cancel = useCallback(() => {
    recognitionRef.current?.abort();
    setListening(false);
  }, []);

  return { supported, listening, error, listen, cancel };
}

// ——— TTS: Web Speech API (no API key needed) ———

export function speakText(text: string, onEnd?: () => void): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel(); // stop any current speech
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
  if (onEnd) utterance.onend = onEnd;
  window.speechSynthesis.speak(utterance);
}

// ——— TTS: base64 audio from OpenAI TTS (OpenAI key path) ———

export function playBase64Audio(base64: string): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  audio.play().catch(console.error);
}
