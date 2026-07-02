import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createSseStream, SSE_HEADERS } from '@/lib/sse';
import {
  requireDrive,
  getFileMetadata,
  downloadFileToPath,
  extractFileId,
  VIDEO_MIME_TYPES,
  NotConnectedError,
} from '@/lib/google-drive';
import { probeVideo, extractAudio, chunkAudioIfNeeded } from '@/lib/media';
import { transcribeChunks } from '@/lib/whisper';
import { generateNarrative } from '@/lib/narrative';
import { extractShortFormClips } from '@/lib/shortform';
import { buildFcpxml } from '@/lib/fcpxml';
import { buildNarrativeDocx } from '@/lib/docx-export';
import { writeSession } from '@/lib/session';
import { config } from '@/lib/config';

// This route runs the entire pipeline (download -> ffmpeg -> Whisper ->
// Claude x2 -> exports) inside a single request/response cycle, streaming
// progress back over SSE. It needs a long function timeout: Vercel Hobby
// caps at 60s, Pro at 300s standard or up to 800s with Fluid Compute
// enabled. See README for plan requirements on long footage.
export const runtime = 'nodejs';
export const maxDuration = 800;

const MAX_SOURCE_BYTES = 1.8 * 1024 * 1024 * 1024; // conservative /tmp headroom

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_');
}

export async function POST(req: NextRequest) {
  let fileId = '';
  let localMediaPath: string | undefined;
  let brief: string | undefined;
  let videoTitle: string | undefined;
  let targetLengthMinutes: number | undefined;

  try {
    const body = await req.json();

    // Either a fileId (from the connected-folder file list) or a pasted
    // Drive share link for a specific video works here -- access is
    // governed entirely by what the connected Drive account can see, not
    // by which folder the file happens to live in.
    if (body.fileId) {
      fileId = String(body.fileId);
    } else if (body.driveLink) {
      fileId = extractFileId(String(body.driveLink));
    }

    localMediaPath = body.localMediaPath ? String(body.localMediaPath) : undefined;
    brief = body.brief ? String(body.brief) : undefined;
    videoTitle = body.videoTitle ? String(body.videoTitle) : undefined;

    if (body.targetLengthMinutes !== undefined && body.targetLengthMinutes !== null && body.targetLengthMinutes !== '') {
      const parsed = Number(body.targetLengthMinutes);
      if (Number.isFinite(parsed) && parsed > 0) {
        targetLengthMinutes = parsed;
      }
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!fileId) {
    return NextResponse.json(
      { error: 'Provide a fileId or a Drive video link.' },
      { status: 400 }
    );
  }

  let authCtx;
  try {
    authCtx = await requireDrive(req);
  } catch (err) {
    const status = err instanceof NotConnectedError ? 401 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Authorization error.' },
      { status }
    );
  }

  const { drive, session } = authCtx;
  // Resolved once, up front: any refresh_token rotation Google decides to do
  // mid-pipeline (very unlikely inside a token's ~1hr lifetime) won't be
  // persisted, but the proactive refresh that already happened will be.
  const refreshedTokens = authCtx.finalizeTokens();

  const stream = createSseStream(async (sse) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abh-'));

    try {
      sse.send('progress', {
        stage: 'metadata',
        message: 'Fetching file metadata from Drive...',
        percent: 2,
      });
      const fileMeta = await getFileMetadata(drive, fileId);

      if (!VIDEO_MIME_TYPES.includes(fileMeta.mimeType)) {
        throw new Error(
          `"${fileMeta.name}" isn't an .mp4/.mov file (got ${fileMeta.mimeType || 'unknown type'}). Check the link points to the right file.`
        );
      }

      if (fileMeta.size && Number(fileMeta.size) > MAX_SOURCE_BYTES) {
        throw new Error(
          `Source file is ${(Number(fileMeta.size) / 1e9).toFixed(1)}GB, which is larger than this deployment supports in a single run. Consider a shorter export.`
        );
      }

      const videoPath = path.join(workDir, sanitizeFileName(fileMeta.name));
      sse.send('progress', {
        stage: 'download',
        message: `Downloading "${fileMeta.name}" from Drive...`,
        percent: 8,
      });
      await downloadFileToPath(drive, fileId, videoPath);

      sse.send('progress', {
        stage: 'probe',
        message: 'Reading video metadata (duration, frame rate, resolution)...',
        percent: 20,
      });
      const metadata = await probeVideo(videoPath);
      metadata.fileName = fileMeta.name;

      sse.send('progress', {
        stage: 'audio',
        message: 'Extracting audio track...',
        percent: 28,
      });
      const audioPath = path.join(workDir, 'audio.mp3');
      await extractAudio(videoPath, audioPath);

      sse.send('progress', {
        stage: 'audio',
        message: 'Preparing audio for transcription...',
        percent: 35,
      });
      const chunks = await chunkAudioIfNeeded(audioPath, workDir);

      sse.send('progress', {
        stage: 'transcribe',
        message: `Transcribing with Whisper (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})...`,
        percent: 45,
      });
      const transcript = await transcribeChunks(chunks);

      if (transcript.segments.length === 0) {
        throw new Error('Whisper returned an empty transcript for this file (no speech detected?).');
      }

      sse.send('progress', {
        stage: 'narrative',
        message: 'Generating long-form narrative (ABH brand voice)...',
        percent: 60,
      });
      const narrative = await generateNarrative(transcript, fileMeta.name, {
        brief,
        targetLengthMinutes,
        videoTitle,
      });

      sse.send('progress', {
        stage: 'shortform',
        message: 'Flagging self-contained short-form moments...',
        percent: 75,
      });
      const { clips, rejected } = await extractShortFormClips(transcript, fileMeta.name, {
        brief,
        videoTitle,
      });

      sse.send('progress', {
        stage: 'export',
        message: 'Building .fcpxml and .docx exports...',
        percent: 88,
      });

      const mediaPath =
        localMediaPath || path.posix.join(config.defaultLocalMediaDir, fileMeta.name);

      const fcpxmlString = buildFcpxml({
        sourceFileName: fileMeta.name,
        localMediaPath: mediaPath,
        metadata,
        clips,
        videoTitle,
      });

      const docxBuffer = await buildNarrativeDocx({
        sourceFileName: fileMeta.name,
        narrative,
        clips,
        generatedAt: new Date(),
      });

      // Prefer the user-supplied title for output filenames when set, since
      // that's what they'll recognize; fall back to the source filename.
      const baseName = sanitizeFileName(
        (videoTitle?.trim() || fileMeta.name.replace(/\.[^/.]+$/, '')).trim()
      );

      sse.send('done', {
        sourceFileName: fileMeta.name,
        narrative,
        clips,
        rejectedClipCount: rejected,
        docxBase64: docxBuffer.toString('base64'),
        fcpxmlBase64: Buffer.from(fcpxmlString, 'utf8').toString('base64'),
        docxFilename: `${baseName} - ABH Narrative.docx`,
        fcpxmlFilename: `${baseName} - Flagged Clips.fcpxml`,
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  const response = new NextResponse(stream, { headers: SSE_HEADERS });
  if (refreshedTokens) {
    writeSession(response, { ...session, tokens: refreshedTokens });
  }
  return response;
}
