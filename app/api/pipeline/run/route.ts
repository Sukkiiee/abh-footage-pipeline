import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createSseStream, SSE_HEADERS, SseController } from '@/lib/sse';
import {
  requireDrive,
  getFileMetadata,
  getDriveMediaUrl,
  extractFileId,
  VIDEO_MIME_TYPES,
  NotConnectedError,
  getConnectedAccountEmail,
} from '@/lib/google-drive';
import { VideoSource, probeVideo, extractAudio, chunkAudioIfNeeded } from '@/lib/media';
import { transcribeChunks, formatTimestamp } from '@/lib/whisper';
import { generateNarrative } from '@/lib/narrative';
import { extractShortFormClips } from '@/lib/shortform';
import { buildFcpxml } from '@/lib/fcpxml';
import { buildNarrativeDocx } from '@/lib/docx-export';
import { buildSrt } from '@/lib/srt';
import { writeSession } from '@/lib/session';
import { config } from '@/lib/config';
import { createJob, removeJob, checkpoint, getJobSignal, waitForApproval } from '@/lib/job-control';
import { SessionData } from '@/lib/types';

// This route runs the entire pipeline (download -> ffmpeg -> Whisper ->
// Claude x2 -> exports) inside a single request/response cycle, streaming
// progress back over SSE. It needs a long function timeout: Vercel Hobby
// caps at 60s, Pro at 300s standard or up to 800s with Fluid Compute
// enabled. See README for plan requirements on long footage.
export const runtime = 'nodejs';
export const maxDuration = 800;

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_');
}

// Confirmed in production: a large enough source file (15GB+) made a run
// fail completely silently -- the connection dropped mid-step with no SSE
// 'error' event ever sent, because nothing server-side got the chance to
// send one. The likely cause: probing/extracting audio from a huge remote
// file over HTTP can run for minutes with zero bytes written to the
// response in between, and a proxy/load balancer in front of the app
// (Render's included) can treat that as an idle connection and kill it.
// Sending a lightweight heartbeat progress event on an interval during
// exactly those two long, silent, network-bound steps keeps the response
// actively flowing so it isn't mistaken for idle.
function withHeartbeat<T>(
  sse: SseController,
  stage: string,
  message: string,
  percent: number,
  work: Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    sse.send('progress', { stage, message: `${message} (still working, ${elapsedSec}s elapsed)`, percent });
  }, 15_000);

  return work.finally(() => clearInterval(interval));
}

