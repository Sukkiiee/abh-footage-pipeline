import { config } from './config';
import { generateStructuredJSON } from './llm';
import { ABH_BRAND_VOICE_SYSTEM_PROMPT } from './brand-voice';
import { Transcript, NarrativeResult } from './types';
import { transcriptToPromptText, formatTimestamp } from './whisper';

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

export interface NarrativeOptions {
  /** Free-text producer/editorial brief -- context, angle, or instructions for this specific piece. */
  brief?: string;
  /** Target runtime of the final edited video, in minutes. Guides pacing/section count, not enforced exactly. */
  targetLengthMinutes?: number;
  /** Optional creative direction for the title options (keywords, angle, names to include). Guides the suggestions; does not fix a single title. */
  titleHint?: string;
}

export async function generateNarrative(
  transcript: Transcript,
  sourceFileName: string,
  options: NarrativeOptions = {}
): Promise<NarrativeResult> {
  const transcriptText = transcriptToPromptText(transcript);
  const totalDuration = formatTimestamp(transcript.durationSec);

  const briefBlock = options.brief?.trim()
    ? `\nProducer brief for this piece:\n${options.brief.trim()}\n\nFollow this brief for angle, emphasis, and framing wherever it doesn't conflict with what's actually present in the transcript. Do not invent content the brief implies but the transcript doesn't support.\n`
    : '';

  const targetLengthBlock = options.targetLengthMinutes && options.targetLengthMinutes > 0
    ? `\nTarget runtime for the final edited video: approximately ${options.targetLengthMinutes} minute${options.targetLengthMinutes === 1 ? '' : 's'}. Size and pace the sections/beats so the narrative naturally fits that runtime once cut together: fewer, more tightly-focused sections for a short target, more sections and room to breathe for a longer one. Do not pad to fill time or force a longer piece down to hit a short one at the cost of clarity.\n`
    : '';

  const titleHintBlock = options.titleHint?.trim()
    ? `\nProducer's title direction (keywords/angle to lean into, not a fixed title): "${options.titleHint.trim()}". Let this steer the title options, but still propose several distinct options rather than one.\n`
    : '';

  const userPrompt = `Source footage: "${sourceFileName}"
Total duration: ${totalDuration}
${briefBlock}${targetLengthBlock}${titleHintBlock}
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
      maxTokens: 8000,
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
