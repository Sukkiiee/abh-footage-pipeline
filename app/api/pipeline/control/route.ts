import { NextRequest, NextResponse } from 'next/server';
import { pauseJob, resumeJob, stopJob, resolveApproval } from '@/lib/job-control';

export const runtime = 'nodejs';

const ACTIONS = ['pause', 'resume', 'stop', 'approve', 'deny'] as const;
type Action = (typeof ACTIONS)[number];

// A short-lived side-channel request that reaches into an in-flight
// /api/pipeline/run request via the shared in-memory job registry. See
// lib/job-control.ts for how this works and its single-instance caveat.
// approve/deny answer an Anthropic cost-approval prompt (Auto provider
// mode); everything else is the existing pause/resume/stop.
export async function POST(req: NextRequest) {
  let jobId = '';
  let action = '';

  try {
    const body = await req.json();
    jobId = String(body.jobId || '');
    action = String(body.action || '');
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!jobId || !ACTIONS.includes(action as Action)) {
    return NextResponse.json(
      { error: `jobId and a valid action (${ACTIONS.join('|')}) are required.` },
      { status: 400 }
    );
  }

  const handlers = {
    pause: pauseJob,
    resume: resumeJob,
    stop: stopJob,
    approve: (id: string) => resolveApproval(id, 'approve'),
    deny: (id: string) => resolveApproval(id, 'deny'),
  };
  const ok = handlers[action as Action](jobId);

  if (!ok) {
    return NextResponse.json(
      { error: 'That run is no longer active (it may have already finished).' },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}
