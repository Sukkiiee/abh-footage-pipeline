import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from './config';
import { getTodaySpendUSD, getThisMonthSpendUSD, recordSpendUSD, estimateCostUSD, logSpendEvent } from './anthropic-usage';

// Provider-agnostic "force a structured JSON tool call" helper. narrative.ts
// and shortform.ts both call this instead of talking to Anthropic or Groq
// directly, so the rest of the pipeline (validation, FCPXML/DOCX building)
// never needs to know which LLM actually produced the JSON.

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
  signal?: AbortSignal;
  /**
   * Which provider to actually use for this call. Callers resolve 'auto'
   * down to a concrete 'groq' or 'anthropic' before calling this function
   * (see lib/narrative.ts / lib/shortform.ts's resolveProvider) -- this
   * function only ever sees a real choice, never has to guess.
   */
  provider: 'groq' | 'anthropic';
  /** Only relevant for provider: 'anthropic'. Bypasses the spend cap / enabledForOthers gate if it matches config.anthropicAdminCode. */
  adminOverrideCode?: string;
  /** Only relevant for provider: 'anthropic'. Who to attribute this spend to in the log -- an email, a machine identifier, or 'unknown' if neither was available. */
  spendIdentifier?: string;
  /** Only relevant for provider: 'anthropic'. Short label (e.g. the source filename) recorded alongside the spend log entry, purely for readability. */
  spendContext?: string;
}

/** Thrown specifically when Anthropic use is blocked by a spend cap or the enabledForOthers toggle, with no valid admin override -- a distinct type so callers (see lib/narrative.ts / lib/shortform.ts's Auto mode) can catch exactly this and fall back to Groq gracefully, rather than failing the whole run over what's an expected, handleable condition. */
export class AnthropicSpendBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicSpendBlockedError';
  }
}

export async function generateStructuredJSON(
  systemPrompt: string,
  userPrompt: string,
  tool: StructuredToolSpec,
  opts: GenerateStructuredOptions
): Promise<unknown> {
  const maxTokens = opts.maxTokens ?? 8000;

  if (opts.provider === 'anthropic') {
    return generateViaAnthropic(
      systemPrompt,
      userPrompt,
      tool,
      opts.anthropicModel,
      maxTokens,
      opts.signal,
      opts.adminOverrideCode,
      opts.spendIdentifier,
      opts.spendContext
    );
  }
  return generateViaGroq(systemPrompt, userPrompt, tool, opts.groqModel, maxTokens, opts.signal);
}

