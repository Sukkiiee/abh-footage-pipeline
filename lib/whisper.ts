import OpenAI from 'openai';
import fs from 'fs';
import { config } from './config';
import { AudioChunk } from './media';
import { Transcript, TranscriptSegment } from './types';

// Groq hosts open-source Whisper models behind an OpenAI-compatible API, so
// the official `openai` SDK works unmodified against it -- just point the
// base URL at Groq and use a Groq API key instead of an OpenAI one.
function getClient(): OpenAI {
  return new OpenAI({
    apiKey: config.groqApiKey,
    baseURL: 'https://api.groq.com/openai/v1',
  });
}

interface WhisperVerboseSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

async function transcribeChunk(filePath: string): Promise<WhisperVerboseSegment[]> {
  const client = getClient();
  const response = await client.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: config.groqWhisperModel,
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });

  // The SDK's base Transcription type doesn't always model the extra fields
  // verbose_json returns, so we read them off defensively.
  const verbose = response as unknown as {
    segments?: WhisperVerboseSegment[];
    text?: string;
  };

  if (verbose.segments && verbose.segments.length > 0) {
    return verbose.segments.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));
  }

  // Fallback if the API doesn't return segment-level data for some reason.
  return [{ id: 0, start: 0, end: 0, text: (verbose.text || '').trim() }];
}

/**
 * Transcribes one or more audio chunks (in order) and merges them into a
 * single timestamped transcript, offsetting each chunk's segment times by
 * its position in the original audio.
 */
export async function transcribeChunks(chunks: AudioChunk[]): Promise<Transcript> {
  const allSegments: TranscriptSegment[] = [];
  let runningId = 0;
  let maxEnd = 0;

  for (const chunk of chunks) {
    const segments = await transcribeChunk(chunk.path);
    for (const seg of segments) {
      const start = seg.start + chunk.offsetSec;
      const end = seg.end + chunk.offsetSec;
      allSegments.push({ id: runningId++, start, end, text: seg.text });
      if (end > maxEnd) maxEnd = end;
    }
  }

  allSegments.sort((a, b) => a.start - b.start);

  return {
    segments: allSegments,
    fullText: allSegments.map((s) => s.text).join(' '),
    durationSec: maxEnd,
  };
}

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [hh, mm, ss].map((n) => String(n).padStart(2, '0')).join(':');
}

export function parseTimestamp(ts: string): number {
  const parts = ts.split(':').map((p) => Number(p.trim()));
  if (parts.some((n) => Number.isNaN(n))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

/** Renders the transcript as `[start - end] text` lines for the Claude prompt. */
export function transcriptToPromptText(transcript: Transcript): string {
  return transcript.segments
    .map(
      (s) => `[${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}] ${s.text}`
    )
    .join('\n');
}
