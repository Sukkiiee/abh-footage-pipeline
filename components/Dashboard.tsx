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
  const [progressLog, setProgressLog] = useState<PipelineProgressEvent[]>([]);
  const [percent, setPercent] = useState(0);
  const [results, setResults] = useState<PipelineDone[]>(() => loadResultsHistory());
  const [expandedResult, setExpandedResult] = useState(0);
  const [activeTab, setActiveTab] = useState<'pipeline' | 'history'>('pipeline');
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
            setProgressLog((prev) => [...prev, data as PipelineProgressEvent]);
            setPercent((data as PipelineProgressEvent).percent);
          } else if (eventName === 'done') {
            if (opts?.collect) {
              opts.collect(data as PipelineDone);
            } else {
              setResults((prev) => [data as PipelineDone, ...prev]);
              setExpandedResult(0);
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
            const fullMessage = `${target.displayName}: ${data.message || 'Pipeline failed.'}`;
            setError(fullMessage);
            opts?.onError?.(fullMessage);
          }
        }
      }
    } catch (err) {
      const fullMessage = err instanceof Error ? err.message : 'Pipeline connection failed.';
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
      };

      setResults((prev) => [combined, ...prev]);
      setExpandedResult(0);
      setSelectedIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to combine results.');
    } finally {
      setCombining(false);
    }
  }

  if (status === null) {
    return <div className="muted">Loading...</div>;
  }

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="tab-bar">
        <button
          className={activeTab === 'pipeline' ? 'active' : ''}
          onClick={() => setActiveTab('pipeline')}
        >
          Pipeline
        </button>
        <button
          className={activeTab === 'history' ? 'active' : ''}
          onClick={() => setActiveTab('history')}
        >
          History{results.length > 0 ? ` (${results.length})` : ''}
        </button>
      </div>

      {activeTab === 'pipeline' && (
      <>
      {!status.connected && (
        <div className="card">
          <h2><span className="step-badge">1</span>Connect Google Drive</h2>
          <p className="muted">
            Connect once. This app requests read-only access so it can list and download footage
            from a folder you choose.
          </p>
          <a href="/api/auth/google">
            <button>Connect Google Drive</button>
          </a>
        </div>
      )}

      {status.connected && !status.folderId && (
        <div className="card">
          <h2><span className="step-badge">2</span>Connect a Drive folder</h2>
          <p className="muted">Paste the folder URL or ID that holds your raw footage.</p>
          <form onSubmit={submitFolder}>
            <input
              type="text"
              placeholder="https://drive.google.com/drive/folders/..."
              value={folderInput}
              onChange={(e) => setFolderInput(e.target.value)}
            />
            <button type="submit" disabled={folderBusy}>
              {folderBusy ? 'Verifying...' : 'Connect folder'}
            </button>
          </form>
        </div>
      )}

      {status.connected && status.folderId && (
        <>
          <div className="card">
            <h2>Connected</h2>
            <p className="muted">
              Folder: <strong>{status.folderName}</strong>
            </p>
            <div className="download-row">
              <button className="secondary" onClick={() => setStatus({ ...status, folderId: null, folderName: null })}>
                Change folder
              </button>
              <button className="secondary" onClick={disconnect}>
                Disconnect Drive
              </button>
              <button className="secondary" onClick={refreshFiles}>
                Refresh footage list
              </button>
            </div>
          </div>

          <div className="card">
            <h2>Run options (optional, apply to any run below)</h2>

            <span className="field-label">Title direction (optional)</span>
            <input
              type="text"
              placeholder="e.g. lean into the founder's mother, or the $4,000 number"
              value={titleHint}
              onChange={(e) => setTitleHint(e.target.value)}
            />
            <p className="muted" style={{ marginTop: -6 }}>
              Steers the title options generated below, not a fixed title.
            </p>

            <span className="field-label">Brief for this piece</span>
            <textarea
              placeholder="e.g. This is Amara's semifinal pitch round. Focus on the founder's origin story and the trust problem she solved, not the numbers slide."
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={4}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: 'var(--panel-2)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--text)',
                fontSize: 14,
                marginBottom: 12,
                fontFamily: 'inherit',
                resize: 'vertical',
              }}
            />
            <p className="muted" style={{ marginTop: -6 }}>
              Optional producer context/angle. Leave blank to let the footage speak for itself.
            </p>

            <span className="field-label">Target video length (minutes, optional)</span>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                value={useCustomLength ? 'custom' : targetLengthMinutes || ''}
                onChange={(e) => {
                  if (e.target.value === 'custom') {
                    setUseCustomLength(true);
                    setTargetLengthMinutes('');
                  } else {
                    setUseCustomLength(false);
                    setTargetLengthMinutes(e.target.value);
                  }
                }}
                style={{ maxWidth: 200 }}
              >
                <option value="">No target (let it run naturally)</option>
                {TARGET_LENGTH_PRESETS.map((m) => (
                  <option key={m} value={m}>
                    {m} minute{m === '1' ? '' : 's'}
                  </option>
                ))}
                <option value="custom">Custom...</option>
              </select>
              {useCustomLength && (
                <input
                  type="number"
                  min={1}
                  step={1}
                  placeholder="minutes"
                  value={targetLengthMinutes}
                  onChange={(e) => setTargetLengthMinutes(e.target.value)}
                  style={{ maxWidth: 120, marginBottom: 0 }}
                />
              )}
            </div>
            <p className="muted" style={{ marginTop: 6 }}>
              Paces the long-form outline to roughly this runtime. Short-form clips stay 15-60s regardless.
            </p>

            <span className="field-label">Reference documents (optional)</span>
            <p className="muted" style={{ marginTop: 0 }}>
              Style/soundbite guides, not facts about this footage. .txt, .md, .docx (no PDF yet).
            </p>
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
            {referenceUploadBusy && <p className="muted">Reading file(s)...</p>}

            <p className="muted" style={{ marginTop: 12, marginBottom: 4 }}>
              Or add a video link (YouTube, Instagram, Drive, etc.) -- transcribed the same way as your footage. YouTube is most reliable.
            </p>
            <form onSubmit={handleAddReferenceVideo}>
              <input
                type="text"
                placeholder="https://www.youtube.com/watch?v=..."
                value={referenceVideoUrl}
                onChange={(e) => setReferenceVideoUrl(e.target.value)}
                disabled={referenceVideoBusy}
              />
              <button type="submit" disabled={referenceVideoBusy || !referenceVideoUrl.trim()}>
                {referenceVideoBusy ? 'Transcribing video...' : 'Add video'}
              </button>
            </form>

            {referenceDocs.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {referenceDocs.map((d) => (
                  <div
                    key={d.filename}
                    className="file-row"
                    style={{ padding: '8px 0' }}
                  >
                    <span className="file-sub">
                      {d.filename} · {d.text.length.toLocaleString()} chars
                    </span>
                    <button className="secondary" onClick={() => removeReferenceDoc(d.filename)}>
                      Remove
                    </button>
                  </div>
                ))}
                {(() => {
                  const total = referenceDocs.reduce((sum, d) => sum + d.text.length, 0);
                  return total > MAX_REFERENCE_CHARS ? (
                    <p className="muted" style={{ color: 'var(--danger)' }}>
                      Combined reference material is {total.toLocaleString()} characters; only the
                      first {MAX_REFERENCE_CHARS.toLocaleString()} are sent per run.
                    </p>
                  ) : null;
                })()}
              </div>
            )}

            <span className="field-label" style={{ marginTop: 12 }}>Local media path for FCPXML</span>
            <input
              type="text"
              placeholder="/Users/editor/Movies/ABH_Footage/"
              value={localMediaPath}
              onChange={(e) => setLocalMediaPath(e.target.value)}
            />
            <p className="muted" style={{ marginTop: -6 }}>
              The generated .fcpxml references the original source file by path so Final Cut Pro
              can conform it. If left blank it defaults to a placeholder path; Final Cut will
              prompt to relink to the real file location on the editor&apos;s machine either way.
            </p>
          </div>

          <div className="card">
            <h2>Run from a Drive link</h2>
            <p className="muted">
              Paste a share link (or raw file ID) for a specific .mp4/.mov, and run the pipeline
              on it directly, whether or not it&apos;s in the connected folder listed below.
              Access is governed by whatever the connected Drive account can see.
            </p>
            <form onSubmit={runFromLink}>
              <input
                type="text"
                placeholder="https://drive.google.com/file/d/.../view"
                value={driveLinkInput}
                onChange={(e) => setDriveLinkInput(e.target.value)}
              />
              <button type="submit" disabled={isBusy || !driveLinkInput.trim()}>
                {runningFileId === 'link' ? 'Running...' : 'Run from link'}
              </button>
            </form>
          </div>

          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <h2
                style={{ marginBottom: 0, cursor: 'pointer' }}
                onClick={() => setFootageListExpanded((v) => !v)}
              >
                <span className="step-badge">3</span>
                <span className="chevron">{footageListExpanded ? '▾' : '▸'}</span>
                Footage{files ? ` (${files.length})` : ''}
                {selectedIds.size > 0 ? ` · ${selectedIds.size} selected` : ''}
              </h2>
              <button onClick={runSelected} disabled={isBusy || selectedIds.size === 0}>
                {batchActive && batchProgress
                  ? `Processing ${batchProgress.current}/${batchProgress.total}...`
                  : combining
                  ? 'Combining into one document...'
                  : `Run selected (${selectedIds.size})`}
              </button>
            </div>
            <p className="muted">
              Includes footage in subfolders of the connected folder, not just files at the top
              level. Check the files you want, then run them together -- if you select more than
              one, the results combine into a single .docx / .fcpxml / .srt instead of one set
              per video. Click the heading above to collapse/expand the list.
            </p>
            {files && files.length > 0 && (
              <div className="segmented" style={{ marginBottom: 8 }}>
                <button
                  className="secondary"
                  onClick={() => setSelectedIds(new Set(files.filter((f) => !processedMap[f.id]).map((f) => f.id)))}
                  disabled={isBusy}
                >
                  Select all new
                </button>
                <button
                  className="secondary"
                  onClick={() => setSelectedIds(new Set(files.map((f) => f.id)))}
                  disabled={isBusy}
                >
                  Select all
                </button>
                <button className="secondary" onClick={() => setSelectedIds(new Set())} disabled={isBusy}>
                  Clear selection
                </button>
              </div>
            )}
            {filesTruncated && (
              <p className="muted" style={{ color: 'var(--danger)' }}>
                This folder tree is large enough that the list below may be incomplete (a safety
                cap was hit while scanning subfolders). Use a more specific subfolder link, or the
                &quot;Run from a Drive link&quot; card above for a specific file, if what you need
                isn&apos;t showing.
              </p>
            )}
            {!files && <p className="muted">Loading footage...</p>}
            {files && files.length === 0 && <p className="muted">No .mp4/.mov files found in this folder or its subfolders.</p>}
            {footageListExpanded && (
              <div style={{ maxHeight: 480, overflowY: 'auto' }}>
                {files &&
                  files.map((f) => {
                    const isProcessed = !!processedMap[f.id];
                    const isRunning = runningFileId === f.id;
                    const estimate = f.size ? estimateDurationSeconds(Number(f.size)) : null;
                    return (
                      <label className="file-row" key={f.id} style={{ cursor: isBusy ? 'default' : 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(f.id)}
                          onChange={() => toggleSelected(f.id)}
                          disabled={isBusy}
                          style={{ marginRight: 12 }}
                        />
                        <div className="file-meta">
                          <span className="file-name">
                            {f.name}
                            <span className={`badge ${isProcessed ? 'processed' : 'new'}`}>
                              {isProcessed ? 'Processed' : 'New'}
                            </span>
                            {isRunning && <span className="badge new">Processing now</span>}
                          </span>
                          <span className="file-sub">
                            {f.folderPath ? `${f.folderPath}/ · ` : ''}
                            {formatBytes(f.size)} {f.createdTime ? `· added ${new Date(f.createdTime).toLocaleString()}` : ''}
                            {estimate !== null
                              ? ` · ~${formatDuration(estimate)} estimated`
                              : ' · no time estimate yet (based on past runs on this machine)'}
                          </span>
                        </div>
                      </label>
                    );
                  })}
              </div>
            )}
          </div>
        </>
      )}

      {runningFileId && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ marginBottom: 0 }}>
              {batchProgress
                ? `Batch ${batchProgress.current}/${batchProgress.total} · `
                : ''}
              Pipeline progress{runningLabel ? `: ${runningLabel}` : ''}
              {paused ? ' (paused)' : ''}
            </h2>
            <span className="muted" style={{ fontSize: 13 }}>
              {estimatedTotalSeconds !== null
                ? elapsedSeconds < estimatedTotalSeconds
                  ? `Est. remaining: ${formatDuration(estimatedTotalSeconds - elapsedSeconds)}`
                  : `Est. remaining: almost done (took longer than the ${formatDuration(estimatedTotalSeconds)} estimate)`
                : `Elapsed: ${formatDuration(elapsedSeconds)} (no estimate yet -- based on past runs on this machine)`}
            </span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="download-row" style={{ marginBottom: 12 }}>
            <button
              className="secondary"
              onClick={() => sendPipelineControl(paused ? 'resume' : 'pause')}
              disabled={controlBusy}
            >
              {paused ? 'Continue' : 'Pause'}
            </button>
            <button className="secondary" onClick={() => sendPipelineControl('stop')} disabled={controlBusy}>
              Stop
            </button>
          </div>
          <p className="muted" style={{ marginTop: -6, fontSize: 12 }}>
            Pause/Stop take effect at the next safe point (between pipeline stages, or between
            Whisper chunks during transcription) -- not necessarily instantly mid-step.
          </p>
          {progressLog.map((p, i) => (
            <div key={i} className={`log-line ${i === progressLog.length - 1 ? 'current' : ''}`}>
              [{p.stage}] {p.message}
            </div>
          ))}
        </div>
      )}
      </>
      )}

      {activeTab === 'history' && (
      <>
      {results.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
            <h2 style={{ marginBottom: 0 }}>Past renders ({results.length})</h2>
            <button
              className="secondary"
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
          <p className="muted">
            Saved on this device so a page refresh doesn&apos;t lose your work. Newest first.
            Click a title to expand/collapse it.
          </p>
        </div>
      )}

      {results.length === 0 && (
        <div className="card">
          <h2>Past renders</h2>
          <p className="muted">Nothing here yet. Finished runs from the Pipeline tab will show up here and stay saved across refreshes.</p>
        </div>
      )}

      {results.map((result, idx) => {
        const isExpanded = expandedResult === idx;
        return (
          <div className="card" key={idx}>
            <div
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', cursor: 'pointer' }}
              onClick={() => setExpandedResult(isExpanded ? -1 : idx)}
            >
              <h2 style={{ marginBottom: 0 }}>
                {isExpanded ? '▾' : '▸'} {result.narrative.title}
              </h2>
              <span className="muted" style={{ fontSize: 12 }}>
                {result.sourceFileName}
              </span>
            </div>

            {isExpanded && (
              <>
                <p className="muted">{result.narrative.logline}</p>

                {result.narrative.titleOptions && result.narrative.titleOptions.length > 1 && (
                  <p className="muted">
                    Other title options:{' '}
                    {result.narrative.titleOptions.slice(1).map((t, i) => (
                      <span className="citation" key={i}>
                        {t}
                      </span>
                    ))}
                  </p>
                )}

                {result.archived && (
                  <p className="muted" style={{ marginTop: -4 }}>
                    This run's files were moved to your Drive&apos;s &quot;ABH Pipeline Archive&quot;
                    folder to free up local space. The links below open them there.
                  </p>
                )}
                <div className="download-row">
                  {result.docxBase64 ? (
                    <button
                      onClick={() =>
                        downloadBase64(
                          result.docxFilename,
                          result.docxBase64!,
                          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                        )
                      }
                    >
                      Download .docx
                    </button>
                  ) : result.archived?.docxLink ? (
                    <a href={result.archived.docxLink} target="_blank" rel="noreferrer">
                      <button className="secondary">Open .docx in Drive</button>
                    </a>
                  ) : null}
                  {result.fcpxmlBase64 ? (
                    <button
                      onClick={() => downloadBase64(result.fcpxmlFilename, result.fcpxmlBase64!, 'application/xml')}
                    >
                      Download .fcpxml
                    </button>
                  ) : result.archived?.fcpxmlLink ? (
                    <a href={result.archived.fcpxmlLink} target="_blank" rel="noreferrer">
                      <button className="secondary">Open .fcpxml in Drive</button>
                    </a>
                  ) : null}
                  {result.srtBase64 ? (
                    <button
                      onClick={() => downloadBase64(result.srtFilename, result.srtBase64!, 'application/x-subrip')}
                    >
                      Download .srt
                    </button>
                  ) : result.archived?.srtLink ? (
                    <a href={result.archived.srtLink} target="_blank" rel="noreferrer">
                      <button className="secondary">Open .srt in Drive</button>
                    </a>
                  ) : null}
                </div>

                <h3 style={{ marginTop: 24 }}>Narrative sections</h3>
                {result.narrative.sections.map((s, i) => (
                  <div className="section-block" key={i}>
                    <h3>{s.heading}</h3>
                    <p>{s.narrative}</p>
                    {s.citations.map((c, j) => (
                      <span className="citation" key={j}>
                        {c.timestamp}
                      </span>
                    ))}
                  </div>
                ))}

                <h3 style={{ marginTop: 24 }}>
                  Short-form picks ({result.clips.length})
                  {result.rejectedClipCount > 0 && (
                    <span className="muted"> · {result.rejectedClipCount} candidate(s) filtered out</span>
                  )}
                </h3>
                {result.clips.length === 0 ? (
                  <p className="muted">No self-contained 15-60s moments were flagged.</p>
                ) : (
                  <table className="clips-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Title</th>
                        <th>In</th>
                        <th>Out</th>
                        <th>Hook / Idea / Payoff</th>
                        <th>Rationale</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.clips.map((c, i) => (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td>
                            {c.title}
                            {c.titleOptions && c.titleOptions.length > 1 && (
                              <>
                                <br />
                                <span className="muted" style={{ fontSize: 11 }}>
                                  or: {c.titleOptions.slice(1).join(' / ')}
                                </span>
                              </>
                            )}
                          </td>
                          <td>{c.startTimestamp}</td>
                          <td>{c.endTimestamp}</td>
                          <td>
                            <strong>{c.hook}</strong>
                            <br />
                            {c.singleIdea}
                            <br />
                            <em>{c.payoff}</em>
                          </td>
                          <td>{c.rationale}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>
        );
      })}
      </>
      )}
    </>
  );
}
