import { useRef, useState, useCallback, useEffect } from "react";

interface UseCameraOptions {
  onFrame: (base64: string) => void;
  intervalMs?: number;
}

export function useCamera({ onFrame, intervalMs = 5000 }: UseCameraOptions) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0);
    // Strip the data:image/jpeg;base64, prefix
    return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
  }, []);

  const startCamera = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" }, // rear camera on mobile
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setActive(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Camera access denied");
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setActive(false);
    setScanning(false);
  }, []);

  const startScanning = useCallback(() => {
    if (!active) return;
    setScanning(true);

    const tick = async () => {
      const frame = captureFrame();
      if (frame) {
        await onFrame(frame);
      }
    };

    // Immediate first capture
    tick();
    intervalRef.current = setInterval(tick, intervalMs);
  }, [active, captureFrame, onFrame, intervalMs]);

  const stopScanning = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setScanning(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  return {
    videoRef,
    canvasRef,
    active,
    scanning,
    error,
    startCamera,
    stopCamera,
    startScanning,
    stopScanning,
    captureFrame,
  };
}
