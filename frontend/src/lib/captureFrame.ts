/**
 * Capture the current frame of a <video> element onto a hidden <canvas> and
 * return base64-encoded JPEG (without the `data:` prefix), or null if the video
 * isn't ready yet.
 *
 * `rotateForDevice`: the live camera path passes `true` to compensate for mobile
 * sensor orientation (portrait phone vs. landscape sensor). The video-file path
 * leaves it `false` — a video is already in its display orientation, so the
 * captured frame must match exactly what's painted on screen for the normalized
 * (0–1) overlay coordinates to line up.
 */
export function captureVideoFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  opts: { rotateForDevice?: boolean } = {}
): string | null {
  if (video.readyState < 2) return null;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const screenIsPortrait = window.innerHeight > window.innerWidth;
  const videoIsPortrait = vh > vw;
  const needsRotation = opts.rotateForDevice === true && screenIsPortrait !== videoIsPortrait;

  if (needsRotation) {
    const angle = (screen.orientation?.angle ??
      (window as unknown as { orientation?: number }).orientation ??
      0) as number;
    // angles 0/90 → rotate CW; 180/270 → rotate CCW
    const cw = angle === 0 || angle === 90;
    canvas.width = vh;
    canvas.height = vw;
    if (cw) {
      ctx.translate(vh, 0);
      ctx.rotate(Math.PI / 2);
    } else {
      ctx.translate(0, vw);
      ctx.rotate(-Math.PI / 2);
    }
  } else {
    canvas.width = vw;
    canvas.height = vh;
  }

  ctx.drawImage(video, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
}
