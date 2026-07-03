// In-memory registry letting a separate, short-lived control request
// (pause/resume/stop) reach into an already-running pipeline request and
// influence it. This works because both requests land in the same Node
// process -- true locally, and true for a single Vercel serverless
// instance handling one concurrent run. It is NOT guaranteed across
// multiple serverless instances: if a deployment scales to multiple
// concurrent instances, a pause/stop request could land on a different
// instance than the one running the job and silently no-op. Full
// production robustness for that case would need a shared store (e.g.
// Vercel KV) instead of an in-memory Map -- documented in the README as a
// known limitation, not silently pretended away.

export class PipelineAbortedError extends Error {
  constructor() {
    super('Pipeline stopped by user.');
    this.name = 'PipelineAbortedError';
  }
}

interface JobState {
  paused: boolean;
  controller: AbortController;
  resumeWaiters: Array<() => void>;
}

const jobs = new Map<string, JobState>();

export function createJob(jobId: string): JobState {
  const state: JobState = { paused: false, controller: new AbortController(), resumeWaiters: [] };
  jobs.set(jobId, state);
  return state;
}

export function getJobSignal(jobId: string): AbortSignal | undefined {
  return jobs.get(jobId)?.controller.signal;
}

export function removeJob(jobId: string): void {
  jobs.delete(jobId);
}

/** Returns false if the job isn't currently tracked (e.g. already finished). */
export function pauseJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.paused = true;
  return true;
}

export function resumeJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.paused = false;
  const waiters = job.resumeWaiters.splice(0);
  waiters.forEach((resolve) => resolve());
  return true;
}

export function stopJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.controller.abort();
  // Release anything blocked in a pause-wait so it can observe the abort
  // and throw promptly instead of waiting for a resume that isn't coming.
  const waiters = job.resumeWaiters.splice(0);
  waiters.forEach((resolve) => resolve());
  return true;
}

/**
 * Call between pipeline stages (and, ideally, between long-running
 * sub-steps like individual Whisper chunk uploads). Blocks while the job
 * is paused; throws PipelineAbortedError if it's been stopped, either
 * before or during the pause. If the job isn't tracked (shouldn't happen
 * in practice), this is a no-op so a stray call never breaks the pipeline.
 */
export async function checkpoint(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.controller.signal.aborted) throw new PipelineAbortedError();
  while (job.paused) {
    await new Promise<void>((resolve) => job.resumeWaiters.push(resolve));
    if (job.controller.signal.aborted) throw new PipelineAbortedError();
  }
}
