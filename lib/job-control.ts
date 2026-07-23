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

export interface ApprovalResult {
  decision: 'approve' | 'deny';
  /** Optional admin override code the client sent alongside the decision -- see lib/config.ts's anthropicAdminCode and lib/llm.ts's spend-cap gate. */
  adminCode?: string;
}

interface JobState {
  paused: boolean;
  controller: AbortController;
  resumeWaiters: Array<() => void>;
  approvalWaiters: Array<(result: ApprovalResult) => void>;
}

// Attached to globalThis rather than a plain module-level variable.
// Confirmed in practice: Next.js's dev server can compile each API route
// into its own isolated module bundle, so a plain `const jobs = new Map()`
// here was NOT guaranteed to be the same object between the route that
// creates a job (app/api/pipeline/run) and the route that controls it
// (app/api/pipeline/control) -- every pause/cancel request failed with
// "that run is no longer active" because it was looking at an empty Map
// of its own, not the one the run route had actually populated. globalThis
// is the one thing genuinely shared across however many times the dev
// bundler re-evaluates this module.
const globalForJobs = globalThis as unknown as { __abhJobs?: Map<string, JobState> };
const jobs = globalForJobs.__abhJobs ?? (globalForJobs.__abhJobs = new Map<string, JobState>());

export function createJob(jobId: string): JobState {
  const state: JobState = {
    paused: false,
    controller: new AbortController(),
    resumeWaiters: [],
    approvalWaiters: [],
  };
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
  // Same for a pending Anthropic cost-approval prompt: resolve it as
  // 'deny' (the free-fallback path) so a Stop click doesn't leave the
  // pipeline hanging on a decision that's now moot.
  const approvalWaiters = job.approvalWaiters.splice(0);
  approvalWaiters.forEach((resolve) => resolve({ decision: 'deny' }));
  return true;
}

/**
 * Blocks until the client responds to an Anthropic cost-approval prompt
 * (see resolveApproval), or the job is stopped (resolves as 'deny', the
 * free-fallback path) or isn't tracked at all (also 'deny' -- safer
 * default than silently spending money with nobody able to approve it).
 */
export function waitForApproval(jobId: string): Promise<ApprovalResult> {
  return new Promise((resolve) => {
    const job = jobs.get(jobId);
    if (!job || job.controller.signal.aborted) {
      resolve({ decision: 'deny' });
      return;
    }
    job.approvalWaiters.push(resolve);
  });
}

/** Returns false if the job isn't currently tracked (e.g. already finished). */
export function resolveApproval(jobId: string, decision: 'approve' | 'deny', adminCode?: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  const waiters = job.approvalWaiters.splice(0);
  waiters.forEach((resolve) => resolve({ decision, adminCode }));
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
