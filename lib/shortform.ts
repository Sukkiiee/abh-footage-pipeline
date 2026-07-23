import { config } from './config';
import { generateStructuredJSON, AnthropicSpendBlockedError } from './llm';
import { ABH_BRAND_VOICE_SYSTEM_PROMPT } from './brand-voice';
import { Transcript, TranscriptSegment, ShortFormClip } from './types';
import { transcriptToPromptText, formatTimestamp, parseTimestamp } from './whisper';
import { formatReferenceBlock } from './reference-material';
import { estimateTokens, splitTranscriptIntoChunks } from './chunking';
import { estimateCostUSD, getTodaySpendUSD, getThisMonthSpendUSD } from './anthropic-usage';
import { ApprovalResult } from './job-control';

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
            titleOptions: {
              type: 'array',
              items: { type: 'string' },
              description:
                '2-4 short, punchy title options for this clip (a few words each), strongest first, distinct from the hook text -- used for file naming and the editor timeline, e.g. "The $4,000 First Order".',
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
            counterCheck: {
              type: 'string',
              description:
                'Play devil\'s advocate against your own pick before finalizing it: state the strongest reason a producer might reject this clip (weak hook, needs context, payoff is soft, idea is actually two ideas), then explain concretely why it holds up anyway. If you cannot give a real, specific answer, do not include this clip at all.',
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
          required: ['titleOptions', 'startTimestamp', 'endTimestamp', 'hook', 'singleIdea', 'payoff', 'rationale', 'counterCheck'],
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
  /** The long-form piece's chosen title (or a producer title hint), if any -- passed as context so per-clip titles read as part of the same series without repeating it outright. */
  videoTitle?: string;
  /** Other transcripts/scripts uploaded as guides for what a strong short-form soundbite looks like. Never treated as facts about this footage. */
  referenceMaterial?: string;
  /** Aborts the in-flight LLM request immediately if the pipeline is stopped mid-call. */
  signal?: AbortSignal;
  /** Called once, only if this transcript is long enough to need splitting into multiple requests -- lets the caller surface a plain-language heads-up to the user before it happens. */
  onNotice?: (message: string) => void;
  /** Per-run provider choice from the UI; overrides config.llmProvider when set. */
  llmProviderMode?: 'groq' | 'anthropic' | 'auto';
  /** See lib/narrative.ts's identical option -- only used in 'auto' mode, asks the user to approve the estimated Anthropic cost (or provide the admin override code if a spend cap is already exhausted) before ever spending anything; declining or a still-blocked attempt falls back to Groq's free chunked path. */
  requestApproval?: (estimatedCostUSD: number, capBlockedReason?: string) => Promise<ApprovalResult>;
  /** Who to attribute any Anthropic spend to in the spend log -- an email, a machine identifier, or omitted. */
  spendIdentifier?: string;
}

/** Null if neither cap is currently exhausted; otherwise a human-readable reason, for the approval prompt / any error message. Identical to lib/narrative.ts's helper of the same name -- kept local rather than shared since both files' constants (cap thresholds) are independent per-call-type tuning, not because the underlying check differs. */
function capBlockedReason(): string | undefined {
  if (!config.anthropicEnabledForOthers) {
    return 'Anthropic is currently turned off for everyone except the dev.';
  }
  const spentToday = getTodaySpendUSD();
  if (spentToday >= config.anthropicDailySpendCapUSD) {
    return `Daily Anthropic spend cap of $${config.anthropicDailySpendCapUSD.toFixed(2)} reached (used $${spentToday.toFixed(2)} today).`;
  }
  const spentThisMonth = getThisMonthSpendUSD();
  if (spentThisMonth >= config.anthropicMonthlySpendCapUSD) {
    return `Monthly Anthropic spend cap of $${config.anthropicMonthlySpendCapUSD.toFixed(2)} reached (used $${spentThisMonth.toFixed(2)} this month).`;
  }
  return undefined;
}

// See lib/narrative.ts for the full rationale -- same Groq free-tier
// tokens-per-minute ceiling, same chunk-and-merge fix. Short-form flagging
// doesn't need a separate "finalize" pass the way narrative does (there's
// no single title/logline to synthesize from the pieces): each chunk's
// clips already stand on their own, so merging is just concatenation plus
// the same overlap/dedupe pass already run over a single response.
// See lib/narrative.ts's identical constants for the full rationale (a real
// production failure showed the earlier estimate/budget were miscalibrated
// for this app's timestamp-heavy transcripts and didn't account for the
// tool-call JSON schema's own token overhead). SINGLE_PASS_COMPLETION_TOKENS
// is a bit higher here than narrative's equivalent -- each flagged clip's
// schema (title options, hook, idea, payoff, rationale, counter-check,
// caption, platform fit) is richer per-item than a narrative section, and a
// video can reasonably flag several clips in one response.
const GROQ_SAFE_TOTAL_TOKEN_BUDGET = 10500;
const TOOL_SCHEMA_TOKEN_OVERHEAD = 800;
const SINGLE_PASS_COMPLETION_TOKENS = 5000;
const CHUNK_COMPLETION_TOKENS = 4000;
const CHUNK_PROMPT_TOKEN_BUDGET = GROQ_SAFE_TOTAL_TOKEN_BUDGET - CHUNK_COMPLETION_TOKENS;

function buildPrompt(
  transcript: Transcript,
  sourceFileName: string,
  options: ShortFormOptions,
  chunkInfo?: { index: number; total: number }
): string {
  const transcriptText = transcriptToPromptText(transcript);
  const totalDuration = formatTimestamp(transcript.durationSec);

  const briefBlock = options.brief?.trim()
    ? `\nProducer brief for this piece:\n${options.brief.trim()}\n\nLet this brief inform which moments are worth flagging (e.g. what the piece is really about, who the audience is), but every clip you flag must still stand on its own per the requirements below.\n`
    : '';

  const titleBlock = options.videoTitle?.trim()
    ? `\nThis footage's video title is "${options.videoTitle.trim()}". Keep each clip's title consistent in tone with it, but each clip title should still describe that specific clip, not repeat the video title.\n`
    : '';

  const referenceBlock = formatReferenceBlock(options.referenceMaterial);

  const chunkNote = chunkInfo
    ? `\nThis is part ${chunkInfo.index + 1} of ${chunkInfo.total} of one longer transcript (split only because of a request-size limit, not a real break in the footage). Only flag clips fully contained within this part.\n`
    : '';

  return `Source footage: "${sourceFileName}"
Total duration: ${totalDuration}
${briefBlock}${titleBlock}${referenceBlock}${chunkNote}
Below is the ${chunkInfo ? `part ${chunkInfo.index + 1}/${chunkInfo.total} of the` : 'full'} timestamped transcript of the raw footage.

---TRANSCRIPT START---
${transcriptText}
---TRANSCRIPT END---

Flag only moments in this footage that would genuinely work as a standalone short-form social clip. Be a harsh editor, not a generous one: most transcripts have zero to a handful of real candidates, not one every minute. Requirements for every clip you flag, all of them, no exceptions:
- Between 15 and 60 seconds long.
- A hook in the first 2 seconds: something is said or happens immediately that would stop a scroll. Reject anything that opens with scene-setting, an introduction, a throat-clear ("So basically what happened was..."), or a sentence that only makes sense once you already know the topic. If you have to explain the hook for it to land, it is not a hook.
- Built around a single idea. If a range covers two different points, either pick the stronger one or split it into two separate clip entries. Do not stitch two half-ideas together to hit the length requirement.
- A clear payoff by the end: a punchline, a turn, a concrete number, a resolution. Reject anything that trails off, ends mid-thought, or ends on setup for a point that was never actually delivered.
- Fully self-contained: a viewer with zero context on the rest of the footage understands and feels the whole thing, immediately, with nothing explained to them separately (no caption doing the work the clip should be doing).
- Before finalizing each clip, argue against it in the counterCheck field. If the honest answer is "this is actually kind of weak," leave it out. It is always better to return three strong clips than eight mediocre ones.

Use exact timestamps from the transcript above for startTimestamp and endTimestamp. Do not flag overlapping clips. Return as many strong candidates as the footage actually supports, which may be very few or none; do not force weak ones in just to hit a number. For each clip, propose several distinct title options rather than settling on one. Use the submit_short_form_clips tool to return your result.`;
}

/** Runs one LLM call (for the whole transcript, or one chunk of it) and parses/validates its raw clip candidates against that same transcript's segments -- but doesn't do the final cross-chunk overlap/sort pass, since that has to happen once over everything combined. */
async function extractRawClips(
  transcript: Transcript,
  sourceFileName: string,
  options: ShortFormOptions,
  maxTokens: number,
  provider: 'groq' | 'anthropic',
  chunkInfo?: { index: number; total: number },
  adminOverrideCode?: string
): Promise<{ clips: ShortFormClip[]; rejected: number }> {
  const userPrompt = buildPrompt(transcript, sourceFileName, options, chunkInfo);

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
      maxTokens,
      signal: options.signal,
      provider,
      adminOverrideCode,
      spendIdentifier: options.spendIdentifier,
      spendContext: sourceFileName,
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
    const rawTitleOptions = Array.isArray(c.titleOptions)
      ? (c.titleOptions as unknown[]).map((t) => String(t)).filter((t) => t.trim().length > 0)
      : [];
    // Groq's free-tier model occasionally drops a field despite it being
    // required; fall back to a trimmed hook rather than rejecting an
    // otherwise-good clip over missing titles.
    const titleOptions =
      rawTitleOptions.length > 0 ? rawTitleOptions : [hook.slice(0, 60) || 'Untitled clip'];

    clips.push({
      title: titleOptions[0],
      titleOptions,
      startSec: clampedStart,
      endSec: finalEnd,
      startTimestamp: formatTimestamp(clampedStart),
      endTimestamp: formatTimestamp(finalEnd),
      hook,
      singleIdea: String(c.singleIdea || ''),
      payoff: String(c.payoff || ''),
      rationale: String(c.rationale || ''),
      counterCheck: c.counterCheck ? String(c.counterCheck) : undefined,
      suggestedCaption: c.suggestedCaption ? String(c.suggestedCaption) : undefined,
      platformFit: Array.isArray(c.platformFit) ? (c.platformFit as string[]) : undefined,
    });
  }

  return { clips, rejected };
}

