import { config } from './config';
import { generateStructuredJSON, AnthropicSpendBlockedError } from './llm';
import { ABH_BRAND_VOICE_SYSTEM_PROMPT } from './brand-voice';
import { Transcript, NarrativeResult, NarrativeSection } from './types';
import { transcriptToPromptText, formatTimestamp } from './whisper';
import { formatReferenceBlock } from './reference-material';
import { estimateTokens, splitTranscriptIntoChunks } from './chunking';
import { estimateCostUSD, getTodaySpendUSD, getThisMonthSpendUSD } from './anthropic-usage';
import { ApprovalResult } from './job-control';

const NARRATIVE_TOOL_NAME = 'submit_narrative';

const NARRATIVE_TOOL = {
  name: NARRATIVE_TOOL_NAME,
  description:
    'Submit the structured long-form video narrative built from the timestamped transcript.',
  schema: {
    type: 'object' as const,
    properties: {
      titleOptions: {
        type: 'array',
        items: { type: 'string' },
        description:
          '3-5 distinct, specific, concrete title options for this footage, strongest first. Not generic. Vary the angle between options (e.g. one founder-quote-driven, one stakes-driven, one number/outcome-driven), not just wording of the same idea.',
      },
      logline: {
        type: 'string',
        description: 'One sentence summarizing the story, in ABH voice, no em dashes.',
      },
      themes: {
        type: 'array',
        items: { type: 'string' },
        description: '2-5 short theme labels present in this footage.',
      },
      sections: {
        type: 'array',
        description:
          'The narrative broken into produceable sections/beats, in chronological story order (not necessarily transcript order).',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string', description: 'Short section heading for the editor.' },
            narrative: {
              type: 'string',
              description:
                'The narrative prose for this section/beat, in full ABH brand voice. Several sentences to a short paragraph.',
            },
            citations: {
              type: 'array',
              description:
                'Timestamp ranges from the transcript that support this section, in HH:MM:SS format, taken directly from the transcript provided.',
              items: {
                type: 'object',
                properties: {
                  timestamp: { type: 'string', description: 'e.g. 00:04:12 - 00:04:38' },
                  quote: { type: 'string', description: 'Optional short supporting quote.' },
                },
                required: ['timestamp'],
              },
            },
          },
          required: ['heading', 'narrative', 'citations'],
        },
      },
      closingLine: {
        type: 'string',
        description: 'Optional single closing line for the piece, in ABH voice.',
      },
    },
    required: ['titleOptions', 'logline', 'sections'],
  },
};

// Used only for the interim, per-chunk calls a long transcript gets split
// into (see chunkedGenerateNarrative below) -- these only need to produce
// sections for their slice of the transcript, not a title/logline for the
// whole video, so the schema (and therefore the prompt+response token
// footprint) stays deliberately small.
const NARRATIVE_SECTIONS_TOOL_NAME = 'submit_narrative_sections';
const NARRATIVE_SECTIONS_TOOL = {
  name: NARRATIVE_SECTIONS_TOOL_NAME,
  description: 'Submit narrative sections/beats built from this slice of a longer transcript.',
  schema: {
    type: 'object' as const,
    properties: {
      sections: NARRATIVE_TOOL.schema.properties.sections,
    },
    required: ['sections'],
  },
};

// Used only for chunkedGenerateNarrative's finalize step, which builds
// title/logline/themes/closingLine from an already-built outline, not the
// sections themselves (those come from generateSectionsForChunk instead).
// A real, separate schema rather than reusing NARRATIVE_TOOL with a
// "sections can be left empty" instruction: the full tool's schema still
// marks 'sections' required, so a model that (correctly) followed that
// instruction and omitted the field entirely failed Groq's own schema
// validation with a 400 -- confirmed in production. Not including the
// field in this schema at all removes the contradiction outright.
const NARRATIVE_FINALIZE_TOOL_NAME = 'submit_narrative_finalize';
const NARRATIVE_FINALIZE_TOOL = {
  name: NARRATIVE_FINALIZE_TOOL_NAME,
  description: 'Submit the title options, logline, themes, and closing line for a narrative outline already built from a longer transcript.',
  schema: {
    type: 'object' as const,
    properties: {
      titleOptions: NARRATIVE_TOOL.schema.properties.titleOptions,
      logline: NARRATIVE_TOOL.schema.properties.logline,
      themes: NARRATIVE_TOOL.schema.properties.themes,
      closingLine: NARRATIVE_TOOL.schema.properties.closingLine,
    },
    required: ['titleOptions', 'logline'],
  },
};

