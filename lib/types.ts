// Shared types for the ABH footage pipeline.

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

export interface SessionData {
  tokens?: GoogleTokens;
  folderId?: string;
  folderName?: string;
}

export interface DriveVideoFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  /** Path of subfolder names (not including the connected root) this file was found under, if listing was recursive. e.g. "Round 2/Semifinals" */
  folderPath?: string;
  /** 'drive' (the default -- omitted on existing Drive listings) or 'local', for footage read directly off the disk of the machine this app is running on rather than from Google Drive. */
  source?: 'drive' | 'local';
  /** Only set when source is 'local': the absolute path on disk, fed directly to ffmpeg (no Drive involved at all for this file). */
  localPath?: string;
}

export interface TranscriptSegment {
  id: number;
  start: number; // seconds
  end: number; // seconds
  text: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  fullText: string;
  durationSec: number;
}

export interface VideoMetadata {
  fileName: string;
  durationSec: number;
  width: number;
  height: number;
  frameRateNum: number; // e.g. 30000
  frameRateDen: number; // e.g. 1001
  hasAudio: boolean;
}

export interface NarrativeCitation {
  timestamp: string; // HH:MM:SS
  quote?: string;
}

export interface NarrativeSection {
  heading: string;
  narrative: string;
  citations: NarrativeCitation[];
}

export interface NarrativeResult {
  /** The top-pick title, used for exports/filenames. Always equal to titleOptions[0]. */
  title: string;
  /** All title candidates the model proposed, strongest first. */
  titleOptions: string[];
  logline: string;
  themes?: string[];
  sections: NarrativeSection[];
  closingLine?: string;
}

export interface ShortFormClip {
  /** The top-pick title for this clip, used in FCPXML clip names, DOCX table, file naming. Always equal to titleOptions[0]. */
  title: string;
  /** All title candidates the model proposed for this clip, strongest first. */
  titleOptions: string[];
  startSec: number;
  endSec: number;
  startTimestamp: string; // HH:MM:SS
  endTimestamp: string; // HH:MM:SS
  hook: string;
  singleIdea: string;
  payoff: string;
  rationale: string;
  /** The model's own devil's-advocate check for why this clip could be rejected, and why it holds up anyway. Forces a second look at borderline clips instead of flagging on first pass. */
  counterCheck?: string;
  suggestedCaption?: string;
  platformFit?: string[];
}

export interface PipelineProgressEvent {
  stage:
    | 'metadata'
    | 'download'
    | 'probe'
    | 'audio'
    | 'transcribe'
    | 'narrative'
    | 'shortform'
    | 'export'
    | 'cleanup';
  message: string;
  percent: number;
  /**
   * Real transcript lines from the most recently completed Whisper chunk,
   * present only on some 'transcribe'-stage events. This is genuine
   * transcript text as it's produced (per audio chunk, not per word), used
   * to show a live transcript feed in the UI rather than a generic spinner.
   */
  transcriptLines?: { timestamp: string; text: string }[];
}

export interface PipelineDoneEvent {
  sourceFileName: string;
  narrative: NarrativeResult;
  clips: ShortFormClip[];
  /** Probed source video metadata -- included so a multi-video batch run can later be combined into one FCPXML (which needs each source's frame rate/resolution) without re-probing. */
  metadata: VideoMetadata;
  docxBase64: string;
  fcpxmlBase64: string;
  srtBase64: string;
  docxFilename: string;
  fcpxmlFilename: string;
  srtFilename: string;
}

export interface PipelineErrorEvent {
  message: string;
  stage?: string;
}
