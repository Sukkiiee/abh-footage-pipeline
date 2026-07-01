import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';
import { ABH_BRAND_VOICE_SYSTEM_PROMPT } from './brand-voice';
import { Transcript, NarrativeResult } from './types';
import { transcriptToPromptText, formatTimestamp } from './whisper';

const NARRATIVE_TOOL_NAME = 'submit_narrative';

const NARRATIVE_TOOL = {
  name: NARRATIVE_TOOL_NAME,
  description:
    'Submit the structured long-form video narrative built from the timestamped transcript.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: {
        type: 'string',
        description: 'A specific, concrete working title for this footage. Not generic.',
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
    required: ['title', 'logline', 'sections'],
  },
};

export async function generateNarrative(
  transcript: Transcript,
  sourceFileName: string
): Promise<NarrativeResult> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const transcriptText = transcriptToPromptText(transcript);
  const totalDuration = formatTimestamp(transcript.durationSec);

  const userPrompt = `Source footage: "${sourceFileName}"
Total duration: ${totalDuration}

Below is the full timestamped transcript of the raw footage. Each line is [start - end] followed by what was said.

---TRANSCRIPT START---
${transcriptText}
---TRANSCRIPT END---

Build a structured long-form narrative for this footage for the ABH editorial and video team. Organize it into a small number of clear narrative sections/beats (typically 3-8) that a video editor could cut to directly, in the best story order. Every section must cite the specific transcript timestamp range(s) it draws from. Do not invent content that is not in the transcript. Use the submit_narrative tool to return your result.`;

  const response = await client.messages.create({
    model: config.anthropicNarrativeModel,
    max_tokens: 8000,
    system: ABH_BRAND_VOICE_SYSTEM_PROMPT,
    tools: [NARRATIVE_TOOL],
    tool_choice: { type: 'tool', name: NARRATIVE_TOOL_NAME },
    messages: [{ role: 'user', content: userPrompt }],
  });

  const toolUse = response.content.find(
    (block) => block.type === 'tool_use'
  ) as { type: 'tool_use'; input: unknown } | undefined;

  if (!toolUse) {
    throw new Error('Claude did not return a structured narrative.');
  }

  return toolUse.input as NarrativeResult;
}
