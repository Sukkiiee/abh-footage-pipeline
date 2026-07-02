'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  DriveVideoFile,
  NarrativeResult,
  ShortFormClip,
  PipelineProgressEvent,
} from '@/lib/types';

interface AuthStatus {
  connected: boolean;
  folderId: string | null;
  folderName: string | null;
}

interface PipelineDone {
  sourceFileName: string;
  narrative: NarrativeResult;
  clips: ShortFormClip[];
  rejectedClipCount: number;
  docxBase64: string;
  fcpxmlBase64: string;
  srtBase64: string;
  docxFilename: string;
  fcpxmlFilename: string;
  srtFilename: string;
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

export default function Dashboard() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folderInput, setFolderInput] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);
  const [files, setFiles] = useState<DriveVideoFile[] | null>(null);
  const [processedMap, setProcessedMap] = useState<Record<string, string>>({});
  const [localMediaPath, setLocalMediaPath] = useState('');
  const [titleHint, setTitleHint] = useState('');
  const [brief, setBrief] = useState('');
  const [targetLengthMinutes, setTargetLengthMinutes] = useState('');
  const [driveLinkInput, setDriveLinkInput] = useState('');

  const [runningFileId, setRunningFileId] = useState<string | null>(null);
  const [runningLabel, setRunningLabel] = useState('');
  const [progressLog, setProgressLog] = useState<PipelineProgressEvent[]>([]);
  const [percent, setPercent] = useState(0);
  const [result, setResult] = useState<PipelineDone | null>(null);

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
    setProcessedMap(loadProcessedMap());
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err) setError(err);
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.connected && status.folderId) {
      refreshFiles();
    }
  }, [status, refreshFiles]);

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

  async function runPipeline(target: { fileId?: string; driveLink?: string; displayName: string }) {
    setError(null);
    setResult(null);
    setProgressLog([]);
    setPercent(0);
    setRunningLabel(target.displayName);
    setRunningFileId(target.fileId || 'link');

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
          targetLengthMinutes:
            parsedTargetLength && Number.isFinite(parsedTargetLength) && parsedTargetLength > 0
              ? parsedTargetLength
              : undefined,
        }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Pipeline failed to start (HTTP ${res.status}).`);
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
            setResult(data as PipelineDone);
            setPercent(100);
            if (target.fileId) {
              markProcessed(target.fileId);
              setProcessedMap(loadProcessedMap());
            }
          } else if (eventName === 'error') {
            setError(data.message || 'Pipeline failed.');
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pipeline connection failed.');
    } finally {
      setRunningFileId(null);
    }
  }

  function runFromLink(e: React.FormEvent) {
    e.preventDefault();
    if (!driveLinkInput.trim()) return;
    runPipeline({ driveLink: driveLinkInput.trim(), displayName: 'video from pasted link' });
  }

  if (status === null) {
    return <div className="muted">Loading...</div>;
  }

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      {!status.connected && (
        <div className="card">
          <h2>Step 1 · Connect Google Drive</h2>
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
          <h2>Step 2 · Connect a Drive folder</h2>
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
              Keywords or an angle to steer title generation, not a fixed title. The pipeline
              generates several title options for the long-form video (and for each short-form
              clip) rather than settling on one; the strongest option is used by default for
              exports/filenames, and every option is shown below once a run finishes.
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
              Passed to the narrative and short-form generation as producer context/angle. Leave
              blank to let the footage speak for itself.
            </p>

            <span className="field-label">Target video length (minutes, optional)</span>
            <input
              type="number"
              min={1}
              step={1}
              placeholder="e.g. 3"
              value={targetLengthMinutes}
              onChange={(e) => setTargetLengthMinutes(e.target.value)}
              style={{ maxWidth: 160 }}
            />
            <p className="muted" style={{ marginTop: -6 }}>
              Guides how many narrative sections/beats get built and how tightly they&apos;re
              paced, so the outline naturally fits roughly this runtime once cut. Doesn&apos;t
              affect short-form clip length (always 15-60s).
            </p>

            <span className="field-label">Local media path for FCPXML</span>
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
              <button type="submit" disabled={runningFileId !== null || !driveLinkInput.trim()}>
                {runningFileId === 'link' ? 'Running...' : 'Run from link'}
              </button>
            </form>
          </div>

          <div className="card">
            <h2>Step 3 · Footage</h2>
            {!files && <p className="muted">Loading footage...</p>}
            {files && files.length === 0 && <p className="muted">No .mp4/.mov files found in this folder.</p>}
            {files &&
              files.map((f) => {
                const isProcessed = !!processedMap[f.id];
                const isRunning = runningFileId === f.id;
                return (
                  <div className="file-row" key={f.id}>
                    <div className="file-meta">
                      <span className="file-name">
                        {f.name}
                        <span className={`badge ${isProcessed ? 'processed' : 'new'}`}>
                          {isProcessed ? 'Processed' : 'New'}
                        </span>
                      </span>
                      <span className="file-sub">
                        {formatBytes(f.size)} {f.createdTime ? `· added ${new Date(f.createdTime).toLocaleString()}` : ''}
                      </span>
                    </div>
                    <button
                      onClick={() => runPipeline({ fileId: f.id, displayName: f.name })}
                      disabled={runningFileId !== null}
                    >
                      {isRunning ? 'Running...' : isProcessed ? 'Re-run' : 'Run pipeline'}
                    </button>
                  </div>
                );
              })}
          </div>
        </>
      )}

      {runningFileId && (
        <div className="card">
          <h2>Pipeline progress{runningLabel ? `: ${runningLabel}` : ''}</h2>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          {progressLog.map((p, i) => (
            <div key={i} className={`log-line ${i === progressLog.length - 1 ? 'current' : ''}`}>
              [{p.stage}] {p.message}
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className="card">
          <h2>Result: {result.narrative.title}</h2>
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

          <div className="download-row">
            <button
              onClick={() =>
                downloadBase64(
                  result.docxFilename,
                  result.docxBase64,
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                )
              }
            >
              Download .docx
            </button>
            <button
              onClick={() => downloadBase64(result.fcpxmlFilename, result.fcpxmlBase64, 'application/xml')}
            >
              Download .fcpxml
            </button>
            <button onClick={() => downloadBase64(result.srtFilename, result.srtBase64, 'application/x-subrip')}>
              Download .srt
            </button>
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
        </div>
      )}
    </>
  );
}
