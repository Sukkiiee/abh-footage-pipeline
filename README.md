# ABH Footage Pipeline

Turns raw Google Drive footage into an editor-ready package: a long-form
narrative outline in the ABH (Africa's Business Heroes) brand voice, a
flagged list of self-contained 15-60s short-form moments, and three files an
editor can use immediately: a `.docx` writeup, a `.fcpxml` timeline that
opens directly in Final Cut Pro with every flagged clip already laid out on
the spine, and a `.srt` subtitle file of the full transcript.

## Pipeline

1. **Connect** — one-time Google OAuth (read-only Drive scope) + pick a folder.
2. **Detect** — lists `.mp4` / `.mov` files in that folder *and every subfolder beneath it* (breadth-first, capped at 300 subfolders / 1000 files / 8 levels deep as a safety limit against pathological folder trees), showing which subfolder each file came from. You can also skip browsing entirely and paste a share link (or raw file ID) for any specific video the connected account can see, in or out of that folder.
3. **Transcribe** — ffmpeg reads the video directly from a Drive streaming URL (with an auth header) and extracts audio; the source video is never downloaded to local/serverless disk, only the small extracted audio track is. ffmpeg's own HTTP client handles the range-request seeking a video container needs, including files with trailing metadata atoms (common in unprocessed camera footage). Audio is transcribed with Whisper via Groq's free-tier hosted API (segment-level timestamps, auto-chunked for long footage).
4. **Narrative** — sends the timestamped transcript to an LLM with an ABH brand-voice system prompt, plus an optional producer **brief** (freeform context/angle), an optional **target video length** (guides section count/pacing, not enforced exactly), an optional **title direction** (keywords/angle, not a fixed title), and any uploaded **reference documents** (see below). The model proposes several distinct **title options** rather than settling on one; the strongest option is used by default for exports/filenames, and all options are returned for the producer to review. Returns a structured long-form narrative with timestamp citations, via forced tool-use (not free-text JSON parsing). Defaults to a free Groq-hosted Llama model; switchable to Claude via one env var (see Setup).
5. **Short-form** — a second LLM call flags self-contained 15-60s moments (hook in the first 2 seconds, single idea, clear payoff), each with its own set of title options (same "suggest, don't dictate" pattern as the long-form title), informed by the brief, the chosen long-form title if set, and any reference documents, validated/clamped against real transcript timestamps server-side.

**Reference documents.** You can upload other transcripts/scripts (`.txt`, `.md`, `.docx`; `.docx` parsed server-side via `mammoth`) as style and soundbite-quality guides -- e.g. past short-form picks that worked well. They're explicitly framed to the model as calibration material only ("what makes a strong moment"), never as facts about the current footage, so it doesn't blend content across videos. Capped at 60,000 combined characters per run by default (`REFERENCE_MATERIAL_MAX_CHARS`, tunable) -- it's sent to the LLM on every run, both the narrative and short-form calls, so raising it trades cost/latency for how much of your reference material actually gets used instead of silently truncated.

**Reference videos.** You can also paste a video link (YouTube, Instagram, Google Drive, or most other sites) instead of/alongside uploading documents. Each platform is handled differently:
- **Google Drive** links reuse the exact same streaming-from-Drive + Whisper pipeline as the main footage.
- **YouTube** links resolve a direct audio-only CDN URL via `yt-dlp` (no download step) and hand that straight to ffmpeg, same "stream, don't download" approach as the Drive path -- the only thing ever written to disk is the small final extracted mp3. If that fails for any reason (an expired resolved URL, an unusual format), it automatically falls back to the download-based approach below. Measured live: this is currently *slower* in practice than plain downloading (~40-50s vs. ~30s for a short clip), because YouTube's current anti-bot measures make yt-dlp's metadata-resolution step slow in server environments without a JS runtime available -- it's kept anyway since it still avoids the local file write, but don't expect a speed win.
- **Instagram and everything else** goes through `yt-dlp`'s own downloader (auto-downloaded and cached on first use) to pull audio only, then the same Whisper transcription. Instagram specifically is best-effort: many posts require a logged-in session this app doesn't have configured, and will fail with a clear error rather than something silently wrong.

The resulting timestamped transcript is added as another reference entry either way. This downloads third-party content on your behalf -- make sure your use complies with the source platform's terms and any applicable copyright law; it's meant for personal creative reference, not redistribution.
6. **Export** — builds a frame-accurate `.fcpxml` (asset + one asset-clip per flagged moment, back to back on the spine, with markers), a `.docx` (narrative outline + short-form picks table, including the alternate title options considered), and a `.srt` (one caption block per Whisper segment, full transcript with timestamps).
7. **Output** — all files are streamed to the browser as direct downloads; nothing is persisted server-side. Footage is check-box selectable rather than one "Run" button per file: check the videos you want (or use "Select all new" / "Select all"), then **"Run selected"** processes them sequentially. A single selected video behaves as before (its own `.docx`/`.fcpxml`/`.srt`). Selecting more than one **combines all of them into a single document set** instead of one per video: one `.docx` with every video's narrative sections (grouped and labeled by source) plus one combined short-form picks table, one `.fcpxml` timeline with every video as its own asset and every flagged clip from every video laid back-to-back in order (correctly handling source videos with different frame rates), and one `.srt` with each video's captions concatenated back-to-back as if they played consecutively.

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

## Deploying for free (Render)

Vercel's free (Hobby) tier caps serverless functions at well under a minute, which this pipeline will blow past on any real footage -- it isn't a fit for genuinely free hosting here. **Render's free tier is**: free web services support up to a 100-minute request duration (this runs as a normal persistent Node process there, not a short-lived serverless function), so the whole pipeline can just run to completion. The tradeoff: a free Render service spins down after 15 minutes with no traffic, and the next request pays a ~30-60s cold-start penalty to spin back up -- fine for occasional/personal use, not an always-on production service.

1. Push this repo to GitHub.
2. [render.com](https://render.com) → **New → Web Service** → connect the repo.
3. Build command: `npm install && npm run build`. Start command: `npm run start` (already reads Render's injected `$PORT`).
4. Add the same environment variables from `.env.local` under the service's **Environment** tab. You don't need to set `APP_URL` -- the app already falls back to Render's auto-injected `RENDER_EXTERNAL_URL`.
5. Once deployed, go back to Google Cloud Console → your OAuth client → **Authorized redirect URIs** → add `https://your-app.onrender.com/api/auth/google/callback` (keep the `localhost:3000` one too, for local dev).
6. Google Cloud Console → **OAuth consent screen → Test users** → add the Google account(s) of anyone besides you who should be able to connect Drive (see below).

## Deploying to Vercel (paid, for long footage without cold starts)

```bash
vercel deploy
```

Set the same environment variables in the Vercel project settings (Production and Preview). Set `APP_URL` to your deployed URL (or rely on Vercel's auto-injected `VERCEL_URL`, which the app already falls back to).

**Function duration matters here.** The whole pipeline (download, ffmpeg, Whisper, two LLM calls, exports) runs inside one request. `app/api/pipeline/run/route.ts` sets `maxDuration = 800`, which requires a **Vercel Pro plan with Fluid Compute enabled**. On Hobby (10-60s cap) or Pro without Fluid Compute (300s cap), long footage will hit the timeout mid-pipeline. Rough guide:

- Under ~15-20 min of footage: fine even at a 300s cap.
- Longer than that: you need the extended (800s) duration, or you'll want to move to a background-job architecture (see Limitations).

## Letting other people use it

This already supports multiple people without any code changes: each visitor gets their own encrypted session cookie in their own browser, so each person connects their own Google account and their own Drive folder independently. Two things to know before sharing the URL around:

- **Google's OAuth app is in Testing mode by default**, capped at 100 explicitly-added test users -- add each person's Google account under **OAuth consent screen → Test users** in Google Cloud Console, or they'll hit an "access blocked" error. Opening it to the general public (not pre-added accounts) requires Google's app-verification review for the Drive scope, which is a separate process (privacy policy, terms of service, review turnaround) outside this app's code.
- **Your Groq/Anthropic API keys are shared across everyone who uses the deployed instance** -- their usage draws on your quota/cost, and Groq's free-tier rate limit is shared too, so several people running pipelines at once will hit it faster than solo use.

## Limitations / things to know

- **No database, by design.** This is built for a single connected Drive account. Multi-user support, a job history, or server-side "already processed" tracking would need a real datastore (e.g. Vercel Postgres) — a deliberate simplicity trade-off for this version.
- **Synchronous pipeline.** There's no queue or retry; if it fails partway through (e.g. an LLM API hiccup), you re-run the file from the file list. Nothing is left half-written since outputs are only produced at the very end.
- **Groq's free-tier LLM (Llama) is less reliable at forced structured output than Claude.** Under `LLM_PROVIDER=groq` (the default), an occasional run may fail with a malformed-JSON error from the tool call; re-running usually fixes it. Claude's tool-use is more consistent, which is the main reason to switch once you're past free testing.
- **FCPXML media path.** The `.fcpxml` references the source video by a local file path (`src` on the asset), since FCPXML has no concept of "download this from Drive." By default it points at `DEFAULT_LOCAL_MEDIA_DIR` + the original filename; you can override this per-run in the UI. Either way, place the original file at that path on the editing machine before opening the project, or let Final Cut prompt you to relink it, exactly as any other media-offline scenario.
- **Whisper's request size limit.** Audio is extracted as mono 16kHz mp3 to keep it small; if it's still over ~24MB (very long footage), it's auto-split into 10-minute chunks with `ffmpeg`'s segment muxer and re-stitched with corrected timestamps. Boundary words at chunk edges can occasionally be cut awkwardly; this is a known trade-off, not a bug.
- **Groq's free tier is rate-limited.** Fine for occasional/personal use; if you're running this against a lot of footage in a short window, you may hit Groq's free-tier request/token-per-minute caps and need to retry, wait, or move to a paid tier. See https://console.groq.com for current limits.
- **Short-form timestamps are snapped to transcript segment boundaries**, not to the model's raw numbers, so cuts land on clean speech edges. Clips outside 15-60s (beyond a small tolerance) are dropped rather than force-fit.
- **No em dashes, anywhere.** Enforced in the brand-voice system prompt for both LLM calls, regardless of provider.
- **Pause/Stop take effect at safe checkpoints, not instantly mid-operation.** You can pause/stop between pipeline stages, and between individual Whisper chunk uploads during transcription (the usual bottleneck for long footage) -- but not, say, half a second into a single ffmpeg audio extraction. Stop does actively kill the running ffmpeg process and abort any in-flight Groq/Claude request rather than just giving up on listening, so it does save real time/cost, just not with zero latency.
- **Pause/Stop use an in-memory job registry (`lib/job-control.ts`), not a database.** This works reliably locally and on a single serverless instance, since the control request and the running pipeline request share the same process. It is *not* guaranteed if a deployment scales to multiple concurrent serverless instances -- a pause/stop request could land on a different instance than the one running the job and silently no-op. Full production robustness for that case would need a shared store (e.g. Vercel KV) instead of in-memory state.
- **Time estimates are learned from your own past runs, not a guessed constant.** They're based on a simple bytes-processed-per-second average across runs completed on this machine (stored in `localStorage`), so there's no estimate until at least one run has finished, and accuracy improves as you use it more.

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
    pipeline/run/route.ts         # the whole pipeline for one video, streamed over SSE
    pipeline/combine/route.ts     # merges several already-run videos' results into one docx/fcpxml
    pipeline/control/route.ts     # pause/resume/stop a running pipeline by jobId
    reference/parse/route.ts      # extracts text from an uploaded .docx reference document (mammoth)
    reference/video/route.ts      # downloads + transcribes a reference video link (Drive, YouTube, etc.)
components/
  Dashboard.tsx                   # all client-side UI + SSE consumption
lib/
  config.ts                       # env var access
  crypto.ts / session.ts          # encrypted session cookie
  google-drive.ts                 # OAuth + Drive API helpers
  media.ts                        # ffmpeg/ffprobe: probe, extract audio, chunk (abort-aware)
  job-control.ts                  # in-memory pause/resume/stop registry (see Limitations)
  whisper.ts                      # Groq-hosted Whisper transcription + timestamp helpers
  brand-voice.ts                  # ABH system prompt
  llm.ts                          # provider-agnostic structured tool-use call (Groq or Claude)
  reference-material.ts           # shared prompt formatting for uploaded reference documents
  reference-video.ts              # extracts a reference video link's transcript (Drive or yt-dlp)
  ytdlp.ts                        # fetches/caches a standalone yt-dlp binary on first use
  narrative.ts / shortform.ts     # structured (tool-use) generations, via lib/llm.ts
  fcpxml.ts                       # frame-accurate FCPXML builder (single-video and multi-video/combined)
  docx-export.ts                  # docx builder
  srt.ts                          # SRT subtitle builder
  sse.ts                          # SSE stream helper
  types.ts                        # shared types
```
