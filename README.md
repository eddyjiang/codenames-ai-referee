# Codenames AI Referee

An AI-powered board game referee for Codenames. A camera watches the physical board; Claude reconstructs board state from frames; a deterministic rules engine validates every clue; the referee speaks up only when needed.

**Runs entirely in browser — no app required.**

---

## The Problem

Codenames is one of the most popular party games in the world, and it has famously ambiguous clue rules. The spymaster's one-word clue must not be a word on the board, a homophone of one, share a root with one, or be part of a compound board word — and casual players almost never know these rules, let alone enforce them. The result is familiar to anyone who's played: mid-game arguments ("is *waterfall* legal if WATER is on the board?"), games that stall while someone reads the rulebook, and one player stuck in the unfun role of rules lawyer.

Existing digital adaptations solve this by replacing the physical game entirely — you play on a screen. That throws away the thing people actually like: cards on a table, friends around it.

**The insight:** the referee should be *ambient*. Keep the physical game exactly as it is; prop up a device with a camera; let an AI watch the board and surface the rules only when they're relevant. Three ideas make the approach original:

1. **The board is never entered by hand.** Vision reconstructs all 25 cards, their teams, and what's been revealed — setup is "point the camera at the table."
2. **AI perceives, code judges.** The LLM only reads the world; every rules decision is made by deterministic, testable functions. No hallucinated rulings.
3. **Display, don't enforce.** The referee shows violations and confidence rather than policing the game — players stay in charge, which playtesting confirmed is what keeps it from being annoying.

---

## What I Built

A full-stack, deployed system: a React web app, a Cloudflare Worker API at the edge, KV/D1 storage, and a Python computer-vision microservice.

```
Web browser
  ├── CameraCapture   → captures frames every 5s via getUserMedia()
  ├── BoardOverlay    → renders detected board state (perspective-correct quads)
  └── VoiceControls   → mic (browser STT)
        ↕ JSON over HTTP
Cloudflare Worker (edge)
  ├── Vision pipeline  → Claude Sonnet vision (via OpenRouter)
  ├── Rules engine     → pure TypeScript functions, no AI
  ├── Intervention     → silent log / nudge / hard-stop by confidence
  └── Voice            → browser STT
        ↕                              ↕
Cloudflare KV + D1              CV service (FastAPI + OpenCV +
live board state; sessions,     pytesseract, on DigitalOcean) —
games, clues, interventions     per-frame perspective tracking
```

### Three design decisions that define the system

1. **No AI in the rules path.** The rules engine (`worker/src/rules.ts`) is pure functions: word-on-board, homophone, shared-root, compound-part, multi-word, repeat-clue, guess-limit checks — each returning a violation with a confidence score. It's fast, deterministic, and testable, and the referee can never invent a ruling.
2. **Hybrid vision pipeline.** Measurement (below) showed traditional OCR couldn't read the board, but running an LLM on every frame is slow and expensive. So in the production "auto" path the **LLM reads the 25 words once** at game start, the **CV service tracks perspective and card quads every frame**, and an **authoritative LLM reveal-check runs in the background** so the live path never blocks on the LLM.
3. **Confidence-tiered intervention.** Violations at ≥ 0.95 confidence trigger a spoken hard stop, ≥ 0.85 a gentle nudge, anything lower a silent log. Uncertain heuristics (homophones, roots) therefore nudge rather than police.

### How it evolved

The commit history records the real arc, including two measurement-driven pivots:

