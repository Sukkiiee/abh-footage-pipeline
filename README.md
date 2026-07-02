# ABH Footage Pipeline

Turns raw Google Drive footage into an editor-ready package: a long-form
narrative outline in the ABH (Africa's Business Heroes) brand voice, a
flagged list of self-contained 15-60s short-form moments, and two files an
editor can use immediately: a `.docx` writeup and a `.fcpxml` timeline that
opens directly in Final Cut Pro with every flagged clip already laid out on
the spine.

## Pipeline

1. **Connect** — one-time Google OAuth (read-only Drive scope) + pick a folder.
2. **Detect** — lists `.mp4` / `.mov` files in that folder. You can also skip browsing entirely and paste a share link (or raw file ID) for any specific video the connected account can see, in or out of that folder.
3. **Transcribe** — downloads the file, extracts audio with ffmpeg, transcribes with Whisper via Groq's free-tier hosted API (segment-level timestamps, auto-chunked for long footage).
4. **Narrative** — sends the timestamped transcript to an LLM with an ABH brand-voice system prompt, plus an optional producer **brief** (freeform context/angle) and an optional **target video length** (guides section count/pacing, not enforced exactly); returns a structured long-form narrative with timestamp citations, via forced tool-use (not free-text JSON parsing). Defaults to a free Groq-hosted Llama model; switchable to Claude via one env var (see Setup).
5. **Short-form** — a second LLM call flags self-contained 15-60s moments (hook in the first 2 seconds, single idea, clear payoff), also informed by the brief if provided, validated/clamped against real transcript timestamps server-side.
6. **Export** — builds a frame-accurate `.fcpxml` (asset + one asset-clip per flagged moment, back to back on the spine, with markers) and a `.docx` (narrative outline + short-form picks table).
7. **Output** — both files are streamed to the browser as direct downloads; nothing is persisted server-side.

Progress streams live to the UI over SSE while the pipeline runs.

## Stack

Next.js 14 (App Router) · googleapis · OpenAI SDK pointed at Groq's free-tier Whisper endpoint (transcription) · a provider-agnostic LLM layer defaulting to Groq's free-tier Llama models, switchable to Anthropic's Claude SDK via one env var (narrative + short-form generation) · fluent-ffmpeg + ffmpeg-static/ffprobe-static · `docx`. No database: the Google OAuth tokens and connected folder are stored in a single encrypted, httpOnly cookie. Whether a file has already been processed is tracked client-side (`localStorage`) so it survives across sessions in that browser.

## Setup

### 1. Google Cloud (Drive OAuth)

1. Create/select a project at https://console.cloud.google.com.
2. Enable the **Google Drive API** (APIs & Services → Library).
3. Configure the **OAuth consent screen** (External is fine for personal use; add yourself as a test user if it's in Testing mode).
4. Create an **OAuth 2.0 Client ID** (Application type: Web application).
   - Authorized redirect URI: `http://localhost:3000/api/auth/google/callback` for local dev, plus your production URL's equivalent, e.g. `https://your-app.vercel.app/api/auth/google/callback`.
5. Copy the client ID/secret into `.env.local` (see below).

The app requests `drive.readonly`, not the narrower `drive.file` scope. `drive.file` would only let it see files it created itself; since it needs to read arbitrary existing footage in a folder you pick, it needs read access to your Drive. It never requests write access.

### 2. API keys

- Groq (free tier, used for Whisper transcription **and**, by default, narrative/short-form generation): https://console.groq.com/keys → `GROQ_API_KEY`
- Anthropic (optional — only needed if you switch `LLM_PROVIDER` to `anthropic` for higher-quality narrative/short-form generation; requires billing set up, no perpetual free tier): https://console.anthropic.com/ → `ANTHROPIC_API_KEY`

By default (`LLM_PROVIDER=groq`, the `.env.example` default), the entire pipeline runs on Groq's free tier alone — no Anthropic key needed, no cost, good for confirming everything works end-to-end. When you're ready for better narrative quality, set `LLM_PROVIDER=anthropic` and add `ANTHROPIC_API_KEY` — no code changes required either way.

### 3. Environment

```bash
cp .env.example .env.local
```

Fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, and generate a session secret:

```bash
openssl rand -base64 32   # paste as SESSION_SECRET
```

### 4. Install & run

This machine didn't have Node.js installed when this project was generated, so it hasn't been run or type-checked here. On a machine with Node 18+:

```bash
npm install
npm run dev
```

Open http://localhost:3000, connect Drive, paste a folder URL/ID, and run the pipeline on a file.

## Deploying to Vercel

```bash
vercel deploy
```

Set the same environment variables in the Vercel project settings (Production and Preview). Set `APP_URL` to your deployed URL (or rely on Vercel's auto-injected `VERCEL_URL`, which the app already falls back to).

**Function duration matters here.** The whole pipeline (download, ffmpeg, Whisper, two Claude calls, exports) runs inside one request. `app/api/pipeline/run/route.ts` sets `maxDuration = 800`, which requires a **Vercel Pro plan with Fluid Compute enabled**. On Hobby (10-60s cap) or Pro without Fluid Compute (300s cap), long footage will hit the timeout mid-pipeline. Rough guide:

- Under ~15-20 min of footage: fine even at a 300s cap.
- Longer than that: you need the extended (800s) duration, or you'll want to move to a background-job architecture (see Limitations).

## Limitations / things to know

- **No database, by design.** This is built for a single connected Drive account. Multi-user support, a job history, or server-side "already processed" tracking would need a real datastore (e.g. Vercel Postgres) — a deliberate simplicity trade-off for this version.
- **Synchronous pipeline.** There's no queue or retry; if it fails partway through (e.g. an LLM API hiccup), you re-run the file from the file list. Nothing is left half-written since outputs are only produced at the very end.
- **Groq's free-tier LLM (Llama) is less reliable at forced structured output than Claude.** Under `LLM_PROVIDER=groq` (the default), an occasional run may fail with a malformed-JSON error from the tool call; re-running usually fixes it. Claude's tool-use is more consistent, which is the main reason to switch once you're past free testing.
- **FCPXML media path.** The `.fcpxml` references the source video by a local file path (`src` on the asset), since FCPXML has no concept of "download this from Drive." By default it points at `DEFAULT_LOCAL_MEDIA_DIR` + the original filename; you can override this per-run in the UI. Either way, place the original file at that path on the editing machine before opening the project, or let Final Cut prompt you to relink it, exactly as any other media-offline scenario.
- **Whisper's request size limit.** Audio is extracted as mono 16kHz mp3 to keep it small; if it's still over ~24MB (very long footage), it's auto-split into 10-minute chunks with `ffmpeg`'s segment muxer and re-stitched with corrected timestamps. Boundary words at chunk edges can occasionally be cut awkwardly; this is a known trade-off, not a bug.
- **Groq's free tier is rate-limited.** Fine for occasional/personal use; if you're running this against a lot of footage in a short window, you may hit Groq's free-tier request/token-per-minute caps and need to retry, wait, or move to a paid tier. See https://console.groq.com for current limits.
- **Short-form timestamps are snapped to transcript segment boundaries**, not to the model's raw numbers, so cuts land on clean speech edges. Clips outside 15-60s (beyond a small tolerance) are dropped rather than force-fit.
- **No em dashes, anywhere.** Enforced in the brand-voice system prompt for both LLM calls, regardless of provider.

## Project structure

```
app/
  page.tsx                        # main dashboard page
  layout.tsx / globals.css
  api/
    auth/google/route.ts          # start OAuth
    auth/google/callback/route.ts # OAuth callback, stores encrypted session cookie
    auth/logout/route.ts
    auth/status/route.ts
    drive/folder/route.ts         # set/get connected folder
    drive/files/route.ts          # list .mp4/.mov in the folder
    pipeline/run/route.ts         # the whole pipeline, streamed over SSE
components/
  Dashboard.tsx                   # all client-side UI + SSE consumption
lib/
  config.ts                       # env var access
  crypto.ts / session.ts          # encrypted session cookie
  google-drive.ts                 # OAuth + Drive API helpers
  media.ts                        # ffmpeg/ffprobe: probe, extract audio, chunk
  whisper.ts                      # Groq-hosted Whisper transcription + timestamp helpers
  brand-voice.ts                  # ABH system prompt
  llm.ts                          # provider-agnostic structured tool-use call (Groq or Claude)
  narrative.ts / shortform.ts     # structured (tool-use) generations, via lib/llm.ts
  fcpxml.ts                       # frame-accurate FCPXML builder
  docx-export.ts                  # docx builder
  sse.ts                          # SSE stream helper
  types.ts                        # shared types
```
