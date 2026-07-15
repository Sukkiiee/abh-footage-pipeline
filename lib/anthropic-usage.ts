import fs from 'fs';
import path from 'path';

// A hard, real-money safety net: tracks actual Anthropic spend (computed
// from each call's real token usage, not an estimate) in a small local
// JSON file, reset daily, so a shared/hosted instance can't run up an
// unbounded bill -- whether Anthropic got used via an explicit per-run
// choice or an approved Auto-mode switch, every path funnels through
// recordSpend/getTodaySpend before/after the actual API call.
//
// Deliberately a flat file, not a database: this app has no database by
// design (see README), and spend tracking doesn't need anything more
// durable than "resets once a day, survives a restart."
const USAGE_FILE = path.join(process.cwd(), '.anthropic-usage.json');

interface UsageRecord {
  date: string; // YYYY-MM-DD, local server date
  spentUSD: number;
}

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function readRecord(): UsageRecord {
  try {
    const raw = fs.readFileSync(USAGE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as UsageRecord;
    if (parsed.date === todayKey() && typeof parsed.spentUSD === 'number') {
      return parsed;
    }
  } catch {
    // No file yet, or unreadable/corrupt -- start fresh below.
  }
  return { date: todayKey(), spentUSD: 0 };
}

export function getTodaySpendUSD(): number {
  return readRecord().spentUSD;
}

export function recordSpendUSD(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const record = readRecord();
  record.spentUSD += amount;
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(record));
  } catch {
    // Best effort -- if this can't be written (read-only filesystem, etc),
    // the call itself still already happened and shouldn't be treated as
    // failed just because logging it failed. Worst case, the cap is less
    // precisely enforced until this starts working again.
  }
}

// Official per-million-token pricing (Claude API, as of the model
// defaults this app ships with -- see lib/config.ts's
// anthropicNarrativeModel/anthropicShortFormModel). If a model ID isn't
// recognized (a custom override via env var), falls back to Sonnet
// pricing as a reasonable middle-of-the-road estimate rather than
// crashing or silently not tracking spend at all.
const MODEL_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const FALLBACK_PRICING = { input: 3, output: 15 };

export function estimateCostUSD(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING_PER_MTOK[model] || FALLBACK_PRICING;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
