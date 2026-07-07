'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  DriveVideoFile,
  NarrativeResult,
  ShortFormClip,
  VideoMetadata,
  PipelineProgressEvent,
} from '@/lib/types';

interface AuthStatus {
  connected: boolean;
  folderId: string | null;
  folderName: string | null;
}

interface ReferenceDoc {
  filename: string;
  text: string;
}

// Mirrors lib/config.ts's referenceMaterialMaxChars default. If you set
// REFERENCE_MATERIAL_MAX_CHARS in .env.local to something else, update this
// to match so the client-side warning/truncation stays accurate.
const MAX_REFERENCE_CHARS = 60000;

const TARGET_LENGTH_PRESETS = ['1', '2', '3', '5', '10', '15', '20', '30'];

interface PipelineDone {
  sourceFileName: string;
  narrative: NarrativeResult;
  clips: ShortFormClip[];
  metadata?: VideoMetadata;
  rejectedClipCount: number;
  // Present for a run's lifetime in this browser session, and while it's
  // still within the local history cap. Once history overflows, these get
  // stripped after a successful upload to the Drive archive folder (see
  // `archived` below) to keep localStorage usage bounded -- the actual
  // files aren't lost, just no longer duplicated locally.
  docxBase64?: string;
  fcpxmlBase64?: string;
  srtBase64?: string;
  docxFilename: string;
  fcpxmlFilename: string;
  srtFilename: string;
  /** Set once this entry's files have been uploaded to the Drive archive folder, replacing the base64 fields above. */
  archived?: {
    docxLink?: string;
    fcpxmlLink?: string;
    srtLink?: string;
  };
  /** When this run finished, for the History view. Attached client-side (not sent by the server). */
  completedAt?: string;
  /** How long this run took end to end, in seconds. Attached client-side (not sent by the server). */
  runtimeSec?: number;
}

const PROCESSED_KEY = 'abh_processed_files';

function loadProcessedMap(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(PROCESSED_KEY) || '{}');
  } catch {
    return {};
  }
}

function markProcessed(fileId: string) {
  const map = loadProcessedMap();
  map[fileId] = new Date().toISOString();
  window.localStorage.setItem(PROCESSED_KEY, JSON.stringify(map));
}