export interface NarrativeOptions {
  /** Free-text producer/editorial brief -- context, angle, or instructions for this specific piece. */
  brief?: string;
  /** Target runtime of the final edited video, in minutes. Guides pacing/section count, not enforced exactly. */
  targetLengthMinutes?: number;
  /** Optional creative direction for the title options (keywords, angle, names to include). Guides the suggestions; does not fix a single title. */
  titleHint?: string;
  /** Other transcripts/scripts uploaded as style/soundbite guides. Never treated as facts about this footage. */
  referenceMaterial?: string;
  /** Aborts the in-flight LLM request immediately if the pipeline is stopped mid-call. */
  signal?: AbortSignal;
  /** Called once, only if this transcript is long enough to need splitting into multiple requests -- lets the caller surface a plain-language heads-up to the user before it happens. */
  onNotice?: (message: string) => void;
  /** Per-run provider choice from the UI; overrides config.llmProvider when set. */
  llmProviderMode?: 'groq' | 'anthropic' | 'auto';
  /**
   * Only used in 'auto' mode, only when the transcript is too large for
   * Groq's free-tier limits and Anthropic is configured: asks the user to
   * approve the estimated cost before spending anything (or, if a spend
   * cap is already exhausted, to provide the admin override code). If
   * omitted, denied, or blocked with no valid override, falls back to
   * Groq's free chunked path instead of ever calling Anthropic silently.
   */
  requestApproval?: (estimatedCostUSD: number, capBlockedReason?: string) => Promise<ApprovalResult>;
  /** Who to attribute any Anthropic spend to in the spend log -- an email, a machine identifier, or omitted. */
  spendIdentifier?: string;
  /** Short label (e.g. the source filename) recorded alongside any Anthropic spend log entry, purely for readability. */
  spendContext?: string;
}

/** Null if neither cap is currently exhausted; otherwise a human-readable reason, for the approval prompt / any error message. */
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

// Groq's free tier hard-caps at 12,000 tokens/minute (prompt + completion,
// combined) for the models this app uses -- confirmed in production. A
// single request for a long video's full transcript can exceed that on its
// own, in which case no amount of retrying with a smaller completion
// budget helps (the prompt alone is already over the ceiling). Rather than
// just failing, split the transcript into pieces that each safely fit,
// generate sections for each piece, then do one small finalize call (using
// only the resulting outline, not the raw transcript again) for the
// title/logline/themes. Anthropic's actual limits are far higher than
// this app's transcripts realistically hit, so this only kicks in for Groq.
// A real production failure showed the token estimate (see lib/chunking.ts)
// was too generous for this app's timestamp-heavy transcript format, and
// that estimate also didn't account for the tool-call JSON schema itself,
// which is real prompt-token overhead on every request. Recalibrated
// budget/overhead below, paired with a lower default completion budget
// (SINGLE_PASS_COMPLETION_TOKENS -- a typical narrative response is a few
// thousand tokens at most, 8000 was needlessly generous and was itself
// eating into the safety margin on every request).
const GROQ_SAFE_TOTAL_TOKEN_BUDGET = 10500;
const TOOL_SCHEMA_TOKEN_OVERHEAD = 800;
const SINGLE_PASS_COMPLETION_TOKENS = 4000;
const CHUNK_COMPLETION_TOKENS = 3000;
const CHUNK_PROMPT_TOKEN_BUDGET = GROQ_SAFE_TOTAL_TOKEN_BUDGET - CHUNK_COMPLETION_TOKENS;

