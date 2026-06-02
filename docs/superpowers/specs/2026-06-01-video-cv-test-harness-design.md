# Video-fed CV test harness — design

**Date:** 2026-06-01
**Status:** Approved (via `/goal implement`)

## Goal

Drive the existing board-overlay UI from a **video file** instead of the live
camera, so the CV pipeline can be evaluated against a full recorded game —
watching card tracking (perspective quads), word OCR, and team affiliations
evolve as turns progress. The video plays in the same interface with overlays
drawn on top, "as if it were a live camera feed."

## Context (current architecture)

- **Frontend** (`/frontend`, React/Vite, port 5173): `useCamera` grabs a
  `getUserMedia` stream into a `<video>`, captures frames to a hidden `<canvas>`
  every 5 s, and POSTs base64 JPEG to `/api/session/:id/frame`. `BoardOverlay`
  draws perspective-correct SVG quads + word labels over the video using
  normalized 0–1 coordinates (`viewBox="0 0 1 1" preserveAspectRatio="none"`).
- **Worker** (`/worker`, Cloudflare/Hono, port 8787): `analyzeFrame()` routes
  frames. Today — **first/full scan → LLM** (OpenRouter, best OCR); **later
  track scans → CV service** (DigitalOcean, perspective + colour/team). Board
  state is cached in KV per session; words "lock" after the first scan.
- **CV service** (`/cv-service`, FastAPI, deployed on DigitalOcean): `/analyze`
  with `mode: "full" | "track"`. Full = board detection (homography warp) + OCR
  (pytesseract) + colour classification. Track = colour/reveal only, reusing
  locked words. Returns 25 cards with normalized `corners` (perspective quads),
  `team`, `revealed`, `confidence`. Stateless. Already wired via `CV_SERVICE_URL`
  in `worker/.dev.vars` — **no local Python needed**.

## Decisions (from clarifying questions)

1. **Backend path: Both, switchable in UI.**
   - *Auto (faithful):* exactly today's flow — LLM reads words once, CV tracks
     perspective + team after.
   - *Pure CV:* every frame to the CV service — full mode (OCR + perspective +
     colour) until words lock, then track mode. No LLM.
2. **Video input: in-app file picker / drag-drop.** Any local video at runtime.
3. **Playback: Both, toggleable.**
   - *Real-time:* 1× playback, sequential capture every N s (adjustable), never
     overlapping in-flight requests. Overlay lags slightly, like live.
   - *Frame-accurate:* pause → capture the exact displayed frame → await result →
     draw overlay pinned to that frame → seek forward → repeat. Always aligned.

## Architecture

A **dedicated test view** reachable at `?test=video` (plus a small header link),
isolated from the production camera/game flow but reusing the same `BoardOverlay`
so what you see is faithful.

### Frontend
- `lib/captureFrame.ts` (new): `captureVideoFrame(video, canvas, { rotateForDevice })`
  — extracted from `useCamera` so both paths share one implementation. The
  camera passes `rotateForDevice: true` (mobile sensor orientation); the video
  path leaves it `false` (a video is already in display orientation, so the
  captured frame matches what's on screen and the normalized overlay lines up).
- `hooks/useCamera.ts`: refactored to call the shared util (behaviour unchanged).
- `lib/api.ts`: `sendFrame(..., engine: "auto" | "cv" = "auto")` adds the engine
  field (backward compatible).
- `components/VideoTestView.tsx` (new): file picker/drag-drop, `<video>` +
  hidden `<canvas>` + `<BoardOverlay overlay />`, the two toggles, playback
  controls (play/stop, scrub bar, interval slider, speed), and a **diagnostics
  panel** (per-frame: backend `notes`, full vs track, overall confidence, words
  read, revealed count, round-trip latency, frame counter). The container's
  `aspect-ratio` is set to the video's natural ratio + `object-cover` so the 0–1
  overlay maps exactly (same technique as `CameraCapture`).
- `App.tsx`: render `VideoTestView` when `?test=video`; add a header entry link.

### Worker
- `vision-plan.ts` (new): `selectVisionPlan(engine, existingBoard, hasCVService)`
  — a **pure** function returning `{ backend, mode, knownWords }`. Isolated and
  unit-tested with no I/O.
- `vision.ts`: `analyzeFrame(..., engine = "auto")` uses `selectVisionPlan`; adds
  the pure-CV branch (CV full on first frame, CV track after). Auto behaviour is
  preserved exactly, including the track-failure "freeze board" fallback. Removes
  two pre-existing dead constants (`CV_MIN_CONFIDENCE`, `CV_MIN_WORDS`) so the
  file type-checks clean.
- `index.ts`: `/frame` reads optional `engine` from the body and threads it in.

## Data flow (per frame)

`VideoTestView` capture loop → `captureVideoFrame` → `api.sendFrame(engine)` →
worker `/frame` → `analyzeFrame` → `selectVisionPlan` →
(LLM full | CV full | CV track) → board cached in KV → returned → `BoardOverlay`
renders quads/labels/teams → diagnostics panel updates.

## Testing & verification

- **Unit:** `scripts/test-vision-plan.mjs` exercises `selectVisionPlan` across
  auto/cv × no-board/locked × CV-present/absent (pure, no network).
- **Type-check + build:** `tsc --noEmit` for worker and frontend; `vite build`.
- **End-to-end (worker contract):** POST a `test-boards/*.jpg` frame with
  `engine=auto` and `engine=cv` against the running worker to confirm both paths
  reach the real LLM and the deployed CV service.
- **Full UI:** the user loads their own game video via the file picker and
  watches overlays track across the game (real-time and frame-accurate).

## Non-goals
- No clue/guess/turn voice UI in the test view (CV board tracking only; team
  affiliations already evolve in the overlay — that's the "as turns progress"
  part).
- No local CV-service execution (use the deployed service already configured).
- No new persistence/analytics beyond the live diagnostics panel.
