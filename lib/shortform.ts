import { config } from './config';
import { generateStructuredJSON } from './llm';
import { ABH_BRAND_VOICE_SYSTEM_PROMPT } from './brand-voice';
import { Transcript, TranscriptSegment, ShortFormClip } from './types';
import { transcriptToPromptText, formatTimestamp, parseTimestamp } from './whisper';

const SHORTFORM_TOOL_NAME = 'submit_short_form_clips';

const MIN_CLIP_SECONDS = 15;
const MAX_CLIP_SECONDS = 60;
// Small tolerance so a 61s or 14s suggestion from the model isn't thrown away
// outright; it gets clamped instead of dropped.
const TOLERANCE_SECONDS = 5;

const SHORTFORM_TOOL = {
  name: SHORTFORM_TOOL_NAME,
  description:
    'Submit the flagged self-contained short-form moments found in the transcript, suited for standalone social media clips.',
  schema: {
    type: 'object' as const,
    properties: {
      clips: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description:
                'A short, punchy label for this clip (a few words), distinct from the hook text -- used for file naming and the editor timeline, e.g. "The $4,000 First Order".',
            },
            startTimestamp: {
              type: 'string',
              description: 'HH:MM:SS, must exactly match a point in the given transcript.',
            },
            endTimestamp: {
              type: 'string',
              description: 'HH:MM:SS, must exactly match a point in the given transcript.',
            },
            hook: {
              type: 'string',
              description:
                'What happens in the first 2 seconds of the clip that earns attention. Be literal about what is said/shown, not what it "represents".',
            },
            singleIdea: {
              type: 'string',
              description: 'The one idea this clip is about. A clip about more than one idea should not be flagged.',
            },
            payoff: {
              type: 'string',
              description: 'The specific payoff/turn/punchline the clip lands on before it ends.',
            },
            rationale: {
              type: 'string',
              description:
                'Why this range is self-contained and works as a standalone clip: why here, why this long, why it needs no extra context.',
            },
            suggestedCaption: {
              type: 'string',
              description: 'A short suggested social caption, in ABH voice, no em dashes.',
            },
            platformFit: {
              type: 'array',
              items: { type: 'string' },
              description: 'e.g. ["Instagram Reels", "TikTok", "LinkedIn", "YouTube Shorts"]',
            },
          },
          required: ['title', 'startTimestamp', 'endTimestamp', 'hook', 'singleIdea', 'payoff', 'rationale'],
        },
      },
    },
    required: ['clips'],
  },
};

/** Snaps a rough start/end (seconds) to the nearest actual segment boundary so cuts land on clean speech edges rather than mid-word. */
function snapToSegmentBoundaries(
  startSec: number,
  endSec: number,
  segments: TranscriptSegment[]
): { start: number; end: number } {
  if (segments.length === 0) return { start: startSec, end: endSec };

  let snappedStart = segments[0].start;
  for (const seg of segments) {
    if (seg.start <= startSec) snappedStart = seg.start;
    else break;
  }

  let snappedEnd = segments[segments.length - 1].end;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].end >= endSec) snappedEnd = segments[i].end;
    else break;
  }

  if (snappedEnd <= snappedStart) {
    return { start: startSec, end: endSec };
  }
  return { start: snappedStart, end: snappedEnd };
}

export interface ShortFormOptions {
  /** Free-text producer/editorial brief -- context, angle, or instructions for this specific piece. */
  brief?: string;
  /** Overall video title, if the user set one -- passed as context so per-clip titles read as part of the same series. */
  videoTitle?: string;
}

