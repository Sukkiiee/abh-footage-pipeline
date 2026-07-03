// Shared formatting for producer-uploaded reference documents (other
// transcripts/scripts used as style or soundbite guides), so the prompt
// wording stays identical between narrative.ts and shortform.ts.

import { config } from './config';

export function formatReferenceBlock(referenceMaterial?: string): string {
  if (!referenceMaterial?.trim()) return '';

  const trimmed = referenceMaterial.trim().slice(0, config.referenceMaterialMaxChars);

  return `\nReference material uploaded by the producer (other transcripts/scripts, provided purely as style and soundbite-quality guides, not as facts about this footage):\n---REFERENCE START---\n${trimmed}\n---REFERENCE END---\nUse this only to calibrate tone and what makes a strong moment/soundbite; never pull facts, quotes, or events from it into output about this footage.\n`;
}