1. **Scaffolding** — referee framework, rules engine, voice I/O, camera capture (`bd8c869`, `c670912`).
2. **Pure-CV attempt** — EasyOCR for word reading; its PyTorch dependency OOM'd the build container, so it was replaced with pytesseract (`8c6e52b`).
3. **Measurement harness** — a video test mode (`?test=video`) that replays recorded games through the production pipeline with per-frame diagnostics (`3e857af`).
4. **Pivot 1: LLM reads the words.** The harness showed pytesseract reading 7/25 words on a clear board. Word-reading moved to Claude vision; CV kept for perspective tracking.
5. **Color/reveal tuning** — team-color thresholds, bystander-vs-word card distinction, covered-word ⇒ revealed inference (`f00ab1e`, `23eb1d4`, `f6e25bb`, `cd3da53`, `7bdf432`).
6. **Pivot 2: LLM detects reveals.** The CV color heuristic over-reported revealed cards, so authoritative reveal detection moved to a background LLM check (`e803f19`).

---

## Evaluation & Evidence

### Measured: vision pipeline accuracy

The video test harness (`?test=video`, documented below) replays recorded games and board photos through the exact production pipeline and reports per-frame latency, confidence, and detections. Measured against a clear, head-on board photo (`test-boards/IMG_4536.jpg`):

| Capability | Pure CV (pytesseract / OpenCV) | LLM (Claude Sonnet) | Production choice |
|---|---|---|---|
| Reading the 25 words | **7/25, garbled** (e.g. `", HE,, AAG"`) | **25/25** at 0.93 confidence | LLM, once at game start |
| Detecting revealed cards | **19/25 false positives** on a fresh, all-unrevealed board | Reliable | LLM, background check |
| Perspective card quads | **25/25 corners** | bbox only, 0/25 corners | CV service, every frame |

These numbers are *why* the architecture is hybrid — both pivots in the iteration timeline were driven directly by these measurements, not guesses.

### Live playtests

I playtested over **3 rounds of real Codenames with friends**. The referee caught genuinely illegal clues during play. The most important finding was about interaction design rather than accuracy: because the referee **displays violations instead of enforcing them**, nobody experienced it as annoying — it kept the game on track without anyone feeling policed. An earlier enforce-everything design would have failed this test.

### Known limitations

- **CV color classification misfires on cream card faces** — the source of the 19/25 false-reveal measurement. Mitigated by the LLM reveal check, but `cv-service/pipeline.py` thresholds remain imperfect.
- **Camera dependence** — the camera must be propped with the full board in view; poor lighting or steep angles degrade confidence (the UI surfaces this as a low-confidence warning rather than failing silently).
- **Latency** — frames are captured every 5 s and the authoritative reveal check runs in the background, so board updates can lag a few seconds behind the table.
- **Heuristic rules are probabilistic** — homophone and shared-root detection carry < 1.0 confidence by design; the tiered-intervention system exists precisely because these can be wrong.
- **Scale untested** — built and tested for one table/session at a time.

---

## AI Usage Disclosure & Credits