export async function extractShortFormClips(
  transcript: Transcript,
  sourceFileName: string,
  options: ShortFormOptions = {}
): Promise<{ clips: ShortFormClip[]; rejected: number }> {
  const transcriptText = transcriptToPromptText(transcript);
  const totalDuration = formatTimestamp(transcript.durationSec);

  const briefBlock = options.brief?.trim()
    ? `\nProducer brief for this piece:\n${options.brief.trim()}\n\nLet this brief inform which moments are worth flagging (e.g. what the piece is really about, who the audience is), but every clip you flag must still stand on its own per the requirements below.\n`
    : '';

  const titleBlock = options.videoTitle?.trim()
    ? `\nThis footage's video title is "${options.videoTitle.trim()}". Keep each clip's title consistent in tone with it, but each clip title should still describe that specific clip, not repeat the video title.\n`
    : '';

  const userPrompt = `Source footage: "${sourceFileName}"
Total duration: ${totalDuration}
${briefBlock}${titleBlock}
Below is the full timestamped transcript of the raw footage.

---TRANSCRIPT START---
${transcriptText}
---TRANSCRIPT END---

Flag every self-contained moment in this footage that would work as a standalone short-form social clip. Requirements for every clip you flag:
- Between 15 and 60 seconds long.
- A hook in the first 2 seconds: something is said or happens immediately that would stop a scroll. Do not flag a clip that needs 5+ seconds of setup before it gets interesting.
- Built around a single idea. If a range covers two different points, either pick the stronger one or split it into two separate clip entries.
- A clear payoff by the end: a punchline, a turn, a concrete number, a resolution. Not a clip that trails off or ends mid-thought.
- Fully self-contained: a viewer with zero context on the rest of the footage understands and feels the whole thing.

Use exact timestamps from the transcript above for startTimestamp and endTimestamp. Do not flag overlapping clips. Return as many strong candidates as the footage actually supports; do not force weak ones in just to hit a number. Use the submit_short_form_clips tool to return your result.`;

  const result = await generateStructuredJSON(
    ABH_BRAND_VOICE_SYSTEM_PROMPT,
    userPrompt,
    {
      name: SHORTFORM_TOOL.name,
      description: SHORTFORM_TOOL.description,
      schema: SHORTFORM_TOOL.schema,
    },
    {
      anthropicModel: config.anthropicShortFormModel,
      groqModel: config.groqShortFormModel,
      maxTokens: 8000,
    }
  );

  const raw = (result as { clips: Array<Record<string, unknown>> }).clips || [];

  const clips: ShortFormClip[] = [];
  let rejected = 0;

  for (const c of raw) {
    const rawStart = parseTimestamp(String(c.startTimestamp));
    const rawEnd = parseTimestamp(String(c.endTimestamp));
    if (Number.isNaN(rawStart) || Number.isNaN(rawEnd) || rawEnd <= rawStart) {
      rejected++;
      continue;
    }

    const { start, end } = snapToSegmentBoundaries(rawStart, rawEnd, transcript.segments);
    const clampedStart = Math.max(0, Math.min(start, transcript.durationSec));
    const clampedEnd = Math.max(0, Math.min(end, transcript.durationSec));
    const length = clampedEnd - clampedStart;

    if (
      length < MIN_CLIP_SECONDS - TOLERANCE_SECONDS ||
      length > MAX_CLIP_SECONDS + TOLERANCE_SECONDS
    ) {
      rejected++;
      continue;
    }

    // Clamp (not drop) small overages so a 63s clip that's otherwise good isn't lost.
    const finalEnd =
      length > MAX_CLIP_SECONDS ? clampedStart + MAX_CLIP_SECONDS : clampedEnd;

    const hook = String(c.hook || '');
    // Groq's free-tier model occasionally drops an optional-feeling field
    // despite it being required; fall back to a trimmed hook rather than
    // rejecting an otherwise-good clip over a missing title.
    const title = c.title ? String(c.title) : hook.slice(0, 60) || 'Untitled clip';

    clips.push({
      title,
      startSec: clampedStart,
      endSec: finalEnd,
      startTimestamp: formatTimestamp(clampedStart),
      endTimestamp: formatTimestamp(finalEnd),
      hook,
      singleIdea: String(c.singleIdea || ''),
      payoff: String(c.payoff || ''),
      rationale: String(c.rationale || ''),
      suggestedCaption: c.suggestedCaption ? String(c.suggestedCaption) : undefined,
      platformFit: Array.isArray(c.platformFit) ? (c.platformFit as string[]) : undefined,
    });
  }

  // Sort chronologically and drop any that overlap a previously accepted clip.
  clips.sort((a, b) => a.startSec - b.startSec);
  const nonOverlapping: ShortFormClip[] = [];
  let lastEnd = -Infinity;
  for (const clip of clips) {
    if (clip.startSec >= lastEnd) {
      nonOverlapping.push(clip);
      lastEnd = clip.endSec;
    } else {
      rejected++;
    }
  }

  return { clips: nonOverlapping, rejected };
}
