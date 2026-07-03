import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { drive_v3 } from 'googleapis';
import { getYtDlpPath } from './ytdlp';
import { extractFileId, getDriveMediaUrl, getFileMetadata, VIDEO_MIME_TYPES } from './google-drive';
import { extractAudio, chunkAudioIfNeeded } from './media';
import { transcribeChunks, transcriptToPromptText } from './whisper';

const execFileAsync = promisify(execFile);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegBinaryPath: string = require('ffmpeg-static');

export interface ReferenceVideoResult {
  title: string;
  /** Timestamped transcript text, in the same [start - end] format used elsewhere, ready to feed into formatReferenceBlock. */
  text: string;
}

function isGoogleDriveUrl(url: string): boolean {
  return /(^|\.)drive\.google\.com/i.test(url);
}

/**
 * A Drive video link is handled with the exact same machinery as the main
 * pipeline (stream directly from Drive into ffmpeg, no local video file)
 * since the connected account's own OAuth token already grants access --
 * no separate downloader needed for this one platform.
 */
async function extractFromDriveUrl(
  drive: drive_v3.Drive,
  accessToken: string,
  url: string
): Promise<ReferenceVideoResult> {
  const fileId = extractFileId(url);
  const fileMeta = await getFileMetadata(drive, fileId);

  if (!VIDEO_MIME_TYPES.includes(fileMeta.mimeType)) {
    throw new Error(
      `"${fileMeta.name}" isn't an .mp4/.mov file (got ${fileMeta.mimeType || 'unknown type'}).`
    );
  }

  const remoteSource = {
    url: getDriveMediaUrl(fileId),
    headers: { Authorization: `Bearer ${accessToken}` },
  };

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abh-ref-drive-'));
  try {
    const audioPath = path.join(workDir, 'audio.mp3');
    await extractAudio(remoteSource, audioPath);
    const chunks = await chunkAudioIfNeeded(audioPath, workDir);
    const transcript = await transcribeChunks(chunks);
    return { title: fileMeta.name, text: transcriptToPromptText(transcript) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Everything else (YouTube, Instagram, and anything else yt-dlp supports)
 * goes through yt-dlp to pull audio only, then the same Whisper
 * transcription used everywhere else in the app.
 *
 * Known reliability differences by platform: YouTube generally works
 * well for public videos. Instagram is best-effort -- many posts
 * (private accounts, some Reels/Stories) require a logged-in session
 * that isn't configured here, and will fail with a clear error rather
 * than silently returning nothing.
 */
async function extractFromGenericVideoUrl(url: string): Promise<ReferenceVideoResult> {
  const ytDlpPath = await getYtDlpPath();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abh-ref-ytdlp-'));

  try {
    const outputTemplate = path.join(workDir, 'audio.%(ext)s');

    let stdout: string;
    try {
      const result = await execFileAsync(
        ytDlpPath,
        [
          '-x',
          '--audio-format',
          'mp3',
          '--audio-quality',
          '5',
          '--ffmpeg-location',
          ffmpegBinaryPath,
          '--no-playlist',
          // --print implies --simulate on its own, which would otherwise
          // skip the actual download entirely while still happily printing
          // the title -- --no-simulate overrides that so both happen.
          '--no-simulate',
          '--print',
          'title',
          '-o',
          outputTemplate,
          url,
        ],
        { maxBuffer: 10 * 1024 * 1024, timeout: 5 * 60 * 1000 }
      );
      stdout = result.stdout;
    } catch (err) {
      const stderr =
        err && typeof err === 'object' && 'stderr' in err
          ? String((err as { stderr?: string }).stderr || '')
          : '';
      const hint = stderr
        .split('\n')
        .filter((l) => l.trim())
        .slice(-3)
        .join(' ');
      throw new Error(
        `Could not fetch that video link${hint ? `: ${hint}` : ''}. Instagram posts in particular often need a logged-in session this app doesn't have configured; a public YouTube link is the most reliable option.`
      );
    }

    const title = stdout.trim().split('\n')[0] || url;
    const audioPath = path.join(workDir, 'audio.mp3');

    if (!fs.existsSync(audioPath)) {
      throw new Error(
        'That link did not produce an audio file. It may be private, region-locked, or from a site yt-dlp does not support.'
      );
    }

    const chunks = await chunkAudioIfNeeded(audioPath, workDir);
    const transcript = await transcribeChunks(chunks);
    return { title, text: transcriptToPromptText(transcript) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export interface DriveAuthContext {
  drive: drive_v3.Drive;
  accessToken: string;
}

export async function extractReferenceFromUrl(
  url: string,
  driveCtx?: DriveAuthContext
): Promise<ReferenceVideoResult> {
  if (isGoogleDriveUrl(url)) {
    if (!driveCtx) {
      throw new Error('Connect Google Drive first to use a Drive video link as reference material.');
    }
    return extractFromDriveUrl(driveCtx.drive, driveCtx.accessToken, url);
  }
  return extractFromGenericVideoUrl(url);
}