**How this was built:** The code in this repository was written with **Claude Code** (Anthropic's CLI coding agent) under my direction. I chose the architecture, made the design decisions described above, reviewed the changes, ran the deployments, and did all real-world validation — board photos, recorded-game harness runs, and live playtests. The commit history reflects that iterative process, including the dead ends (EasyOCR, pure-CV reveals).

**AI at runtime:** Claude Sonnet (board vision, via OpenRouter). The canonical, annotated prompts are in [`prompts/`](prompts/).

**Sources & credits:** No code was forked or borrowed from existing repositories — the project was built from scratch on standard open-source dependencies: React, Vite, Tailwind, Hono, Cloudflare Workers/KV/D1, FastAPI, OpenCV, pytesseract, NumPy. *Codenames* is © Vlaada Chvátil / Czech Games Edition; this is an unaffiliated fan-made referee for the physical game.

**Development artifacts:** the full commit history in this repo, the video CV test harness, the annotated prompts, and test boards in `test-boards/`.

---

# Technical Documentation

Everything below is what you need to run, test, and deploy the project yourself.

---

## Prerequisites

- Node.js 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- A Cloudflare account (free tier works)
- OpenRouter API key

---

## Setup

### 1. Clone and install

```bash
git clone <repo>
cd codenames-rules-guy
npm install
```

### 2. Cloudflare resources

```bash
# Login
wrangler login

# Create KV namespace
wrangler kv namespace create BOARD_KV
# → copy the ID into worker/wrangler.toml  (kv_namespaces[0].id)

# Create a preview KV namespace (used by `wrangler dev`)
wrangler kv namespace create BOARD_KV --preview
# → copy the preview_id into worker/wrangler.toml  (kv_namespaces[0].preview_id)

# Create D1 database
wrangler d1 create codenames-db
# → copy the database_id into worker/wrangler.toml  (d1_databases[0].database_id)
```

### 3. Run D1 migrations

```bash
# Local dev
npm run db:migrate

# Remote (production)
npm run db:migrate:remote
```

### 4. Set Worker secrets

```bash
wrangler secret put OPENROUTER_API_KEY
```

### 5. Local development

```bash
npm run dev
```

This starts:
- Frontend at `http://localhost:5173` (Vite, hot reload)
- Worker at `http://localhost:8787` (Wrangler dev)

Vite proxies `/api/*` → Worker automatically.

**Test the Worker health check:**
```bash
curl http://localhost:8787/health
# → {"ok":true,"ts":1234567890}
```

---

## Testing each component

### Component 1: Camera Capture

1. Open `http://localhost:5173` on your device.
2. Tap **Start Camera** → grant permission.
3. You should see the live viewfinder with a 5×5 grid guide overlay.
4. Tap **Start Scanning** → the green "SCANNING" pulse appears.
5. Check the browser Network tab — a POST to `/api/session/:id/frame` fires every 5s.

### Component 2: Vision Pipeline

With the camera scanning a Codenames board (or a photo of one):

```bash
# Manually test with a local image
curl -X POST http://localhost:8787/api/session/TEST/frame \
  -H "Content-Type: application/json" \
  -d "{\"image\": \"$(base64 -i path/to/board.jpg | tr -d '\n')\"}"
```

Expected response: structured JSON with 25 card objects, each having `word`, `revealed`, `team`, `confidence`.

If `metadata.overall_confidence < 0.7`, the frontend shows "⚠ Low confidence" and the board grid dims uncertain cards.

### Component 3: Rules Engine

```bash
# Valid clue
curl -X POST http://localhost:8787/api/session/TEST/clue \
  -H "Content-Type: application/json" \
  -d '{"word": "ocean", "number": 3}'

# Illegal clue (word on board — assuming "OCEAN" is one of the 25)
curl -X POST http://localhost:8787/api/session/TEST/clue \
  -H "Content-Type: application/json" \
  -d '{"word": "ocean", "number": 3}'
```

Check `intervention_level`: should be `"stop"` for a word on the board, `"none"` for a legal clue.

### Component 4: Voice I/O

In the app:
1. Start a game (Camera → Board → "Start Game with This Board").
2. Navigate to **Game** tab.
3. Tap the microphone, say: *"Ocean, three"*
4. The transcript appears, the clue is validated against the board, and if there's a violation, the referee speaks through the phone speaker.

### Component 5: Session Memory (D1)

```bash
# After a few clues, inspect
wrangler d1 execute codenames-db --local --command "SELECT * FROM clues LIMIT 10;"
wrangler d1 execute codenames-db --local --command "SELECT * FROM interventions;"
```

### Video CV test harness

Evaluate the CV pipeline against a **recorded game** without a live camera — the
video plays in the normal interface with overlays drawn on top, "as if it were a
live feed."

1. Run `npm run dev`, then open `http://localhost:5173/?test=video` (or click
   **🎬 Video test** in the header).
2. Drop in / choose a recorded game video. Press **Start capture**.
3. Two toggles:
   - **Backend path** — *Auto* (production: LLM reads the 25 words once, then the
     CV service tracks perspective + team colours) vs *Pure CV* (every frame
     through the CV service — OCR + perspective on the first frame, colour
     tracking after; no LLM).
   - **Playback mode** — *Real-time* (plays at speed, captures on an adjustable
     interval, overlay lags slightly like a live feed) vs *Frame-step* (pauses on
     each captured frame until the result returns, so the overlay is always
     aligned to the exact frame).
4. The **Diagnostics** panel shows per-frame latency, backend `notes`
   (`cv:full …` / `cv:track …`), overall confidence, words read, revealed count,
   and the partial-visibility flag.

Under the hood this just adds an optional `engine` field to the frame endpoint
(`"auto"` default | `"cv"`); the rest of the pipeline is unchanged. No local
Python is needed — it uses the CV service already configured via `CV_SERVICE_URL`.

---

## Deployment

```bash
# Build frontend
npm run build --workspace=frontend

# Deploy Worker (includes static asset serving if you configure Pages)
npm run deploy
```

For the frontend, deploy `/frontend/dist` to Cloudflare Pages and set the `API_BASE` to your Worker URL, or serve it from the Worker directly via [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/).

---

## Environment variables

| Variable | Where set | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | `wrangler secret put` | Claude vision |
| `CLOUDFLARE_ACCOUNT_ID` | `.env` (local CLI only) | Wrangler auth |
| `CLOUDFLARE_API_TOKEN` | `.env` (local CLI only) | Wrangler auth |

KV and D1 bindings are configured in `worker/wrangler.toml` — not env vars at runtime.

---

## Project layout

```
/
├── frontend/          React app (mobile-first)
│   └── src/
│       ├── components/
│       │   ├── CameraCapture.tsx   getUserMedia + frame capture
│       │   ├── BoardOverlay.tsx    5×5 board state display
│       │   ├── VideoTestView.tsx   video-fed CV test harness (?test=video)
│       │   └── VoiceControls.tsx   mic + STT
│       ├── hooks/
│       │   ├── useCamera.ts        camera lifecycle + interval
│       │   └── useVoice.ts         MediaRecorder + audio playback
│       └── lib/
│           ├── api.ts              typed fetch wrappers
│           └── captureFrame.ts     shared <video>→canvas→base64 capture
├── worker/            Cloudflare Worker
│   └── src/
│       ├── index.ts                Hono router (all endpoints)
│       ├── vision.ts               Claude vision calls + KV storage
│       ├── vision-plan.ts          pure frame-routing decision (auto/cv)
│       ├── rules.ts                Codenames rules engine (pure functions)
│       ├── session.ts              KV session state + D1 persistence
│       ├── voice.ts                STT
│       └── prompts.ts              Inlined system prompts
├── db/
│   ├── schema.sql                  Full schema reference
│   └── migrations/0001_initial.sql Wrangler migration
└── prompts/
    ├── vision.md                   Vision prompt (canonical, annotated)
    └── referee.md                  Referee prompt (canonical, annotated)
```

---

## House rules

POST to `/api/session/:id/house-rules` with any combination:

```json
{
  "allow_proper_nouns": true,
  "allow_compound_parts": false,
  "unlimited_guesses": false,
  "zero_clue_forbidden": true
}
```

---

## Rules enforced

| Rule | Violation key | Confidence |
|---|---|---|
| Clue word is on the board | `word_on_board` | 0.98 |
| Clue is a homophone of a board word | `homophone` | 0.90 |
| Clue shares a root with a board word | `root_match` | 0.85 |
| Clue is part of / contains a compound board word | `compound_part` | 0.88 |
| Clue contains multiple words | `multiple_words` | 0.99 |
| Clue was already given this game | `repeat_clue` | 1.00 |
| Guess count exceeds number + 1 | `guess_limit_exceeded` | 1.00 |
| Number 0 (when house rule forbids it) | `zero_clue_forbidden` | 1.00 |

Intervention fires at ≥ 0.85 confidence (nudge) or ≥ 0.95 (hard stop). Below 0.85: silent log only.