function buildContextBlocks(options: NarrativeOptions) {
  const briefBlock = options.brief?.trim()
    ? `\nProducer brief for this piece:\n${options.brief.trim()}\n\nFollow this brief for angle, emphasis, and framing wherever it doesn't conflict with what's actually present in the transcript. Do not invent content the brief implies but the transcript doesn't support.\n`
    : '';

  const targetLengthBlock = options.targetLengthMinutes && options.targetLengthMinutes > 0
    ? `\nTarget runtime for the final edited video: approximately ${options.targetLengthMinutes} minute${options.targetLengthMinutes === 1 ? '' : 's'}. Size and pace the sections/beats so the narrative naturally fits that runtime once cut together: fewer, more tightly-focused sections for a short target, more sections and room to breathe for a longer one. Do not pad to fill time or force a longer piece down to hit a short one at the cost of clarity.\n`
    : '';

  const titleHintBlock = options.titleHint?.trim()
    ? `\nProducer's title direction (keywords/angle to lean into, not a fixed title): "${options.titleHint.trim()}". Let this steer the title options, but still propose several distinct options rather than one.\n`
    : '';

  const referenceBlock = formatReferenceBlock(options.referenceMaterial);

  return { briefBlock, targetLengthBlock, titleHintBlock, referenceBlock };
}

async function generateNarrativeSinglePass(
  transcript: Transcript,
  sourceFileName: string,
  options: NarrativeOptions,
  provider: 'groq' | 'anthropic',
  adminOverrideCode?: string
): Promise<NarrativeResult> {
  const transcriptText = transcriptToPromptText(transcript);
  const totalDuration = formatTimestamp(transcript.durationSec);
  const { briefBlock, targetLengthBlock, titleHintBlock, referenceBlock } = buildContextBlocks(options);

  const userPrompt = `Source footage: "${sourceFileName}"
Total duration: ${totalDuration}
${briefBlock}${targetLengthBlock}${titleHintBlock}${referenceBlock}
Below is the full timestamped transcript of the raw footage. Each line is [start - end] followed by what was said.

---TRANSCRIPT START---
${transcriptText}
---TRANSCRIPT END---

Build a structured long-form narrative for this footage for the ABH editorial and video team. Organize it into a small number of clear narrative sections/beats (typically 3-8) that a video editor could cut to directly, in the best story order. Every section must cite the specific transcript timestamp range(s) it draws from. Do not invent content that is not in the transcript. Propose several distinct title options rather than settling on one. Use the submit_narrative tool to return your result.`;

  const raw = (await generateStructuredJSON(
    ABH_BRAND_VOICE_SYSTEM_PROMPT,
    userPrompt,
    {
      name: NARRATIVE_TOOL.name,
      description: NARRATIVE_TOOL.description,
      schema: NARRATIVE_TOOL.schema,
    },
    {
      anthropicModel: config.anthropicNarrativeModel,
      groqModel: config.groqNarrativeModel,
      maxTokens: SINGLE_PASS_COMPLETION_TOKENS,
      signal: options.signal,
      provider,
      adminOverrideCode,
      spendIdentifier: options.spendIdentifier,
      spendContext: sourceFileName,
    }
  )) as Omit<NarrativeResult, 'title' | 'titleOptions'> & { titleOptions?: unknown };

  const titleOptions = Array.isArray(raw.titleOptions)
    ? raw.titleOptions.map((t) => String(t)).filter((t) => t.trim().length > 0)
    : [];

  // Safety net for a weaker model that returns an empty/malformed array
  // despite the schema requiring one.
  if (titleOptions.length === 0) {
    titleOptions.push(`${sourceFileName.replace(/\.[^/.]+$/, '')} - ABH Story`);
  }

  return {
    ...raw,
    titleOptions,
    title: titleOptions[0],
  };
}