function formatBytes(size?: string): string {
  if (!size) return '';
  const bytes = Number(size);
  if (!Number.isFinite(bytes)) return '';
  const mb = bytes / (1024 * 1024);
  if (mb > 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

// Groups the server's fine-grained SSE stages into the 5 steps the
// processing view shows, matching the Dailies mockup's step tracker.
const STEP_GROUPS: { label: string; detail: string; stages: string[] }[] = [
  {
    label: 'Pulling footage from Drive',
    detail: 'Fetching file metadata and streaming the audio track directly from Drive.',
    stages: ['metadata', 'download', 'probe', 'audio'],
  },
  {
    label: 'Transcribing with timestamps',
    detail: 'Whisper transcription, chunked for long footage.',
    stages: ['transcribe'],
  },
  {
    label: 'Reviewing & building narrative',
    detail: 'Reading the transcript against the brief, grouping moments into beats.',
    stages: ['narrative'],
  },
  {
    label: 'Flagging short-form moments',
    detail: 'Scanning for self-contained, hook-first clips between 15 and 60 seconds.',
    stages: ['shortform'],
  },
  {
    label: 'Exporting .docx, .fcpxml, .srt',
    detail: 'Packaging results ready to hand to an editor for cut.',
    stages: ['export', 'cleanup'],
  },
];

type StepStatus = 'pending' | 'active' | 'done';

function getStepStatus(groupIndex: number, currentGroupIndex: number): StepStatus {
  if (currentGroupIndex < 0) return 'pending';
  if (groupIndex < currentGroupIndex) return 'done';
  if (groupIndex === currentGroupIndex) return 'active';
  return 'pending';
}

/** Real elapsed time for a completed step group: the gap between its first event and the next group's first event, both from the client's own clock (the server doesn't send timestamps). */
function getStepDurationSeconds(
  groupIndex: number,
  log: (PipelineProgressEvent & { receivedAt: number })[]
): number | null {
  const group = STEP_GROUPS[groupIndex];
  const nextGroup = STEP_GROUPS[groupIndex + 1];
  const firstOfThis = log.find((e) => group.stages.includes(e.stage));
  if (!firstOfThis) return null;
  const firstOfNext = nextGroup ? log.find((e) => nextGroup.stages.includes(e.stage)) : undefined;
  if (!firstOfNext) return null;
  return (firstOfNext.receivedAt - firstOfThis.receivedAt) / 1000;
}

const RUN_HISTORY_KEY = 'abh_run_history';
const MAX_HISTORY_ENTRIES = 30;

interface RunHistoryEntry {
  bytes: number;
  durationSec: number;
}

function loadRunHistory(): RunHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(window.localStorage.getItem(RUN_HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function recordRunHistory(bytes: number, durationSec: number) {
  if (!bytes || !durationSec) return;
  const history = loadRunHistory();
  history.push({ bytes, durationSec });
  window.localStorage.setItem(
    RUN_HISTORY_KEY,
    JSON.stringify(history.slice(-MAX_HISTORY_ENTRIES))
  );
}

/**
 * Rough ETA from past real runs on this machine (seconds-per-byte, averaged
 * across history), not a guessed constant -- returns null until there's at
 * least one completed run to learn from, since a made-up number would be
 * worse than no estimate at all.
 */
function estimateDurationSeconds(bytes: number): number | null {
  const history = loadRunHistory();
  if (history.length === 0 || !bytes) return null;
  const totalBytes = history.reduce((sum, h) => sum + h.bytes, 0);
  const totalDuration = history.reduce((sum, h) => sum + h.durationSec, 0);
  if (totalBytes === 0) return null;
  const secondsPerByte = totalDuration / totalBytes;
  return bytes * secondsPerByte;
}

// Finished runs (including their .docx/.fcpxml/.srt as base64) persist here
// so a page refresh doesn't wipe out work the user already paid transcription/
// LLM time for. Capped at a modest count and defensively trimmed on quota
// errors, since each entry can be a few hundred KB to a few MB.
const RESULTS_HISTORY_KEY = 'abh_results_history';
const MAX_RESULTS_ENTRIES = 15;

function loadResultsHistory(): PipelineDone[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(window.localStorage.getItem(RESULTS_HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveResultsHistory(results: PipelineDone[]) {
  if (typeof window === 'undefined') return;
  // By the time this runs, archiveOverflowIfNeeded (below) has already
  // uploaded anything past the cap to Drive and stripped its base64, so
  // this should almost always fit. As an absolute last resort (Drive
  // archiving failed, or wasn't possible because Drive isn't connected),
  // strip base64 from the oldest entries -- losing the re-downloadable
  // file but keeping the title/summary/clip metadata -- before ever
  // deleting an entry outright.
  let toStore = results;
  while (true) {
    try {
      window.localStorage.setItem(RESULTS_HISTORY_KEY, JSON.stringify(toStore));
      return;
    } catch {
      const strippable = toStore
        .map((r, i) => ({ r, i }))
        .reverse()
        .find(({ r }) => r.docxBase64 || r.fcpxmlBase64 || r.srtBase64);
      if (!strippable) break;
      toStore = toStore.map((r, i) =>
        i === strippable.i ? { ...r, docxBase64: undefined, fcpxmlBase64: undefined, srtBase64: undefined } : r
      );
    }
  }
  // Every entry has already been stripped and it still doesn't fit (an
  // enormous number of runs) -- only now drop the oldest outright.
  while (toStore.length > 0) {
    try {
      window.localStorage.setItem(RESULTS_HISTORY_KEY, JSON.stringify(toStore));
      return;
    } catch {
      toStore = toStore.slice(0, -1);
    }
  }
  try {
    window.localStorage.removeItem(RESULTS_HISTORY_KEY);
  } catch {
    // best effort
  }
}

/**
 * Uploads any run older than MAX_RESULTS_ENTRIES (that still has its full
 * base64 payload) to the Drive archive folder, replacing it with a
 * lightweight stub (metadata + Drive links) once uploaded -- so history
 * keeps growing indefinitely without indefinitely growing localStorage
 * usage, and without ever silently deleting a past run's record. Returns
 * null if there was nothing to do (the common case on every render).
 */
async function archiveOverflowIfNeeded(
  results: PipelineDone[],
  driveConnected: boolean
): Promise<PipelineDone[] | null> {
  const overflowIndexes = results
    .map((r, i) => i)
    .filter((i) => i >= MAX_RESULTS_ENTRIES && results[i].docxBase64 !== undefined);

  if (overflowIndexes.length === 0) return null;

  const next = [...results];
  let changed = false;

  for (const i of overflowIndexes) {
    const entry = results[i];
    if (!driveConnected) {
      // Can't archive without Drive access -- strip now rather than
      // waiting for saveResultsHistory's quota-triggered fallback to do
      // the same thing later, so localStorage usage stays bounded
      // proactively instead of only reactively.
      next[i] = { ...entry, docxBase64: undefined, fcpxmlBase64: undefined, srtBase64: undefined };
      changed = true;
      continue;
    }

    try {
      const res = await fetch('/api/pipeline/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docxFilename: entry.docxFilename,
          docxBase64: entry.docxBase64,
          fcpxmlFilename: entry.fcpxmlFilename,
          fcpxmlBase64: entry.fcpxmlBase64,
          srtFilename: entry.srtFilename,
          srtBase64: entry.srtBase64,
        }),
      });
      if (!res.ok) continue; // leave this entry as-is, retry on a later persist cycle
      const data = await res.json();
      next[i] = {
        ...entry,
        docxBase64: undefined,
        fcpxmlBase64: undefined,
        srtBase64: undefined,
        archived: { docxLink: data.docxLink, fcpxmlLink: data.fcpxmlLink, srtLink: data.srtLink },
      };
      changed = true;
    } catch {
      // Network hiccup -- leave as-is, retry on a later persist cycle.
      continue;
    }
  }

  return changed ? next : null;
}

function downloadBase64(filename: string, base64: string, mime: string) {
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  const blob = new Blob([buf], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function parseSrtTime(t: string): number {
  const m = t.trim().match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
  if (!m) return 0;
  const [, hh, mm, ss, ms] = m;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
}

function formatSrtTime(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const hh = Math.floor(clamped / 3600);
  const mm = Math.floor((clamped % 3600) / 60);
  const ss = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(ms, 3)}`;
}

/**
 * Concatenates several per-video SRT files (already base64-encoded, from
 * each pipeline run's `done` event) into one continuous transcript, as if
 * the videos played back to back: every video's captions get shifted by
 * the running total of the previous videos' durations, with a short header
 * caption marking where each new source starts. Done entirely client-side
 * since we already have everything needed from prior "done" events -- no
 * extra server round trip.
 */
function combineSrtToBase64(
  videos: { sourceFileName: string; srtBase64: string; durationSec?: number }[]
): string {
  let index = 1;
  let offsetSeconds = 0;
  const chunks: string[] = [];

  for (const video of videos) {
    chunks.push(
      `${index}\n${formatSrtTime(offsetSeconds)} --> ${formatSrtTime(offsetSeconds + 2)}\n== ${video.sourceFileName} ==\n`
    );
    index++;

    const text = base64ToUtf8(video.srtBase64).trim();
    if (text) {
      for (const block of text.split(/\n\n+/)) {
        const lines = block.split('\n');
        if (lines.length < 2) continue;
        const [startStr, endStr] = lines[1].split('-->');
        const start = parseSrtTime(startStr) + offsetSeconds;
        const end = parseSrtTime(endStr) + offsetSeconds;
        const captionText = lines.slice(2).join('\n');
        chunks.push(`${index}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${captionText}\n`);
        index++;
      }
    }

    offsetSeconds += video.durationSec ?? 0;
  }

  return utf8ToBase64(chunks.join('\n'));
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
    reader.readAsText(file);
  });
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      // strip the "data:<mime>;base64," prefix from a data URL
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

export default function Dashboard() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folderInput, setFolderInput] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);
  const [files, setFiles] = useState<DriveVideoFile[] | null>(null);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [processedMap, setProcessedMap] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [footageListExpanded, setFootageListExpanded] = useState(true);
  const [localMediaPath, setLocalMediaPath] = useState('');
  const [titleHint, setTitleHint] = useState('');
  const [brief, setBrief] = useState('');
  const [targetLengthMinutes, setTargetLengthMinutes] = useState('');
  const [useCustomLength, setUseCustomLength] = useState(false);
  const [driveLinkInput, setDriveLinkInput] = useState('');
  const [referenceDocs, setReferenceDocs] = useState<ReferenceDoc[]>([]);
  const [referenceUploadBusy, setReferenceUploadBusy] = useState(false);
  const [referenceVideoUrl, setReferenceVideoUrl] = useState('');
  const [referenceVideoBusy, setReferenceVideoBusy] = useState(false);

  const [runningFileId, setRunningFileId] = useState<string | null>(null);
  const [runningLabel, setRunningLabel] = useState('');
  // receivedAt (client-side wall clock, not sent by the server) lets the
  // processing view compute a real elapsed time per step: the gap between
  // the first event of one step group and the first event of the next.
  const [progressLog, setProgressLog] = useState<(PipelineProgressEvent & { receivedAt: number })[]>(
    []
  );
  const [percent, setPercent] = useState(0);
  const [results, setResults] = useState<PipelineDone[]>(() => loadResultsHistory());
  const [expandedResult, setExpandedResult] = useState(0);
  const [view, setView] = useState<'processing' | 'result' | 'history'>('result');
  const [liveTranscriptLines, setLiveTranscriptLines] = useState<{ timestamp: string; text: string }[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  const [batchActive, setBatchActive] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(
    null
  );
  const [combining, setCombining] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [estimatedTotalSeconds, setEstimatedTotalSeconds] = useState<number | null>(null);

  const isBusy = runningFileId !== null || batchActive || combining;

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const refreshStatus = useCallback(async () => {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    setStatus(data);
  }, []);

  const refreshFiles = useCallback(async () => {
    const res = await fetch('/api/drive/files');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Failed to load footage list.');
      return;
    }
    const data = await res.json();
    setFiles(data.files);
    setFilesTruncated(!!data.truncated);
    setProcessedMap(loadProcessedMap());
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err) setError(err);
    refreshStatus();
  }, [refreshStatus]);

  // Persist finished runs so a page refresh doesn't lose them -- the
  // history tab (and this) is exactly what makes that durable. Before
  // saving, archive anything past the local cap to Drive (if connected)
  // so history can keep growing without indefinitely growing localStorage
  // usage or ever silently deleting a past run.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const archived = await archiveOverflowIfNeeded(results, !!status?.connected);
      if (cancelled) return;
      if (archived) {
        setResults(archived);
      } else {
        saveResultsHistory(results);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [results, status?.connected]);

  useEffect(() => {
    if (status?.connected && status.folderId) {
      refreshFiles();
    }
  }, [status, refreshFiles]);

  // Live elapsed-time clock for the active run. Pauses along with the
  // pipeline itself, so it reflects actual processing time rather than
  // wall-clock time spent sitting paused.
  useEffect(() => {
    if (!runningFileId || paused) return;
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [runningFileId, paused]);

  async function submitFolder(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFolderBusy(true);
    try {
      const res = await fetch('/api/drive/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: folderInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to connect that folder.');
        return;
      }
      await refreshStatus();
    } finally {
      setFolderBusy(false);
    }
  }

  async function disconnect() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setStatus({ connected: false, folderId: null, folderName: null });
    setFiles(null);
  }

  async function handleReferenceUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    setReferenceUploadBusy(true);
    try {
      for (const file of Array.from(fileList)) {
        const lower = file.name.toLowerCase();
        try {
          if (lower.endsWith('.txt') || lower.endsWith('.md')) {
            const text = await readFileAsText(file);
            setReferenceDocs((prev) => [...prev, { filename: file.name, text }]);
          } else if (lower.endsWith('.docx')) {
            const base64 = await readFileAsBase64(file);
            const res = await fetch('/api/reference/parse', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: file.name, base64 }),
            });
            const data = await res.json();
            if (!res.ok) {
              setError(data.error || `Failed to parse "${file.name}".`);
              continue;
            }
            setReferenceDocs((prev) => [...prev, { filename: file.name, text: data.text || '' }]);
          } else {
            setError(
              `"${file.name}": only .txt, .md, and .docx reference files are supported right now.`
            );
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : `Failed to read "${file.name}".`);
        }
      }
    } finally {
      setReferenceUploadBusy(false);
    }
  }

  function removeReferenceDoc(filename: string) {
    setReferenceDocs((prev) => prev.filter((d) => d.filename !== filename));
  }

  async function handleAddReferenceVideo(e: React.FormEvent) {
    e.preventDefault();
    const url = referenceVideoUrl.trim();
    if (!url) return;
    setError(null);
    setReferenceVideoBusy(true);
    try {
      const res = await fetch('/api/reference/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to process that video link.');
        return;
      }
      setReferenceDocs((prev) => [...prev, { filename: data.title || url, text: data.text || '' }]);
      setReferenceVideoUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process that video link.');
    } finally {
      setReferenceVideoBusy(false);
    }
  }

  function buildReferenceMaterial(): string | undefined {
    if (referenceDocs.length === 0) return undefined;
    const combined = referenceDocs
      .map((d) => `--- ${d.filename} ---\n${d.text.trim()}`)
      .join('\n\n');
    return combined.slice(0, MAX_REFERENCE_CHARS);
  }

  async function runPipeline(
    target: { fileId?: string; driveLink?: string; displayName: string; sizeBytes?: number },
    opts?: { collect?: (data: PipelineDone) => void; onError?: (message: string) => void }
  ) {
    setError(null);
    setProgressLog([]);
    setPercent(0);
    setRunningLabel(target.displayName);
    setRunningFileId(target.fileId || 'link');
    setPaused(false);
    setElapsedSeconds(0);
    setEstimatedTotalSeconds(target.sizeBytes ? estimateDurationSeconds(target.sizeBytes) : null);
    setLiveTranscriptLines([]);
    setView('processing');

    const jobId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setCurrentJobId(jobId);
    const runStart = Date.now();

    const parsedTargetLength = targetLengthMinutes ? Number(targetLengthMinutes) : undefined;

    try {
      const res = await fetch('/api/pipeline/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: target.fileId,
          driveLink: target.driveLink,
          localMediaPath: localMediaPath || undefined,
          titleHint: titleHint || undefined,
          brief: brief || undefined,
          referenceMaterial: buildReferenceMaterial(),
          jobId,
          targetLengthMinutes:
            parsedTargetLength && Number.isFinite(parsedTargetLength) && parsedTargetLength > 0
              ? parsedTargetLength
              : undefined,
        }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        const fullMessage = `${target.displayName}: ${data.error || `Pipeline failed to start (HTTP ${res.status}).`}`;
        setError(fullMessage);
        opts?.onError?.(fullMessage);
        setRunningFileId(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // If the connection drops (a proxy/idle timeout, the server process
      // crashing, etc. -- confirmed happening on Render's free tier against
      // a 15GB file) the stream just closes with no 'error' SSE event ever
      // sent, since nothing server-side got the chance to send one. Without
      // this flag, that looked like nothing happened at all: the loop below
      // would simply exit and the run would silently reset to idle.
      let receivedTerminalEvent = false;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIndex: number;
        // eslint-disable-next-line no-cond-assign
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);

          const eventMatch = rawEvent.match(/^event: (.+)$/m);
          const dataMatch = rawEvent.match(/^data: (.+)$/m);
          if (!eventMatch || !dataMatch) continue;

          const eventName = eventMatch[1];
          const data = JSON.parse(dataMatch[1]);

          if (eventName === 'progress') {
            const progressEvent = data as PipelineProgressEvent;
            setProgressLog((prev) => [...prev, { ...progressEvent, receivedAt: Date.now() }]);
            setPercent(progressEvent.percent);
            if (progressEvent.transcriptLines && progressEvent.transcriptLines.length > 0) {
              setLiveTranscriptLines(progressEvent.transcriptLines);
            }
          } else if (eventName === 'done') {
            receivedTerminalEvent = true;
            // completedAt/runtimeSec aren't sent by the server -- attached
            // here, once, from this client's own clock, so every result
            // (single run or one collected into a batch/combine) carries
            // real history metadata without needing server-side storage.
            const enriched: PipelineDone = {
              ...(data as PipelineDone),
              completedAt: new Date().toISOString(),
              runtimeSec: (Date.now() - runStart) / 1000,
            };
            if (opts?.collect) {
              opts.collect(enriched);
            } else {
              setResults((prev) => [enriched, ...prev]);
              setExpandedResult(0);
              setView('result');
            }
            setPercent(100);
            if (target.fileId) {
              markProcessed(target.fileId);
              setProcessedMap(loadProcessedMap());
            }
            if (target.sizeBytes) {
              recordRunHistory(target.sizeBytes, (Date.now() - runStart) / 1000);
            }
          } else if (eventName === 'error') {
            receivedTerminalEvent = true;
            const fullMessage = `${target.displayName}: ${data.message || 'Pipeline failed.'}`;
            setError(fullMessage);
            opts?.onError?.(fullMessage);
          }
        }
      }

      if (!receivedTerminalEvent) {
        const fullMessage = `${target.displayName}: Connection closed before the pipeline finished. This can happen with very large files (a proxy or server timeout can drop a long-running connection) -- try again, or with a smaller/trimmed file if it keeps happening on this one.`;
        setError(fullMessage);
        opts?.onError?.(fullMessage);
      }
    } catch (err) {
      const fullMessage = `${target.displayName}: ${err instanceof Error ? err.message : 'Pipeline connection failed.'}`;
      setError(fullMessage);
      opts?.onError?.(fullMessage);
    } finally {
      setRunningFileId(null);
      setCurrentJobId(null);
      setPaused(false);
    }
  }

  async function sendPipelineControl(action: 'pause' | 'resume' | 'stop') {
    if (!currentJobId) return;
    setControlBusy(true);
    try {
      const res = await fetch('/api/pipeline/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: currentJobId, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed to ${action} the pipeline.`);
        return;
      }
      if (action === 'pause') setPaused(true);
      if (action === 'resume') setPaused(false);
      // 'stop' leaves paused/runningFileId as-is; the running request will
      // surface a clean "Pipeline stopped by user." error event shortly,
      // which resets everything via runPipeline's own finally block.
    } finally {
      setControlBusy(false);
    }
  }

  function runFromLink(e: React.FormEvent) {
    e.preventDefault();
    if (!driveLinkInput.trim()) return;
    runPipeline({ driveLink: driveLinkInput.trim(), displayName: 'video from pasted link' });
  }

  async function runSelected() {
    if (!files) return;
    const toRun = files.filter((f) => selectedIds.has(f.id));
    if (toRun.length === 0) return;

    setBatchActive(true);
    const collected: PipelineDone[] = [];
    const failures: string[] = [];
    try {
      for (let i = 0; i < toRun.length; i++) {
        setBatchProgress({ current: i + 1, total: toRun.length });
        await runPipeline(
          { fileId: toRun[i].id, displayName: toRun[i].name, sizeBytes: Number(toRun[i].size) || undefined },
          { collect: (data) => collected.push(data), onError: (message) => failures.push(message) }
        );
        // A per-file failure is recorded above; keep going through the rest
        // of the selection rather than losing everything already done.
      }
    } finally {
      setBatchProgress(null);
      setBatchActive(false);
    }

    if (collected.length === 0) {
      // Show what actually went wrong for each file, not a generic
      // one-liner -- the per-file error would otherwise get silently
      // overwritten by whichever file failed last, then overwritten again
      // by a summary message with no diagnostic value.
      setError(
        failures.length > 0
          ? `None of the selected files finished successfully:\n${failures.map((f) => `- ${f}`).join('\n')}`
          : 'None of the selected files finished successfully, so there is nothing to combine.'
      );
      return;
    }

    // Single video selected: no need for a combine round trip, just show it
    // like any other individual run.
    if (collected.length === 1) {
      setResults((prev) => [collected[0], ...prev]);
      setExpandedResult(0);
      setSelectedIds(new Set());
      setView('result');
      return;
    }

    setCombining(true);
    try {
      const res = await fetch('/api/pipeline/combine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videos: collected.map((c) => ({
            sourceFileName: c.sourceFileName,
            narrative: c.narrative,
            clips: c.clips,
            metadata: c.metadata,
          })),
          localMediaPath: localMediaPath || undefined,
          titleHint: titleHint || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to combine the selected videos into one document.');
        return;
      }

      const combined: PipelineDone = {
        sourceFileName: `${collected.length} videos combined`,
        narrative: data.narrative,
        clips: data.clips,
        rejectedClipCount: collected.reduce((sum, c) => sum + c.rejectedClipCount, 0),
        docxBase64: data.docxBase64,
        fcpxmlBase64: data.fcpxmlBase64,
        srtBase64: combineSrtToBase64(
          collected.map((c) => ({
            sourceFileName: c.sourceFileName,
            // These are always freshly-populated results straight from the
            // SSE stream at this point in the flow (never a stripped/
            // archived history entry), so this is safe.
            srtBase64: c.srtBase64 || '',
            durationSec: c.metadata?.durationSec,
          }))
        ),
        docxFilename: data.docxFilename,
        fcpxmlFilename: data.fcpxmlFilename,
        srtFilename: `${data.docxFilename.replace(/ - ABH Narrative\.docx$/, '')} - Combined Transcript.srt`,
        completedAt: new Date().toISOString(),
        runtimeSec: collected.reduce((sum, c) => sum + (c.runtimeSec || 0), 0),
      };

      setResults((prev) => [combined, ...prev]);
      setExpandedResult(0);
      setSelectedIds(new Set());
      setView('result');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to combine results.');
    } finally {
      setCombining(false);
    }
  }

  if (status === null) {
    return <div className="muted" style={{ padding: 32 }}>Loading...</div>;
  }

  const connected = status.connected && !!status.folderId;
  const newCount = files ? files.filter((f) => !processedMap[f.id]).length : 0;
  const currentGroupIndex =
    progressLog.length > 0
      ? STEP_GROUPS.findIndex((g) => g.stages.includes(progressLog[progressLog.length - 1].stage))
      : -1;
  const displayedResult = results[expandedResult] ?? results[0];
  const filteredHistory = results.filter((r) => {
    if (!historySearch.trim()) return true;
    const q = historySearch.toLowerCase();
    return (
      r.narrative.title.toLowerCase().includes(q) ||
      r.sourceFileName.toLowerCase().includes(q) ||
      r.clips.some((c) => c.title.toLowerCase().includes(q))
    );
  });
  const playheadPercent = runningFileId ? percent : 18;

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="ruler-wrap">
        <div className="topbar">
          <div className="brand">
            <span className="brand-mark">Dailies</span>
            <span className="brand-tag">footage in, story out — ABH</span>
          </div>
          <div className="live-status">
            <span className={`live-dot ${connected ? '' : 'idle'}`}></span>
            {connected
              ? `Watching /${status.folderName} — ${files ? files.length : 0} clips, ${newCount} new`
              : 'Not connected to Drive yet'}
          </div>
        </div>
        <div className="ruler">
          <div className="ruler-track"></div>
          <div className="tick major" style={{ left: 32 }}>
            <span className="tick-label">00:00</span>
          </div>
          <div className="tick" style={{ left: 180 }}></div>
          <div className="tick major" style={{ left: 328 }}>
            <span className="tick-label">00:30</span>
          </div>
          <div className="tick" style={{ left: 476 }}></div>
          <div className="tick major" style={{ left: 624 }}>
            <span className="tick-label">01:00</span>
          </div>
          <div className="tick" style={{ left: 772 }}></div>
          <div className="tick major" style={{ left: 920 }}>
            <span className="tick-label">01:30</span>
          </div>
          <div className="tick" style={{ left: 1068 }}></div>
          <div className="tick major" style={{ right: 32 }}>
            <span className="tick-label" style={{ right: 0, left: 'auto', transform: 'translateX(0)' }}>
              02:00
            </span>
          </div>
          <div className="playhead" style={{ left: `calc(32px + (100% - 64px) * ${playheadPercent / 100})` }}></div>
        </div>
      </div>

      <div className="shell">
        {/* LEFT: footage queue + run options */}
        <div>
          {!status.connected && (
            <div className="panel">
              <div className="eyebrow">Step 1 · Connect</div>
              <div className="field">
                <label>Google Drive</label>
                <div className="hint">
                  Connect once. Read-only access to list and download footage from a folder you
                  choose.
                </div>
              </div>
              <a href="/api/auth/google">
                <button className="btn btn-primary" style={{ width: '100%' }}>
                  Connect Google Drive
                </button>
              </a>
            </div>
          )}

          {status.connected && !status.folderId && (
            <div className="panel">
              <div className="eyebrow">Step 2 · Connect a folder</div>
              <form onSubmit={submitFolder}>
                <div className="field">
                  <label>Drive folder URL or ID</label>
                  <input
                    type="text"
                    placeholder="https://drive.google.com/drive/folders/..."
                    value={folderInput}
                    onChange={(e) => setFolderInput(e.target.value)}
                  />
                </div>
                <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={folderBusy}>
                  {folderBusy ? 'Verifying...' : 'Connect folder'}
                </button>
              </form>
            </div>
          )}

          {connected && (
            <>
              <div className="panel">
                <div className="eyebrow">
                  Footage queue <span className="count">{files ? files.length : 0}</span>
                </div>
                <div className="footage-source">
                  Connected to <span className="folder-name">{status.folderName}/</span> on Drive.
                  Includes subfolders.
                  <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-ghost"
                      style={{ flex: 'none', padding: '4px 10px', fontSize: 11 }}
                      onClick={() => setStatus({ ...status, folderId: null, folderName: null })}
                    >
                      Change folder
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ flex: 'none', padding: '4px 10px', fontSize: 11 }}
                      onClick={disconnect}
                    >
                      Disconnect
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ flex: 'none', padding: '4px 10px', fontSize: 11 }}
                      onClick={refreshFiles}
                    >
                      Refresh
                    </button>
                  </div>
                </div>

                {!files && <p className="muted">Loading footage...</p>}
                {files && files.length === 0 && (
                  <p className="muted">No .mp4/.mov files found in this folder or its subfolders.</p>
                )}
                {filesTruncated && (
                  <p className="muted" style={{ color: 'var(--danger)' }}>
                    This folder tree is large enough that the list below may be incomplete.
                  </p>
                )}

                <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                  {files &&
                    files.map((f) => {
                      const isProcessed = !!processedMap[f.id];
                      const isSelected = selectedIds.has(f.id);
                      const estimate = f.size ? estimateDurationSeconds(Number(f.size)) : null;
                      return (
                        <div
                          className={`clip-row ${isSelected ? 'selected' : ''}`}
                          key={f.id}
                          onClick={() => !isBusy && toggleSelected(f.id)}
                        >
                          <input
                            type="checkbox"
                            className="clip-check"
                            checked={isSelected}
                            onChange={() => toggleSelected(f.id)}
                            onClick={(e) => e.stopPropagation()}
                            disabled={isBusy}
                          />
                          <div className="clip-meta">
                            <div className="clip-name">{f.name}</div>
                            <div className="clip-sub">
                              {formatBytes(f.size)}
                              {estimate !== null ? ` · ~${formatDuration(estimate)} est.` : ' · no est. yet'}
                              {f.folderPath ? ` · ${f.folderPath}/` : ''}
                            </div>
                          </div>
                          <span className={`badge ${isProcessed ? 'done' : 'new'}`}>
                            {isProcessed ? 'Processed' : 'New'}
                          </span>
                        </div>
                      );
                    })}
                </div>

                <div className="btn-row">
                  <button className="btn btn-primary" onClick={runSelected} disabled={isBusy || selectedIds.size === 0}>
                    {batchActive && batchProgress
                      ? `Processing ${batchProgress.current}/${batchProgress.total}...`
                      : combining
                      ? 'Combining...'
                      : `Run selected (${selectedIds.size})`}
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={isBusy || !files}
                    onClick={() =>
                      setSelectedIds(new Set((files || []).filter((f) => !processedMap[f.id]).map((f) => f.id)))
                    }
                  >
                    Select all new
                  </button>
                </div>
                <div className="btn-row">
                  <button
                    className="btn btn-ghost"
                    disabled={isBusy || !files}
                    onClick={() => setSelectedIds(new Set((files || []).map((f) => f.id)))}
                  >
                    Select all
                  </button>
                  <button className="btn btn-ghost" disabled={isBusy} onClick={() => setSelectedIds(new Set())}>
                    Clear selection
                  </button>
                </div>

                <form
                  onSubmit={runFromLink}
                  style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--hairline)' }}
                >
                  <div className="field" style={{ marginBottom: 10 }}>
                    <label>Run from a Drive link</label>
                    <input
                      type="text"
                      placeholder="https://drive.google.com/file/d/.../view"
                      value={driveLinkInput}
                      onChange={(e) => setDriveLinkInput(e.target.value)}
                    />
                  </div>
                  <button type="submit" className="btn btn-ghost" style={{ width: '100%' }} disabled={isBusy || !driveLinkInput.trim()}>
                    {runningFileId === 'link' ? 'Running...' : 'Run from link'}
                  </button>
                </form>
              </div>

              <div className="panel">
                <div className="eyebrow">Run options</div>
                <div className="field">
                  <label>Brief for this piece</label>
                  <textarea
                    placeholder="e.g. This is Amara's semifinal round. Focus on the trust problem she solved, not the numbers slide."
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    rows={4}
                  />
                </div>
                <div className="field">
                  <label>Title direction</label>
                  <input
                    type="text"
                    placeholder="e.g. lean into the founder's mother"
                    value={titleHint}
                    onChange={(e) => setTitleHint(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>Target length (minutes)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="e.g. 3"
                    value={targetLengthMinutes}
                    onChange={(e) => setTargetLengthMinutes(e.target.value)}
                  />
                  <div className="hint">
                    Shapes how many beats get built and how tightly they&apos;re paced. Short-form
                    clips stay 15-60s regardless.
                  </div>
                </div>

                <div className="field">
                  <label>Reference docs (optional)</label>
                  <input
                    type="file"
                    multiple
                    accept=".txt,.md,.docx"
                    onChange={(e) => {
                      handleReferenceUpload(e.target.files);
                      e.target.value = '';
                    }}
                    disabled={referenceUploadBusy}
                  />
                  <div className="hint">Style/soundbite guides, not facts about this footage. .txt, .md, .docx.</div>
                  {referenceUploadBusy && <div className="hint">Reading file(s)...</div>}
                </div>

                <div className="field">
                  <label>Or a reference video link</label>
                  <form onSubmit={handleAddReferenceVideo} style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      placeholder="https://www.youtube.com/watch?v=..."
                      value={referenceVideoUrl}
                      onChange={(e) => setReferenceVideoUrl(e.target.value)}
                      disabled={referenceVideoBusy}
                      style={{ flex: 1, marginBottom: 0 }}
                    />
                    <button
                      type="submit"
                      className="btn btn-ghost"
                      style={{ flex: 'none' }}
                      disabled={referenceVideoBusy || !referenceVideoUrl.trim()}
                    >
                      {referenceVideoBusy ? '...' : 'Add'}
                    </button>
                  </form>
                </div>

                {referenceDocs.length > 0 && (
                  <div className="field">
                    {referenceDocs.map((d) => (
                      <div
                        key={d.filename}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '6px 0',
                          borderBottom: '1px solid var(--hairline)',
                        }}
                      >
                        <span className="muted" style={{ fontSize: 11.5 }}>
                          {d.filename} · {d.text.length.toLocaleString()} chars
                        </span>
                        <button
                          className="btn btn-ghost"
                          style={{ flex: 'none', padding: '3px 8px', fontSize: 11 }}
                          onClick={() => removeReferenceDoc(d.filename)}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    {(() => {
                      const total = referenceDocs.reduce((sum, d) => sum + d.text.length, 0);
                      return total > MAX_REFERENCE_CHARS ? (
                        <p className="muted" style={{ color: 'var(--danger)', marginTop: 6 }}>
                          Combined reference material is {total.toLocaleString()} characters; only
                          the first {MAX_REFERENCE_CHARS.toLocaleString()} are sent per run.
                        </p>
                      ) : null;
                    })()}
                  </div>
                )}

                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Local media path (for Final Cut)</label>
                  <input
                    type="text"
                    placeholder="/Users/editor/Movies/ABH_Footage/"
                    value={localMediaPath}
                    onChange={(e) => setLocalMediaPath(e.target.value)}
                  />
                  <div className="hint">
                    The .fcpxml references the source by this path so Final Cut can conform it.
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* RIGHT: processing / result / history */}
        <div className="panel" id="output-panel">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 18 }}>
            <div className="view-toggle">
              <button className={view === 'processing' ? 'active' : ''} onClick={() => setView('processing')}>
                Processing
              </button>
              <button className={view === 'result' ? 'active' : ''} onClick={() => setView('result')}>
                Result
              </button>
              <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>
                History{results.length > 0 ? ` (${results.length})` : ''}
              </button>
            </div>
          </div>

          {view === 'processing' &&
            (runningFileId ? (
              <div>
                <div className="proc-head">
                  <div className="proc-file mono">{runningLabel}</div>
                  <h2 className="proc-title">Processing footage{paused ? ' (paused)' : ''}</h2>
                  <div className="proc-sub">
                    {batchProgress ? `${batchProgress.current}/${batchProgress.total} selected · ` : ''}
                    elapsed {formatDuration(elapsedSeconds)}
                  </div>
                </div>

                <div className="steps">
                  {STEP_GROUPS.map((group, i) => {
                    const stepStatus = getStepStatus(i, currentGroupIndex);
                    const duration = getStepDurationSeconds(i, progressLog);
                    return (
                      <div className={`step ${stepStatus}`} key={group.label}>
                        <div className="step-marker">
                          {stepStatus === 'done' ? '✓' : stepStatus === 'active' ? '↻' : i + 1}
                        </div>
                        <div className="step-body">
                          <div className="step-name">
                            {group.label}
                            <span className="step-time">
                              {stepStatus === 'done'
                                ? duration !== null
                                  ? formatDuration(duration)
                                  : 'done'
                                : stepStatus === 'active'
                                ? 'running'
                                : 'queued'}
                            </span>
                          </div>
                          <div className="step-detail">
                            {stepStatus === 'active' && progressLog.length > 0
                              ? progressLog[progressLog.length - 1].message
                              : group.detail}
                          </div>
                          {stepStatus === 'active' && (
                            <div className="prog-bar">
                              <div className="prog-fill" style={{ width: `${percent}%` }} />
                            </div>
                          )}
                          {stepStatus === 'active' && group.stages.includes('transcribe') && liveTranscriptLines.length > 0 && (
                            <div className="live-transcript">
                              {liveTranscriptLines.map((l, li) => (
                                <div key={li}>
                                  <span className="tc">{l.timestamp}</span>
                                  {l.text}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="proc-footer">
                  <div className="eta">
                    {estimatedTotalSeconds !== null ? (
                      elapsedSeconds < estimatedTotalSeconds ? (
                        <>
                          Estimated time remaining: <b>~{formatDuration(estimatedTotalSeconds - elapsedSeconds)}</b>
                        </>
                      ) : (
                        <>Almost done (past the ~{formatDuration(estimatedTotalSeconds)} estimate)</>
                      )
                    ) : (
                      <>
                        Elapsed: <b>{formatDuration(elapsedSeconds)}</b> (no estimate yet)
                      </>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn btn-ghost"
                      onClick={() => sendPipelineControl(paused ? 'resume' : 'pause')}
                      disabled={controlBusy}
                    >
                      {paused ? 'Continue' : 'Pause'}
                    </button>
                    <button className="btn btn-ghost" onClick={() => sendPipelineControl('stop')} disabled={controlBusy}>
                      Cancel run
                    </button>
                  </div>
                </div>
                <p className="muted" style={{ marginTop: 10, fontSize: 11.5 }}>
                  Pause/Cancel take effect at the next safe point (between pipeline stages, or
                  between Whisper chunks during transcription), not necessarily instantly mid-step.
                </p>
              </div>
            ) : (
              <p className="muted">
                Nothing is running right now. Select footage on the left and run it to see live
                progress here.
              </p>
            ))}

          {view === 'result' &&
            (displayedResult ? (
              <div>
                <div className="video-id mono">{displayedResult.sourceFileName}</div>
                <div className="video-head">
                  <div>
                    <h1 className="title">{displayedResult.narrative.title}</h1>
                    <p className="summary">{displayedResult.narrative.logline}</p>
                    {displayedResult.narrative.titleOptions && displayedResult.narrative.titleOptions.length > 1 && (
                      <div className="alt-titles">
                        {displayedResult.narrative.titleOptions.slice(1).map((t, i) => (
                          <span className="alt-title-chip" key={i}>
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {displayedResult.archived && (
                  <p className="muted" style={{ marginTop: 8 }}>
                    This run&apos;s files were moved to your Drive&apos;s &quot;ABH Pipeline
                    Archive&quot; folder. The buttons below open them there.
                  </p>
                )}

                <div className="export-row">
                  {displayedResult.docxBase64 ? (
                    <div
                      className="export-btn"
                      onClick={() =>
                        downloadBase64(
                          displayedResult.docxFilename,
                          displayedResult.docxBase64!,
                          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                        )
                      }
                    >
                      <span className="ext">.docx</span> Narrative
                    </div>
                  ) : displayedResult.archived?.docxLink ? (
                    <a href={displayedResult.archived.docxLink} target="_blank" rel="noreferrer">
                      <div className="export-btn">
                        <span className="ext">.docx</span> Narrative (Drive)
                      </div>
                    </a>
                  ) : null}
                  {displayedResult.fcpxmlBase64 ? (
                    <div
                      className="export-btn"
                      onClick={() => downloadBase64(displayedResult.fcpxmlFilename, displayedResult.fcpxmlBase64!, 'application/xml')}
                    >
                      <span className="ext">.fcpxml</span> Final Cut
                    </div>
                  ) : displayedResult.archived?.fcpxmlLink ? (
                    <a href={displayedResult.archived.fcpxmlLink} target="_blank" rel="noreferrer">
                      <div className="export-btn">
                        <span className="ext">.fcpxml</span> Final Cut (Drive)
                      </div>
                    </a>
                  ) : null}
                  {displayedResult.srtBase64 ? (
                    <div
                      className="export-btn"
                      onClick={() => downloadBase64(displayedResult.srtFilename, displayedResult.srtBase64!, 'application/x-subrip')}
                    >
                      <span className="ext">.srt</span> Subtitles
                    </div>
                  ) : displayedResult.archived?.srtLink ? (
                    <a href={displayedResult.archived.srtLink} target="_blank" rel="noreferrer">
                      <div className="export-btn">
                        <span className="ext">.srt</span> Subtitles (Drive)
                      </div>
                    </a>
                  ) : null}
                </div>

                <div className="divider"></div>

                <h2 className="section-head">Narrative sections</h2>
                {displayedResult.narrative.sections.map((s, i) => (
                  <div className="beat" key={i}>
                    <div className="beat-title">{s.heading}</div>
                    <div className="beat-text">{s.narrative}</div>
                    <div className="tc-row">
                      {s.citations.map((c, j) => (
                        <span className="tc-chip" key={j}>
                          {c.timestamp}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}

                <div className="divider"></div>

                <div className="eyebrow" style={{ marginBottom: 16 }}>
                  Short-form picks <span className="count">{displayedResult.clips.length}</span>
                  {displayedResult.rejectedClipCount > 0 && (
                    <span style={{ fontFamily: 'inherit', textTransform: 'none', letterSpacing: 0 }}>
                      {displayedResult.rejectedClipCount} filtered out
                    </span>
                  )}
                </div>
                {displayedResult.clips.length === 0 ? (
                  <p className="muted">No self-contained 15-60s moments were flagged.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: '26%' }}>Title</th>
                        <th style={{ width: '14%' }}>In / Out</th>
                        <th style={{ width: '28%' }}>Hook / idea / payoff</th>
                        <th>Rationale</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedResult.clips.map((c, i) => (
                        <tr key={i}>
                          <td className="clip-title-cell">
                            {c.title}
                            {c.titleOptions && c.titleOptions.length > 1 && (
                              <span className="alt">or: {c.titleOptions.slice(1).join(' / ')}</span>
                            )}
                          </td>
                          <td className="io-cell">
                            {c.startTimestamp}
                            <br />
                            {c.endTimestamp}
                          </td>
                          <td className="hook-cell">
                            <b>{c.hook}</b> {c.singleIdea}
                          </td>
                          <td className="rationale-cell">{c.rationale}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : (
              <p className="muted">
                No results yet. Run some footage from the left panel to see the narrative breakdown
                here.
              </p>
            ))}

          {view === 'history' && (
            <div>
              <input
                className="search-input"
                placeholder="Search by title, file name, or clip name..."
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
              />
              {results.length === 0 && (
                <p className="muted">
                  Nothing here yet. Finished runs will show up here and stay saved across
                  refreshes.
                </p>
              )}
              {results.length > 0 && filteredHistory.length === 0 && (
                <p className="muted">No past runs match &quot;{historySearch}&quot;.</p>
              )}
              {filteredHistory.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                  <button
                    className="btn btn-danger"
                    style={{ flex: 'none' }}
                    onClick={() => {
                      if (window.confirm('Clear all saved renders? This cannot be undone.')) {
                        setResults([]);
                        setExpandedResult(0);
                      }
                    }}
                  >
                    Clear history
                  </button>
                </div>
              )}
              {filteredHistory.map((r, idx) => (
                <div className="history-row" key={idx}>
                  <div
                    className="history-meta"
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      setExpandedResult(results.indexOf(r));
                      setView('result');
                    }}
                  >
                    <div className="history-sub">{r.sourceFileName}</div>
                    <div className="history-title">{r.narrative.title}</div>
                    <div className="history-stats">
                      {r.completedAt ? new Date(r.completedAt).toLocaleString() : ''}
                      {r.runtimeSec ? ` · ${formatDuration(r.runtimeSec)} runtime` : ''}
                      {` · ${r.narrative.sections.length} beats · ${r.clips.length} short-form`}
                    </div>
                  </div>
                  <div className="export-row" style={{ margin: 0 }}>
                    {r.docxBase64 ? (
                      <div
                        className="export-btn"
                        onClick={() =>
                          downloadBase64(
                            r.docxFilename,
                            r.docxBase64!,
                            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                          )
                        }
                      >
                        <span className="ext">.docx</span>
                      </div>
                    ) : r.archived?.docxLink ? (
                      <a href={r.archived.docxLink} target="_blank" rel="noreferrer">
                        <div className="export-btn">
                          <span className="ext">.docx</span>
                        </div>
                      </a>
                    ) : null}
                    {r.fcpxmlBase64 ? (
                      <div className="export-btn" onClick={() => downloadBase64(r.fcpxmlFilename, r.fcpxmlBase64!, 'application/xml')}>
                        <span className="ext">.fcpxml</span>
                      </div>
                    ) : r.archived?.fcpxmlLink ? (
                      <a href={r.archived.fcpxmlLink} target="_blank" rel="noreferrer">
                        <div className="export-btn">
                          <span className="ext">.fcpxml</span>
                        </div>
                      </a>
                    ) : null}
                    {r.srtBase64 ? (
                      <div className="export-btn" onClick={() => downloadBase64(r.srtFilename, r.srtBase64!, 'application/x-subrip')}>
                        <span className="ext">.srt</span>
                      </div>
                    ) : r.archived?.srtLink ? (
                      <a href={r.archived.srtLink} target="_blank" rel="noreferrer">
                        <div className="export-btn">
                          <span className="ext">.srt</span>
                        </div>
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
