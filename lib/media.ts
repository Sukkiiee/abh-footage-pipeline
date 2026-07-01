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
const ffprobeStatic: { path: string } = require('ffprobe-static');

const resolvedFfmpegPath = ffmpegStaticPath || '/usr/bin/ffmpeg';
const resolvedFfprobePath = ffprobeStatic.path || '/usr/bin/ffprobe';

// Serverless filesystems sometimes extract node_modules with the exec bit
// stripped; this is a harmless no-op if it's already executable.
for (const bin of [resolvedFfmpegPath, resolvedFfprobePath]) {
  try {
    fs.chmodSync(bin, 0o755);
  } catch {
    // best effort
  }
}

ffmpeg.setFfmpegPath(resolvedFfmpegPath);
ffmpeg.setFfprobePath(resolvedFfprobePath);

export function probeVideo(videoPath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, data) => {
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
        fileName: path.basename(videoPath),
        durationSec: Number.isFinite(durationSec) ? durationSec : 0,
        width: videoStream.width || 1920,
        height: videoStream.height || 1080,
        frameRateNum: num,
        frameRateDen: den,
        hasAudio: !!audioStream,
      });
    });
  });
}

/** Extracts a mono 16kHz mp3 track, small enough for fast upload/transcription. */
export function extractAudio(
  videoPath: string,
  audioOutPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
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
  workDir: string
): Promise<AudioChunk[]> {
  const stats = fs.statSync(audioPath);
  if (stats.size <= WHISPER_MAX_BYTES) {
    return [{ path: audioPath, offsetSec: 0 }];
  }

  const pattern = path.join(workDir, 'chunk_%03d.mp3');
  await new Promise<void>((resolve, reject) => {
    ffmpeg(audioPath)
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