async function generateSectionsForChunk(
  chunk: Transcript,
  sourceFileName: string,
  options: NarrativeOptions,
  chunkIndex: number,
  totalChunks: number
): Promise<NarrativeSection[]> {
  const transcriptText = transcriptToPromptText(chunk);
  const { briefBlock, targetLengthBlock, titleHintBlock, referenceBlock } = buildContextBlocks(options);

  const userPrompt = `Source footage: "${sourceFileName}"
This is part ${chunkIndex + 1} of ${totalChunks} of one longer transcript (split only because of a request-size limit, not a real break in the footage).
${briefBlock}${targetLengthBlock}${titleHintBlock}${referenceBlock}
Below is this part's slice of the timestamped transcript. Each line is [start - end] followed by what was said.

---TRANSCRIPT PART ${chunkIndex + 1}/${totalChunks} START---
${transcriptText}
---TRANSCRIPT PART ${chunkIndex + 1}/${totalChunks} END---

Build narrative sections/beats covering ONLY this part of the footage, in the ABH brand voice, in chronological order. Do not summarize the whole video or guess at what's in other parts. Every section must cite the specific transcript timestamp range(s) it draws from, taken directly from this part. Do not invent content not present in this part. Do not propose a title -- a separate pass handles that once every part is combined. Use the submit_narrative_sections tool to return your result.`;

  const raw = (await generateStructuredJSON(
    ABH_BRAND_VOICE_SYSTEM_PROMPT,
    userPrompt,
    {
      name: NARRATIVE_SECTIONS_TOOL.name,
      description: NARRATIVE_SECTIONS_TOOL.description,
      schema: NARRATIVE_SECTIONS_TOOL.schema,
    },
    {
      anthropicModel: config.anthropicNarrativeModel,
      groqModel: config.groqNarrativeModel,
      maxTokens: CHUNK_COMPLETION_TOKENS,
      signal: options.signal,
      // Chunking exists specifically to work around Groq's tight free-tier
      // limits -- Anthropic's real limits are far above anything this
      // app's transcripts hit, so it never needs this path.
      provider: 'groq',
    }
  )) as { sections?: NarrativeSection[] };

  return Array.isArray(raw.sections) ? raw.sections : [];
}

/** Finalizes title/logline/themes/closing line from an already-built outline (section headings + narrative text), not the raw transcript -- kept intentionally small regardless of how long the source video was. */
async function finalizeFromOutline(
  sections: NarrativeSection[],
  sourceFileName: string,
  options: NarrativeOptions
): Promise<Omit<NarrativeResult, 'sections'>> {
  const { titleHintBlock } = buildContextBlocks(options);
  const outline = sections
    .map((s, i) => `${i + 1}. ${s.heading}\n${s.narrative}`)
    .join('\n\n');

  const userPrompt = `Source footage: "${sourceFileName}"
${titleHintBlock}
Below is the narrative outline already built for this footage (section headings and prose), assembled from a longer transcript that was processed in parts.

---OUTLINE START---
${outline}
---OUTLINE END---

Based on this outline, propose title options, a one-sentence logline, 2-5 theme labels, and an optional closing line, all in the ABH brand voice. Use the submit_narrative_finalize tool to return your result.`;

  const raw = (await generateStructuredJSON(
    ABH_BRAND_VOICE_SYSTEM_PROMPT,
    userPrompt,
    {
      name: NARRATIVE_FINALIZE_TOOL.name,
      description: NARRATIVE_FINALIZE_TOOL.description,
      schema: NARRATIVE_FINALIZE_TOOL.schema,
    },
    {
      anthropicModel: config.anthropicNarrativeModel,
      groqModel: config.groqNarrativeModel,
      maxTokens: 1500,
      signal: options.signal,
      provider: 'groq',
    }
  )) as Omit<NarrativeResult, 'title' | 'titleOptions' | 'sections'> & { titleOptions?: unknown };

  const titleOptions = Array.isArray(raw.titleOptions)
    ? raw.titleOptions.map((t) => String(t)).filter((t) => t.trim().length > 0)
    : [];
  if (titleOptions.length === 0) {
    titleOptions.push(`${sourceFileName.replace(/\.[^/.]+$/, '')} - ABH Story`);
  }

  return { ...raw, titleOptions, title: titleOptions[0] };
}