export async function POST(req: NextRequest) {
  let fileId = '';
  let localSourcePath = '';
  let localMediaPath: string | undefined;
  let brief: string | undefined;
  let titleHint: string | undefined;
  let referenceMaterial: string | undefined;
  let targetLengthMinutes: number | undefined;
  let jobId: string | undefined;
  let llmProviderMode: 'groq' | 'anthropic' | 'auto' | undefined;

  try {
    const body = await req.json();

    // Three ways to point at a source video: a fileId (from the connected-
    // folder file list), a pasted Drive share link, or a local disk path
    // (footage read directly off the machine running this app, no Drive
    // involved at all -- see lib/local-files.ts).
    if (body.localPath) {
      localSourcePath = String(body.localPath);
    } else if (body.fileId) {
      fileId = String(body.fileId);
    } else if (body.driveLink) {
      fileId = extractFileId(String(body.driveLink));
    }

    localMediaPath = body.localMediaPath ? String(body.localMediaPath) : undefined;
    brief = body.brief ? String(body.brief) : undefined;
    titleHint = body.titleHint ? String(body.titleHint) : undefined;
    referenceMaterial = body.referenceMaterial ? String(body.referenceMaterial) : undefined;
    jobId = body.jobId ? String(body.jobId) : undefined;
    llmProviderMode =
      body.llmProviderMode === 'groq' || body.llmProviderMode === 'anthropic' || body.llmProviderMode === 'auto'
        ? body.llmProviderMode
        : undefined;

    if (body.targetLengthMinutes !== undefined && body.targetLengthMinutes !== null && body.targetLengthMinutes !== '') {
      const parsed = Number(body.targetLengthMinutes);
      if (Number.isFinite(parsed) && parsed > 0) {
        targetLengthMinutes = parsed;
      }
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  // Registered as early as possible -- immediately once we have a jobId,
  // before any of the slower async work below (Drive auth in particular can
  // take a real fraction of a second). The client shows the Pause/Cancel
  // controls the instant it sends this request, so if job registration
  // happened any later than this, clicking either during that window would
  // hit a job the server hasn't recorded yet and get a false "that run is
  // no longer active" error -- confirmed happening in practice. Every early
  // return below now cleans this up on its way out so a request that never
  // reaches the actual pipeline doesn't leave a phantom entry behind.
  if (jobId) createJob(jobId);
  const signal = jobId ? getJobSignal(jobId) : undefined;

  if (!fileId && !localSourcePath) {
    if (jobId) removeJob(jobId);
    return NextResponse.json(
      { error: 'Provide a fileId, a Drive video link, or a local file path.' },
      { status: 400 }
    );
  }

  if (localSourcePath && !config.localFootageEnabled) {
    if (jobId) removeJob(jobId);
    return NextResponse.json(
      {
        error:
          'Local footage is disabled on this deployment. Set ENABLE_LOCAL_FOOTAGE=true in your environment (only appropriate when running this app on your own machine) to turn it on.',
      },
      { status: 403 }
    );
  }

  // A local-source run needs no Drive access at all -- skip the whole auth
  // gate rather than forcing an unrelated Drive connection just to process
  // a file that never touches Drive.
  let session: SessionData | undefined;
  let accessToken: string | undefined;
  let finalizeTokens: (() => ReturnType<Awaited<ReturnType<typeof requireDrive>>['finalizeTokens']>) | undefined;
  let drive: Awaited<ReturnType<typeof requireDrive>>['drive'] | undefined;

  if (!localSourcePath) {
    let authCtx;
    try {
      authCtx = await requireDrive(req);
    } catch (err) {
      if (jobId) removeJob(jobId);
      const status = err instanceof NotConnectedError ? 401 : 500;
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Authorization error.' },
        { status }
      );
    }
    drive = authCtx.drive;
    session = authCtx.session;
    accessToken = authCtx.accessToken;
    finalizeTokens = authCtx.finalizeTokens;
  }

  // Resolved once, up front: any refresh_token rotation Google decides to do
  // mid-pipeline (very unlikely inside a token's ~1hr lifetime) won't be
  // persisted, but the proactive refresh that already happened will be.
  const refreshedTokens = finalizeTokens ? finalizeTokens() : null;

  const stream = createSseStream(async (sse) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abh-'));

    // Only meaningful in 'auto' provider mode, and only once a transcript
    // turns out too large for Groq's free-tier limits: sends a real cost
    // estimate over SSE and blocks until the client answers via
    // /api/pipeline/control's approve/deny actions (see lib/job-control.ts).
    // No jobId (an older/ad-hoc caller) means there's no way to answer this
    // mid-stream, so it's simply not offered -- generateNarrative/
    // extractShortFormClips fall back to Groq's free chunked path whenever
    // this is undefined, never spending anything without it.
    const requestApproval = jobId
      ? async (estimatedCostUSD: number, blockedReason?: string) => {
          sse.send('approval-required', {
            estimatedCostUSD,
            capBlockedReason: blockedReason,
            message: blockedReason
              ? `${blockedReason} An admin override code is needed to use Anthropic anyway.`
              : `This video is large enough that Groq's free tier can't process it in one go. Switching to Anthropic for this step would cost approximately $${estimatedCostUSD.toFixed(2)}.`,
          });
          return waitForApproval(jobId!);
        }
      : undefined;

    // The connected Drive account's email when available (purely for the
    // Anthropic spend log's "who spent this" column -- see
    // lib/anthropic-usage.ts), falling back to a per-machine identifier
    // for local-footage runs with no Drive connection at all.
    const spendIdentifier = drive ? (await getConnectedAccountEmail(drive)) || os.hostname() : os.hostname();

    try {
      let sourceFileName: string;
      let remoteSource: VideoSource;

      if (localSourcePath) {
        if (jobId) await checkpoint(jobId);
        sse.send('progress', { stage: 'metadata', message: 'Checking local file...', percent: 2 });

        const stat = await fs.promises.stat(localSourcePath).catch(() => null);
        if (!stat || !stat.isFile()) {
          throw new Error(
            `"${localSourcePath}" isn't a file this server process can see. Local footage is read directly off the disk of the machine running this app.`
          );
        }
        const ext = path.extname(localSourcePath).toLowerCase();
        if (ext !== '.mp4' && ext !== '.mov') {
          throw new Error(`"${localSourcePath}" isn't an .mp4/.mov file.`);
        }

        sourceFileName = path.basename(localSourcePath);
        remoteSource = localSourcePath;
        // No maxSourceFileGB check here: that cap exists for network-
        // streamed Drive sources under a hosted deployment's time/proxy
        // constraints, neither of which applies to a local file being read
        // straight off disk by a process running on the same machine.
      } else {
        sse.send('progress', {
          stage: 'metadata',
          message: 'Fetching file metadata from Drive...',
          percent: 2,
        });
        const fileMeta = await getFileMetadata(drive!, fileId);

        if (!VIDEO_MIME_TYPES.includes(fileMeta.mimeType)) {
          throw new Error(
            `"${fileMeta.name}" isn't an .mp4/.mov file (got ${fileMeta.mimeType || 'unknown type'}). Check the link points to the right file.`
          );
        }

        const maxSourceBytes = config.maxSourceFileGB * 1024 * 1024 * 1024;
        if (fileMeta.size && Number(fileMeta.size) > maxSourceBytes) {
          throw new Error(
            `Source file is ${(Number(fileMeta.size) / 1e9).toFixed(1)}GB, which is over the current MAX_SOURCE_FILE_GB limit (${config.maxSourceFileGB}GB). Raise MAX_SOURCE_FILE_GB in .env.local or use a shorter export.`
          );
        }

        sourceFileName = fileMeta.name;
        // ffmpeg reads directly from Drive over HTTP (with an auth header)
        // -- the source video is never downloaded to local/serverless
        // disk. ffmpeg's own HTTP client handles the range-request seeking
        // a video container needs, including files with trailing metadata
        // atoms.
        remoteSource = {
          url: getDriveMediaUrl(fileId),
          headers: { Authorization: `Bearer ${accessToken}` },
        };
      }

      const probeMessage = localSourcePath
        ? 'Reading local video metadata (duration, frame rate, resolution)...'
        : 'Reading video metadata directly from Drive (duration, frame rate, resolution)...';
      sse.send('progress', { stage: 'probe', message: probeMessage, percent: 15 });
      const metadata = await withHeartbeat(sse, 'probe', probeMessage, 15, probeVideo(remoteSource));
      metadata.fileName = sourceFileName;

      if (jobId) await checkpoint(jobId);
      const audioMessage = localSourcePath
        ? 'Extracting audio from local file...'
        : 'Streaming audio track from Drive (no local video download)...';
      sse.send('progress', { stage: 'audio', message: audioMessage, percent: 30 });
      const audioPath = path.join(workDir, 'audio.mp3');
      await withHeartbeat(sse, 'audio', audioMessage, 30, extractAudio(remoteSource, audioPath, signal));

      if (jobId) await checkpoint(jobId);
      sse.send('progress', {
        stage: 'audio',
        message: 'Preparing audio for transcription...',
        percent: 35,
      });
      const chunks = await chunkAudioIfNeeded(audioPath, workDir, signal);

      sse.send('progress', {
        stage: 'transcribe',
        message: `Transcribing with Whisper (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})...`,
        percent: 45,
      });
      // onBeforeChunk lets a pause/stop take effect between individual
      // Whisper chunk uploads, not just between whole pipeline stages --
      // this is usually the slowest step for long footage. onChunkTranscribed
      // streams the real transcript text as each chunk actually finishes
      // (not fabricated/simulated), for a live transcript feed in the UI --
      // granular per audio chunk rather than per word, since that's what's
      // actually available without re-architecting Whisper's own response.
      const transcript = await transcribeChunks(
        chunks,
        signal,
        jobId ? () => checkpoint(jobId!) : undefined,
        (chunkSegments) => {
          if (chunkSegments.length === 0) return;
          sse.send('progress', {
            stage: 'transcribe',
            message: `Transcribing with Whisper (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})...`,
            percent: 45,
            transcriptLines: chunkSegments.slice(-4).map((s) => ({
              timestamp: formatTimestamp(s.start),
              text: s.text,
            })),
          });
        }
      );

      if (transcript.segments.length === 0) {
        throw new Error('Whisper returned an empty transcript for this file (no speech detected?).');
      }

      if (jobId) await checkpoint(jobId);
      sse.send('progress', {
        stage: 'narrative',
        message: 'Generating long-form narrative (ABH brand voice)...',
        percent: 60,
      });
      const narrative = await generateNarrative(transcript, sourceFileName, {
        brief,
        targetLengthMinutes,
        titleHint,
        referenceMaterial,
        signal,
        llmProviderMode,
        requestApproval,
        spendIdentifier,
        onNotice: (message) => sse.send('progress', { stage: 'narrative', message, percent: 60 }),
      });

      if (jobId) await checkpoint(jobId);
      sse.send('progress', {
        stage: 'shortform',
        message: 'Flagging self-contained short-form moments...',
        percent: 75,
      });
      // Pass the model's own top-pick long-form title (not the raw hint) so
      // clip titles read as part of the same series once one's been chosen.
      const { clips, rejected } = await extractShortFormClips(transcript, sourceFileName, {
        brief,
        videoTitle: narrative.title,
        referenceMaterial,
        signal,
        llmProviderMode,
        requestApproval,
        spendIdentifier,
        onNotice: (message) => sse.send('progress', { stage: 'shortform', message, percent: 75 }),
      });

      if (jobId) await checkpoint(jobId);
      sse.send('progress', {
        stage: 'export',
        message: 'Building .fcpxml, .docx, and .srt exports...',
        percent: 88,
      });

      const mediaPath =
        localMediaPath || localSourcePath || path.posix.join(config.defaultLocalMediaDir, sourceFileName);

      const fcpxmlString = buildFcpxml({
        sourceFileName,
        localMediaPath: mediaPath,
        metadata,
        clips,
        videoTitle: narrative.title,
      });

      const docxBuffer = await buildNarrativeDocx({
        sourceFileName,
        narrative,
        clips,
        generatedAt: new Date(),
      });

      const srtString = buildSrt(transcript);

      // Output filenames use the model's chosen (or hinted) top title,
      // falling back to the source filename.
      const baseName = sanitizeFileName(
        (narrative.title || sourceFileName.replace(/\.[^/.]+$/, '')).trim()
      );

      sse.send('done', {
        sourceFileName,
        narrative,
        clips,
        metadata,
        rejectedClipCount: rejected,
        docxBase64: docxBuffer.toString('base64'),
        fcpxmlBase64: Buffer.from(fcpxmlString, 'utf8').toString('base64'),
        srtBase64: Buffer.from(srtString, 'utf8').toString('base64'),
        docxFilename: `${baseName} - ABH Narrative.docx`,
        fcpxmlFilename: `${baseName} - Flagged Clips.fcpxml`,
        srtFilename: `${baseName} - Transcript.srt`,
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      if (jobId) removeJob(jobId);
    }
  });

  const response = new NextResponse(stream, { headers: SSE_HEADERS });
  if (refreshedTokens && session) {
    writeSession(response, { ...session, tokens: refreshedTokens });
  }
  return response;
}
