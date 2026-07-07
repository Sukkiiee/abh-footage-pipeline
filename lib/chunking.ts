import { Transcript, TranscriptSegment } from './types';

// A rough token estimate -- good enough to decide *whether* a request is
// at real risk of exceeding a free-tier rate limit, not meant to match
// exact provider billing/tokenization.
//
// This app's transcripts are dense with "[HH:MM:SS - HH:MM:SS]" prefixes on
// every line -- punctuation and digits tokenize less efficiently than plain
// English words, so the often-cited "~4 chars/token for English text" rule
// of thumb undercounts this app's actual prompts. Confirmed against a real
// production failure where Groq reported a request as far larger than a
// chars/4 estimate predicted. 3 chars/token is a calibrated middle ground:
// conservative enough to catch that failure case, without being so
// aggressive that it flags ordinary short videos as needing to chunk when
// they don't (verified against both cases -- see the chunking decision
// logic in lib/narrative.ts and lib/shortform.ts for the actual thresholds).
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function segmentsToTranscript(segments: TranscriptSegment[]): Transcript {
  return {
    segments,
    fullText: segments.map((s) => s.text).join(' '),
    durationSec: segments.length > 0 ? segments[segments.length - 1].end : 0,
  };
}

/**
 * Splits a transcript into contiguous sub-transcripts, each small enough
 * (by estimated tokens of its rendered [start - end] text lines) to fit
 * comfortably under a target budget, without ever splitting a single
 * Whisper segment across two chunks -- a chunk boundary always falls
 * between segments, never inside one.
 */
export function splitTranscriptIntoChunks(transcript: Transcript, maxTokensPerChunk: number): Transcript[] {
  const maxChars = maxTokensPerChunk * 3;
  const chunks: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let currentChars = 0;

  for (const seg of transcript.segments) {
    // Matches transcriptToPromptText's per-line format closely enough for
    // a size estimate (exact HH:MM:SS formatting doesn't change the
    // character count materially).
    const lineLength = seg.text.length + 24;
    if (current.length > 0 && currentChars + lineLength > maxChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(seg);
    currentChars += lineLength;
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map(segmentsToTranscript);
}
