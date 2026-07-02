import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from './config';

// Provider-agnostic "force a structured JSON tool call" helper. narrative.ts
// and shortform.ts both call this instead of talking to Anthropic or Groq
// directly, so the rest of the pipeline (validation, FCPXML/DOCX building)
// never needs to know which LLM actually produced the JSON. Switching
// providers is a config change (config.llmProvider), not a code change.

export interface StructuredToolSpec {
  name: string;
  description: string;
  /** JSON schema for the tool's input. Top-level type must be "object". */
  schema: Record<string, unknown>;
}

export interface GenerateStructuredOptions {
  anthropicModel: string;
  groqModel: string;
  maxTokens?: number;
}

export async function generateStructuredJSON(
  systemPrompt: string,
  userPrompt: string,
  tool: StructuredToolSpec,
  opts: GenerateStructuredOptions
): Promise<unknown> {
  const maxTokens = opts.maxTokens ?? 8000;

  if (config.llmProvider === 'anthropic') {
    return generateViaAnthropic(systemPrompt, userPrompt, tool, opts.anthropicModel, maxTokens);
  }
  return generateViaGroq(systemPrompt, userPrompt, tool, opts.groqModel, maxTokens);
}

async function generateViaAnthropic(
  systemPrompt: string,
  userPrompt: string,
  tool: StructuredToolSpec,
  model: string,
  maxTokens: number
): Promise<unknown> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    tools: [
      {
        name: tool.name,
        description: tool.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input_schema: tool.schema as any,
      },
    ],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: userPrompt }],
  });

  const toolUse = response.content.find((block) => block.type === 'tool_use') as
    | { type: 'tool_use'; input: unknown }
    | undefined;

  if (!toolUse) {
    throw new Error('Claude did not return a structured tool call.');
  }

  return toolUse.input;
}

async function generateViaGroq(
  systemPrompt: string,
  userPrompt: string,
  tool: StructuredToolSpec,
  model: string,
  maxTokens: number
): Promise<unknown> {
  const client = new OpenAI({
    apiKey: config.groqApiKey,
    baseURL: 'https://api.groq.com/openai/v1',
  });

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: tool.name } },
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') {
    throw new Error('Groq did not return a structured tool call.');
  }

  try {
    return JSON.parse(toolCall.function.arguments);
  } catch {
    throw new Error(
      'Groq returned malformed JSON in its tool call. This can happen occasionally with open-source models under forced tool use; re-running the pipeline usually resolves it.'
    );
  }
}