async function chunkedExtractShortFormClips(
  transcript: Transcript,
  sourceFileName: string,
  options: ShortFormOptions
): Promise<{ clips: ShortFormClip[]; rejected: number }> {
  options.onNotice?.(
    "This video's transcript is long enough that flagging short-form clips in one request would go over Groq's free-tier limit. It's being split into smaller parts and the results combined afterward -- this takes a bit longer. To avoid this, use shorter footage, or switch LLM_PROVIDER to anthropic in your environment."
  );

  const allClips: ShortFormClip[] = [];
  let totalRejected = 0;
  const chunks = splitTranscriptIntoChunks(transcript, CHUNK_PROMPT_TOKEN_BUDGET);
  for (let i = 0; i < chunks.length; i++) {
    const { clips, rejected } = await extractRawClips(
      chunks[i],
      sourceFileName,
      options,
      CHUNK_COMPLETION_TOKENS,
      'groq',
      { index: i, total: chunks.length }
    );
    allClips.push(...clips);
    totalRejected += rejected;
    options.onNotice?.(`Short-form scan part ${i + 1} of ${chunks.length} done.`);
  }
  return { clips: allClips, rejected: totalRejected };
}

async function resolveClips(
  transcript: Transcript,
  sourceFileName: string,
  options: ShortFormOptions,
  mode: 'groq' | 'anthropic' | 'auto'
): Promise<{ clips: ShortFormClip[]; rejected: number }> {
  if (mode === 'anthropic') {
    return extractRawClips(transcript, sourceFileName, options, SINGLE_PASS_COMPLETION_TOKENS, 'anthropic');
  }

  const estimatedPromptTokens =
    estimateTokens(buildPrompt(transcript, sourceFileName, options) + ABH_BRAND_VOICE_SYSTEM_PROMPT) +
    TOOL_SCHEMA_TOKEN_OVERHEAD;
  const fitsGroq = estimatedPromptTokens + SINGLE_PASS_COMPLETION_TOKENS <= GROQ_SAFE_TOTAL_TOKEN_BUDGET;

  if (fitsGroq) {
    return extractRawClips(transcript, sourceFileName, options, SINGLE_PASS_COMPLETION_TOKENS, 'groq');
  }

  if (mode === 'groq') {
    return chunkedExtractShortFormClips(transcript, sourceFileName, options);
  }

  // mode === 'auto', doesn't fit Groq: offer Anthropic with a real
  // cost-approval step (or, if a spend cap is already exhausted, ask for
  // the admin override code instead), falling back to Groq's free chunked
  // path if it's not configured, the user declines, or the attempt is
  // still blocked even with whatever code was provided.
  if (config.hasAnthropicKey && options.requestApproval) {
    const estimatedCostUSD = estimateCostUSD(
      config.anthropicShortFormModel,
      estimatedPromptTokens,
      SINGLE_PASS_COMPLETION_TOKENS
    );
    const { decision, adminCode } = await options.requestApproval(estimatedCostUSD, capBlockedReason());
    if (decision === 'approve') {
      try {
        return await extractRawClips(
          transcript,
          sourceFileName,
          options,
          SINGLE_PASS_COMPLETION_TOKENS,
          'anthropic',
          undefined,
          adminCode
        );
      } catch (err) {
        if (err instanceof AnthropicSpendBlockedError) {
          options.onNotice?.(`${err.message} Continuing on Groq's free tier instead.`);
        } else {
          throw err;
        }
      }
    }
  }

  return chunkedExtractShortFormClips(transcript, sourceFileName, options);
}

export async function extractShortFormClips(
  transcript: Transcript,
  sourceFileName: string,
  options: ShortFormOptions = {}
): Promise<{ clips: ShortFormClip[]; rejected: number }> {
  const mode = options.llmProviderMode ?? config.llmProvider;
  const { clips: resolvedClips, rejected: resolvedRejected } = await resolveClips(
    transcript,
    sourceFileName,
    options,
    mode
  );
  const allClips = resolvedClips;
  let totalRejected = resolvedRejected;

  // Sort chronologically and drop any that overlap a previously accepted
  // clip -- run once over everything, whether it came from one call or
  // several chunked ones, since two different chunks' clips could still
  // overlap right at a chunk boundary.
  allClips.sort((a, b) => a.startSec - b.startSec);
  const nonOverlapping: ShortFormClip[] = [];
  let lastEnd = -Infinity;
  for (const clip of allClips) {
    if (clip.startSec >= lastEnd) {
      nonOverlapping.push(clip);
      lastEnd = clip.endSec;
    } else {
      totalRejected++;
    }
  }

  return { clips: nonOverlapping, rejected: totalRejected };
}
