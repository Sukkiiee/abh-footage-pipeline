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
import { config } from './config';

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

function isYouTubeUrl(url: string): boolean {
  return /(^|\.)(youtube\.com|youtu\.be)/i.test(url);
}

// A generic modern desktop browser UA; googlevideo.com CDN URLs generally
// just need *some* reasonable UA present, not the exact one yt-dlp used to
// resolve the URL.
const STREAMING_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BOM = '﻿';
const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';

/**
 * Writes YT_DLP_COOKIES_CONTENT (if configured) to a cookies.txt file
 * inside the given directory and returns its path, or undefined if no
 * cookies are configured. YouTube's bot detection challenges requests from
 * datacenter/cloud IPs (a hosted deployment) far more than a typical home
 * connection, and will outright refuse ("Sign in to confirm you're not a
 * bot") without a real logged-in session's cookies -- this is yt-dlp's own
 * documented fix for that, not something specific to this app.
 *
 * yt-dlp requires the very first line to contain "netscape http cookie
 * file" (case-insensitive) to recognize the format at all. Pasting the
 * exported file's contents through an env var / a hosting dashboard's text
 * box is exactly the kind of step that can lose or mangle that first
 * comment line (a leading BOM, a paste that started from the data rows
 * instead of the top of the file, etc.) -- normalize defensively rather
 * than trust it survived copy-paste intact.
 */
function writeCookiesFileIfConfigured(workDir: string): string | undefined {
  if (!config.ytDlpCookiesContent) return undefined;

  let content = config.ytDlpCookiesContent;
  if (content.startsWith(BOM)) {
    content = content.slice(BOM.length);
  }

  const firstLine = content.split('\n')[0] || '';
  if (!firstLine.toLowerCase().includes('netscape http cookie file')) {
    content = `${NETSCAPE_HEADER}\n${content}`;
  }

  const cookiesPath = path.join(workDir, 'cookies.txt');
  fs.writeFileSync(cookiesPath, content, 'utf8');
  return cookiesPath;
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
 * YouTube-specific fast path: resolve the direct CDN URL for the best
 * audio-only stream via `yt-dlp -g` (no download at all, just metadata
 * resolution) and hand that URL straight to ffmpeg, exactly like the Drive
 * remote-source path -- so the only thing ever written to disk is the
 * small final extracted mp3, not an intermediate downloaded audio file.
 *
 * Only attempted for YouTube specifically: its resolved URLs are reliably
 * fetchable with just a standard User-Agent, and the -g path is
 * well-trodden for this site. Other sites (Instagram in particular) tend
 * to need session/cookie handling that yt-dlp's own downloader manages
 * internally but `-g` mode does not surface -- for those, the download-
 * based path below (which lets yt-dlp handle its own auth/format quirks)
 * is more reliable, not less.
 */
async function extractFromYouTubeUrlStreaming(url: string): Promise<ReferenceVideoResult> {
  const ytDlpPath = await getYtDlpPath();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abh-ref-yt-stream-'));

  try {
    const cookiesPath = writeCookiesFileIfConfigured(workDir);

    // One combined call for both fields, not two separate ones: YouTube
    // extraction currently runs a lengthy (~30-45s) info-resolution step per
    // invocation in environments without a JS runtime available to yt-dlp
    // (common on a plain server), and issuing it twice roughly doubles that
    // wait for no benefit -- measured ~95s for two calls vs. ~40s for one.
    const { stdout } = await execFileAsync(
      ytDlpPath,
      [
        '-f',
        'bestaudio',
        '--skip-download',
        '--no-playlist',
        ...(cookiesPath ? ['--cookies', cookiesPath] : []),
        '--print',
        '%(title)s',
        '--print',
        '%(urls)s',
        url,
      ],
      { maxBuffer: 2 * 1024 * 1024, timeout: 90 * 1000 }
    );

    const lines = stdout.trim().split('\n').filter((l) => l.trim());
    const title = lines[0] || url;
    // --print urls can itself be multiple lines for some formats; -f
    // bestaudio should keep it to one, but take the last line defensively.
    const directUrl = lines.length > 1 ? lines[lines.length - 1] : undefined;

    if (!directUrl) {
      throw new Error('yt-dlp did not resolve a direct audio URL for this video.');
    }

    const remoteSource = {
      url: directUrl,
      headers: { 'User-Agent': STREAMING_USER_AGENT },
    };

    const audioPath = path.join(workDir, 'audio.mp3');
    await extractAudio(remoteSource, audioPath);
    const chunks = await chunkAudioIfNeeded(audioPath, workDir);
    const transcript = await transcribeChunks(chunks);
    return { title, text: transcriptToPromptText(transcript) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Everything else (Instagram, and anything else yt-dlp supports), plus the
 * fallback if YouTube's streaming path above fails for any reason (an
 * expired resolved URL, an unusual format, etc.) -- goes through yt-dlp's
 * own downloader to pull audio only, then the same Whisper transcription
 * used everywhere else in the app.
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
    const cookiesPath = writeCookiesFileIfConfigured(workDir);

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
          ...(cookiesPath ? ['--cookies', cookiesPath] : []),
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
      const isBotCheck = /sign in to confirm/i.test(stderr);
      const suffix = isBotCheck
        ? ' This is YouTube challenging the request as coming from a datacenter/cloud IP (common on a hosted deployment, rarer on a home connection) -- set YT_DLP_COOKIES_CONTENT to a real logged-in session\'s exported cookies.txt to fix it (see README).'
        : " Instagram posts in particular often need a logged-in session this app doesn't have configured; a public YouTube link is the most reliable option.";
      throw new Error(`Could not fetch that video link${hint ? `: ${hint}` : ''}.${suffix}`);
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

  if (isYouTubeUrl(url)) {
    try {
      return await extractFromYouTubeUrlStreaming(url);
    } catch {
      // Streaming path failed (expired URL, unusual format, etc.) -- fall
      // back to the ordinary download-based path rather than failing the
      // whole request over what's usually a transient/edge-case issue.
      return extractFromGenericVideoUrl(url);
    }
  }

  return extractFromGenericVideoUrl(url);
}
