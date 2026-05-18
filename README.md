# Codenames AI Referee

An AI-powered board game referee for Codenames. A phone camera watches the board; Claude reconstructs board state from frames; a rules engine validates every clue; the referee speaks up only when needed.

**Runs entirely in a mobile browser — no app store required.**

---

## Architecture

```
Phone browser
  ├── CameraCapture   → captures frames every 5s via getUserMedia()
  ├── BoardOverlay    → renders detected board state
  └── VoiceControls  → mic (Whisper) + speaker (TTS)
        ↕ JSON over HTTP
Cloudflare Worker (edge)
  ├── Vision pipeline  → Claude claude-sonnet-4-20250514 vision
  ├── Rules engine     → pure functions, no AI needed
  ├── Intervention     → silence / nudge / stop thresholds
  └── Voice I/O        → Whisper STT + OpenAI TTS
        ↕
Cloudflare KV    → live board state per session
Cloudflare D1    → sessions, games, clues, interventions
```

---

## Prerequisites

- Node.js 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- A Cloudflare account (free tier works)
- Anthropic API key
- OpenAI API key

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
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put OPENAI_API_KEY
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

1. Open `http://localhost:5173` on your phone (or laptop with webcam).
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
| `ANTHROPIC_API_KEY` | `wrangler secret put` | Claude vision API |
| `OPENAI_API_KEY` | `wrangler secret put` | Whisper + TTS |
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
│       │   └── VoiceControls.tsx   mic + TTS playback
│       ├── hooks/
│       │   ├── useCamera.ts        camera lifecycle + interval
│       │   └── useVoice.ts         MediaRecorder + audio playback
│       └── lib/api.ts              typed fetch wrappers
├── worker/            Cloudflare Worker
│   └── src/
│       ├── index.ts                Hono router (all endpoints)
│       ├── vision.ts               Claude vision calls + KV storage
│       ├── rules.ts                Codenames rules engine (pure functions)
│       ├── session.ts              KV session state + D1 persistence
│       ├── voice.ts                Whisper STT + OpenAI TTS
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
