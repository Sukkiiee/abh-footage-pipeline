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
  // Falls back to Vercel's auto-injected URL, then localhost for dev.
  get appUrl() {
    if (process.env.APP_URL) return process.env.APP_URL;
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    return 'http://localhost:3000';
  },
  // Optional: default local path (on the editor's machine) where the FCPXML
  // will look for the source media. Editable per-run from the UI.
  get defaultLocalMediaDir() {
    return process.env.DEFAULT_LOCAL_MEDIA_DIR || '/Users/Shared/ABH_Footage';
  },
};
