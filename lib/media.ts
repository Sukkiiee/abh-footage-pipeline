import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { VideoMetadata } from './types';

// Loaded via require() rather than import: neither package ships (or
// reliably publishes) TS declarations, and require() sidesteps that
// entirely since its return type is `any`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegStaticPath: string | null = require('ffmpeg-static');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffprobeInstaller: { path: string } = require('@ffprobe-installer/ffprobe');

// Both `ffprobe-static`'s bundled 2018 binary AND `@ffprobe-installer`'s
// current (2023) one segfault (SIGSEGV) on Render -- confirmed live in
// production for both. Two different static builds crashing the same way
// rules out "just an old binary" and points at something more fundamental:
// Render's sandboxed container doesn't reliably run *statically linked*
// ffmpeg/ffprobe binaries at all (a known class of issue on gVisor-style
// sandboxes -- certain syscalls the static build makes aren't supported and
// the kernel delivers SIGSEGV instead of a clean ENOSYS).
//
// The fix: prefer the system's own dynamically-linked ffmpeg/ffprobe
// (installed via `apt-get install -y ffmpeg` in the Render build command --
// see README) when present, since a package-manager build is compiled
// against and linked for that exact host. Only fall back to the bundled
// static binaries -- which work fine locally/on most other hosts -- when no
// system install is found.
function findSystemBinary(name: 'ffmpeg' | 'ffprobe'): string | undefined {
  const candidates = [`/usr/bin/${name}`, `/usr/local/bin/${name}`];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const resolvedFfmpegPath = findSystemBinary('ffmpeg') || ffmpegStaticPath || '/usr/bin/ffmpeg';
const resolvedFfprobePath = findSystemBinary('ffprobe') || ffprobeInstaller.path || '/usr/bin/ffprobe';

// Serverless filesystems sometimes extract node_modules with the exec bit
// stripped; this is a harmless no-op if it's already executable (and for a
// system binary that we didn't write ourselves, this may simply no-op with
// a permission error, which is fine -- it's already executable).
for (const bin of [resolvedFfmpegPath, resolvedFfprobePath]) {
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // best effort
  }
}

ffmpeg.setFfmpegPath(resolvedFfmpegPath);
ffmpeg.setFfprobePath(resolvedFfprobePath);

/**
 * A video source: either a local file path, or a remote HTTP(S) URL with
 * headers ffmpeg's own HTTP demuxer should send with every request (used
 * for the Authorization header on a Drive media URL). Passing a URL lets
 * ffmpeg/ffprobe read (and range-seek) the source directly over the
 * network -- the file is never written to local/serverless disk.
 */
export type VideoSource = string | { url: string; headers: Record<string, string> };

function isRemoteSource(source: VideoSource): source is { url: string; headers: Record<string, string> } {
  return typeof source !== 'string';
}

/** ffmpeg's `-headers` flag wants every header CRLF-terminated, concatenated into one string. */
function formatFfmpegHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
}

/** Kills a running ffmpeg command as soon as the given signal aborts, so "Stop" actually cuts the process rather than letting it run to completion. */
function killOnAbort(command: ffmpeg.FfmpegCommand, signal?: AbortSignal): void {
  if (!signal) return;
  if (signal.aborted) {
    command.kill('SIGKILL');
    return;
  }
  signal.addEventListener('abort', () => command.kill('SIGKILL'), { once: true });
}

// Note: probing is fast (just reads metadata) and fluent-ffmpeg's static
// ffprobe() call doesn't expose a handle to kill the underlying process, so
// it isn't wired to the abort signal the way extractAudio/chunking are --
// a stop request during this step is picked up at the next checkpoint
// instead of killing it mid-flight.
export function probeVideo(source: VideoSource): Promise<VideoMetadata> {
  const input = isRemoteSource(source) ? source.url : source;
  const extraOptions = isRemoteSource(source)
    ? ['-headers', formatFfmpegHeaders(source.headers)]
    : undefined;

  return new Promise((resolve, reject) => {
    const callback = (err: Error | null, data: ffmpeg.FfprobeData) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message}`));

      const videoStream = data.streams.find((s) => s.codec_type === 'video');
      const audioStream = data.streams.find((s) => s.codec_type === 'audio');
      if (!videoStream) {
        return reject(new Error('No video stream found in the source file.'));
      }

      const rFrameRate = videoStream.r_frame_rate || '30/1';
      const [numRaw, denRaw] = rFrameRate.split('/').map(Number);
      const num = numRaw && !Number.isNaN(numRaw) ? numRaw : 30;
      const den = denRaw && !Number.isNaN(denRaw) ? denRaw : 1;

      const durationSec = parseFloat(
        String(data.format.duration ?? videoStream.duration ?? '0')
      );

      resolve({
        fileName: isRemoteSource(source) ? '' : path.basename(source),
        durationSec: Number.isFinite(durationSec) ? durationSec : 0,
        width: videoStream.width || 1920,
        height: videoStream.height || 1080,
        frameRateNum: num,
        frameRateDen: den,
        hasAudio: !!audioStream,
      });
    };

    if (extraOptions) {
      ffmpeg.ffprobe(input, extraOptions, callback);
    } else {
      ffmpeg.ffprobe(input, callback);
    }
  });
}

/** Extracts a mono 16kHz mp3 track, small enough for fast upload/transcription. */
export function extractAudio(
  source: VideoSource,
  audioOutPath: string,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = isRemoteSource(source) ? ffmpeg(source.url) : ffmpeg(source);
    if (isRemoteSource(source)) {
      command.inputOptions(['-headers', formatFfmpegHeaders(source.headers)]);
    }
    killOnAbort(command, signal);
    command
      .noVideo()
      .audioCodec('libmp3lame')
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('64k')
      .output(audioOutPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`Audio extraction failed: ${err.message}`)))
      .run();
  });
}

const WHISPER_MAX_BYTES = 24 * 1024 * 1024; // stay under OpenAI's 25MB limit
const CHUNK_SECONDS = 600; // 10 minutes per chunk

export interface AudioChunk {
  path: string;
  offsetSec: number;
}

/**
 * Splits the audio into fixed-length chunks if it's too large for a single
 * Whisper request. Uses stream copy (no re-encode) so it's fast, and each
 * chunk (except the last) is exactly CHUNK_SECONDS long, so offsets are
 * deterministic without needing to probe each chunk individually.
 */
export async function chunkAudioIfNeeded(
  audioPath: string,
  workDir: string,
  signal?: AbortSignal
): Promise<AudioChunk[]> {
  const stats = fs.statSync(audioPath);
  if (stats.size <= WHISPER_MAX_BYTES) {
    return [{ path: audioPath, offsetSec: 0 }];
  }

  const pattern = path.join(workDir, 'chunk_%03d.mp3');
  await new Promise<void>((resolve, reject) => {
    const command = ffmpeg(audioPath);
    killOnAbort(command, signal);
    command
      .outputOptions([
        '-f segment',
        `-segment_time ${CHUNK_SECONDS}`,
        '-c copy',
        '-reset_timestamps 1',
      ])
      .output(pattern)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`Audio chunking failed: ${err.message}`)))
      .run();
  });

  const files = fs
    .readdirSync(workDir)
    .filter((f) => f.startsWith('chunk_') && f.endsWith('.mp3'))
    .sort();

  if (files.length === 0) {
    throw new Error('Audio chunking produced no output files.');
  }

  return files.map((f, i) => ({
    path: path.join(workDir, f),
    offsetSec: i * CHUNK_SECONDS,
  }));
}