async function chunkedGenerateNarrative(
  transcript: Transcript,
  sourceFileName: string,
  options: NarrativeOptions
): Promise<NarrativeResult> {
  options.onNotice?.(
    "This video's transcript is long enough that building the narrative in one request would go over Groq's free-tier limit. It's being split into smaller parts and combined afterward. This takes a bit longer, and the result may read as slightly more segmented than a single-pass narrative. To avoid this, use shorter footage, or switch LLM_PROVIDER to anthropic in your environment."
  );

  const chunks = splitTranscriptIntoChunks(transcript, CHUNK_PROMPT_TOKEN_BUDGET);
  const allSections: NarrativeSection[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const sections = await generateSectionsForChunk(chunks[i], sourceFileName, options, i, chunks.length);
    allSections.push(...sections);
    options.onNotice?.(`Narrative part ${i + 1} of ${chunks.length} done.`);
  }

  options.onNotice?.('Combining all parts into one narrative...');
  const finalized = await finalizeFromOutline(allSections, sourceFileName, options);
  return { ...finalized, sections: allSections };
}

export async function generateNarrative(
  transcript: Transcript,
  sourceFileName: string,
  options: NarrativeOptions = {}
): Promise<NarrativeResult> {
  const mode = options.llmProviderMode ?? config.llmProvider;

  // Explicit "Anthropic only": no size check needed at all -- its real
  // limits are far above anything this app's transcripts hit.
  if (mode === 'anthropic') {
    return generateNarrativeSinglePass(transcript, sourceFileName, options, 'anthropic');
  }

  // Groq's rate limit is tight enough for this app's transcripts to
  // realistically hit -- estimate this the same rough way the ceiling
  // itself is denominated (prompt + completion tokens together) before
  // ever making a request, rather than waiting to fail and retry.
  const transcriptText = transcriptToPromptText(transcript);
  const { briefBlock, targetLengthBlock, titleHintBlock, referenceBlock } = buildContextBlocks(options);
  const estimatedPromptTokens =
    estimateTokens(
      transcriptText + briefBlock + targetLengthBlock + titleHintBlock + referenceBlock + ABH_BRAND_VOICE_SYSTEM_PROMPT
    ) + TOOL_SCHEMA_TOKEN_OVERHEAD;
  const fitsGroq = estimatedPromptTokens + SINGLE_PASS_COMPLETION_TOKENS <= GROQ_SAFE_TOTAL_TOKEN_BUDGET;

  if (fitsGroq) {
    return generateNarrativeSinglePass(transcript, sourceFileName, options, 'groq');
  }

  // Doesn't fit Groq's free-tier limit in one request. Explicit "Groq
  // only" means chunk-and-merge on Groq no matter what, same as always.
  if (mode === 'groq') {
    return chunkedGenerateNarrative(transcript, sourceFileName, options);
  }

  // mode === 'auto': offer Anthropic instead of chunking, but only ever
  // with the user's actual approval of the real estimated cost -- never
  // spend anything silently. If a spend cap (or the enabledForOthers
  // toggle) is already blocking Anthropic, the approval prompt reflects
  // that and asks for the admin override code instead of a plain yes/no.
  // Falls back to Groq's free chunked path if Anthropic isn't configured,
  // the user declines, or the attempt is still blocked even with whatever
  // code was provided (wrong code, or blocked for another reason).
  if (config.hasAnthropicKey && options.requestApproval) {
    const estimatedCostUSD = estimateCostUSD(
      config.anthropicNarrativeModel,
      estimatedPromptTokens,
      SINGLE_PASS_COMPLETION_TOKENS
    );
    const { decision, adminCode } = await options.requestApproval(estimatedCostUSD, capBlockedReason());
    if (decision === 'approve') {
      try {
        return await generateNarrativeSinglePass(transcript, sourceFileName, options, 'anthropic', adminCode);
      } catch (err) {
        if (err instanceof AnthropicSpendBlockedError) {
          options.onNotice?.(`${err.message} Continuing on Groq's free tier instead.`);
        } else {
          throw err;
        }
      }
    }
  }

  return chunkedGenerateNarrative(transcript, sourceFileName, options);
}