async function generateViaAnthropic(
  systemPrompt: string,
  userPrompt: string,
  tool: StructuredToolSpec,
  model: string,
  maxTokens: number,
  signal?: AbortSignal,
  adminOverrideCode?: string,
  spendIdentifier?: string,
  spendContext?: string
): Promise<unknown> {
  // The actual real-money safety net: enforced right before every single
  // Anthropic call, regardless of how that call was reached (an explicit
  // per-run "Anthropic only" choice, or an approved Auto-mode switch) --
  // so a shared/hosted instance can't run up an unbounded bill even if
  // several people are testing it at once. Checked against spend already
  // recorded from completed calls, not a pre-estimate, so this can't
  // itself block a request based on a guess; it can only stop *further*
  // calls once real spend has actually reached a cap.
  //
  // A valid admin override code bypasses all of this -- "only the dev can
  // approve anything higher" is enforced entirely by that code being a
  // secret only the dev knows (config.anthropicAdminCode), not by any
  // notion of user accounts, which this app doesn't have.
  const isAdmin = !!config.anthropicAdminCode && adminOverrideCode === config.anthropicAdminCode;

  if (!isAdmin) {
    if (!config.anthropicEnabledForOthers) {
      throw new AnthropicSpendBlockedError(
        'Anthropic is currently turned off for everyone except the dev (ANTHROPIC_ENABLED_FOR_OTHERS=false). Ask the dev for the admin override code, or continue on Groq instead.'
      );
    }
    const spentToday = getTodaySpendUSD();
    if (spentToday >= config.anthropicDailySpendCapUSD) {
      throw new AnthropicSpendBlockedError(
        `Daily Anthropic spend cap of $${config.anthropicDailySpendCapUSD.toFixed(2)} reached (used $${spentToday.toFixed(2)} today). Ask the dev for the admin override code, wait until tomorrow, or continue on Groq instead.`
      );
    }
    const spentThisMonth = getThisMonthSpendUSD();
    if (spentThisMonth >= config.anthropicMonthlySpendCapUSD) {
      throw new AnthropicSpendBlockedError(
        `Monthly Anthropic spend cap of $${config.anthropicMonthlySpendCapUSD.toFixed(2)} reached (used $${spentThisMonth.toFixed(2)} this month). Ask the dev for the admin override code, wait until next month, or continue on Groq instead.`
      );
    }
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.create(
    {
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
    },
    { signal }
  );

  if (response.usage) {
    const cost = estimateCostUSD(model, response.usage.input_tokens, response.usage.output_tokens);
    recordSpendUSD(cost);
    logSpendEvent({
      identifier: spendIdentifier || 'unknown',
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUSD: cost,
      context: spendContext,
    });
  }

  const toolUse = response.content.find((block) => block.type === 'tool_use') as
    | { type: 'tool_use'; input: unknown }
    | undefined;

  if (!toolUse) {
    throw new Error('Claude did not return a structured tool call.');
  }

  return toolUse.input;
}

// Groq's free tier enforces a tokens-per-minute (TPM) ceiling per model
// (e.g. 12000 for llama-3.3-70b-versatile) that counts prompt tokens PLUS
// the requested `max_tokens` completion budget against that ceiling up
// front -- not just tokens actually generated. A long transcript (plus any
// reference material/brief) can easily push prompt tokens high enough that
// our default max_tokens completion budget tips the request over the
// ceiling, even though the account isn't otherwise being hammered with
// requests. Waiting and retrying the identical request would NOT help here
// (unlike a genuine "too many requests" throttle) since the request alone
// already exceeds the whole per-minute allowance -- the only fix is to
// shrink what we're asking for. Groq's error message conveniently states
// both the limit and what was requested, so we parse it and retry once
// with just enough max_tokens trimmed off to fit.
const GROQ_TPM_ERROR_PATTERN = /Limit (\d+).*?Requested (\d+)/is;

function parseGroqTpmOverage(message: string): { limit: number; requested: number } | undefined {
  const match = GROQ_TPM_ERROR_PATTERN.exec(message);
  if (!match) return undefined;
  return { limit: Number(match[1]), requested: Number(match[2]) };
}

async function generateViaGroq(
  systemPrompt: string,
  userPrompt: string,
  tool: StructuredToolSpec,
  model: string,
  maxTokens: number,
  signal?: AbortSignal
): Promise<unknown> {
  const client = new OpenAI({
    apiKey: config.groqApiKey,
    baseURL: 'https://api.groq.com/openai/v1',
  });

  async function callWithMaxTokens(effectiveMaxTokens: number) {
    return client.chat.completions.create(
      {
        model,
        max_tokens: effectiveMaxTokens,
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
      },
      { signal }
    );
  }

  let response;
  try {
    response = await callWithMaxTokens(maxTokens);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const overage = parseGroqTpmOverage(message);

    // Only treat this as the specific "prompt + max_tokens exceeded the
    // per-minute budget" case if the numbers actually describe an overage
    // (requested > limit). Some other 413/429 shapes can coincidentally
    // contain the words "Limit"/"Requested" for an unrelated quota (e.g. a
    // daily cap, where "requested" can be smaller than "limit") -- blindly
    // trusting the arithmetic there previously produced a *larger*,
    // invalid max_tokens on retry that then broke on the model's own
    // context-window ceiling instead. Also hard-clamp the trimmed value so
    // it can never end up >= the original: trimming should only ever
    // shrink the request, never grow it.
    if (!overage || overage.requested <= overage.limit) throw err;

    // Trim the overage off max_tokens, plus a small safety margin for
    // token-count estimation slop, but never trim below a floor small
    // enough to still return a usable structured response.
    const trimmedMaxTokens = Math.min(
      maxTokens - 200,
      maxTokens - (overage.requested - overage.limit) - 200
    );
    if (trimmedMaxTokens < 1024) {
      throw new Error(
        `${message}\n\nThis transcript (plus any brief/reference material) is too large to fit even a reduced completion budget under Groq's free-tier rate limit for ${model}. Try a shorter reference-material upload, or switch LLM_PROVIDER to anthropic in your environment variables for larger requests.`
      );
    }

    response = await callWithMaxTokens(trimmedMaxTokens);
  }

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
