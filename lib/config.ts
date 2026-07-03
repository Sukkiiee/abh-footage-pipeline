// Centralized env var access with fail-fast validation.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`
    );
  }
  return value;
}

export const config = {
  google: {
    get clientId() {
      return required('GOOGLE_CLIENT_ID');
    },
    get clientSecret() {
      return required('GOOGLE_CLIENT_SECRET');
    },
  },
  // Transcription: Groq's hosted Whisper endpoint (OpenAI-compatible API),
  // used instead of OpenAI's paid Whisper API because Groq has a genuinely
  // free tier. Get a key at https://console.groq.com/keys.
  get groqApiKey() {
    return required('GROQ_API_KEY');
  },
  get groqWhisperModel() {
    return process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';
  },
  // Narrative generation + short-form flagging both go through lib/llm.ts,
  // which picks a provider based on this switch. Defaults to Groq (free
  // tier, no billing required) so the whole pipeline can be exercised at
  // zero cost; set LLM_PROVIDER=anthropic (and ANTHROPIC_API_KEY) later to
  // switch to Claude for production-quality output. No code changes needed
  // to move between them.
  get llmProvider(): 'groq' | 'anthropic' {
    return process.env.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'groq';
  },
  get groqNarrativeModel() {
    return process.env.GROQ_NARRATIVE_MODEL || 'llama-3.3-70b-versatile';
  },
  get groqShortFormModel() {
    return process.env.GROQ_SHORTFORM_MODEL || 'llama-3.3-70b-versatile';
  },
  // Only required when LLM_PROVIDER=anthropic.
  get anthropicApiKey() {
    return required('ANTHROPIC_API_KEY');
  },
  get anthropicNarrativeModel() {
    return process.env.ANTHROPIC_NARRATIVE_MODEL || 'claude-opus-4-8';
  },
  get anthropicShortFormModel() {
    return process.env.ANTHROPIC_SHORTFORM_MODEL || 'claude-sonnet-4-6';
  },
  get sessionSecret() {
    return required('SESSION_SECRET');
  },
  // Base URL of the deployed app, used to build the OAuth redirect URI.
  // Falls back to Vercel's or Render's auto-injected URL, then localhost.
  get appUrl() {
    if (process.env.APP_URL) return process.env.APP_URL;
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
    return 'http://localhost:3000';
  },
  // Optional: default local path (on the editor's machine) where the FCPXML
  // will look for the source media. Editable per-run from the UI.
  get defaultLocalMediaDir() {
    return process.env.DEFAULT_LOCAL_MEDIA_DIR || '/Users/Shared/ABH_Footage';
  },
  // Safety cap on source video size, in GB. This exists because Vercel's
  // serverless functions have limited /tmp (ephemeral) storage -- check
  // your plan's current documented limit before raising this for a Vercel
  // deployment. Running locally via `npm run dev` writes to your real
  // disk instead, so this is much less of a concern there; default is set
  // generously for local use.
  get maxSourceFileGB() {
    const raw = process.env.MAX_SOURCE_FILE_GB;
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
  },
  // Cap on combined reference material (uploaded docs + transcribed
  // reference videos), in characters. It's sent to the LLM on every run --
  // both the narrative and short-form calls -- so higher isn't free: more
  // tokens per run, every run, even when the reference material itself
  // never changes. Raise if you have more reference material you want
  // actually used rather than silently truncated.
  get referenceMaterialMaxChars() {
    const raw = process.env.REFERENCE_MATERIAL_MAX_CHARS;
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
  },
};
