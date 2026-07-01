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
  title: string;
  logline: string;
  themes?: string[];
  sections: NarrativeSection[];
  closingLine?: string;
}

export interface ShortFormClip {
  startSec: number;
  endSec: number;
  startTimestamp: string; // HH:MM:SS
  endTimestamp: string; // HH:MM:SS
  hook: string;
  singleIdea: string;
  payoff: string;
  rationale: string;
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
}

export interface PipelineDoneEvent {
  sourceFileName: string;
  narrative: NarrativeResult;
  clips: ShortFormClip[];
  docxBase64: string;
  fcpxmlBase64: string;
  docxFilename: string;
  fcpxmlFilename: string;
}

export interface PipelineErrorEvent {
  message: string;
  stage?: string;
}
