import { Transcript } from './types';

/** Formats seconds as an SRT timestamp: HH:MM:SS,mmm */
function formatSrtTime(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const hh = Math.floor(clamped / 3600);
  const mm = Math.floor((clamped % 3600) / 60);
  const ss = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(ms, 3)}`;
}

/**
 * Builds a standard SRT subtitle file from the transcript's Whisper
 * segments, one caption block per segment. This gives the editor a
 * ready-to-import subtitle track alongside the FCPXML timeline and DOCX
 * writeup -- useful for review, captioning short-form clips, or just
 * reading the raw transcript with timestamps outside the app.
 */
export function buildSrt(transcript: Transcript): string {
  const blocks = transcript.segments.map((seg, i) => {
    const text = seg.text.trim();
    return `${i + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${text}\n`;
  });
  return blocks.join('\n');
}
