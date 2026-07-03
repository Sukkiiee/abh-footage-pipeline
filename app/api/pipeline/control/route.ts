import { NextRequest, NextResponse } from 'next/server';
import { pauseJob, resumeJob, stopJob } from '@/lib/job-control';

export const runtime = 'nodejs';

// A short-lived side-channel request that reaches into an in-flight
// /api/pipeline/run request via the shared in-memory job registry. See
// lib/job-control.ts for how this works and its single-instance caveat.
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

  if (!jobId || !['pause', 'resume', 'stop'].includes(action)) {
    return NextResponse.json(
      { error: 'jobId and a valid action (pause|resume|stop) are required.' },
      { status: 400 }
    );
  }

  const handlers = { pause: pauseJob, resume: resumeJob, stop: stopJob };
  const ok = handlers[action as 'pause' | 'resume' | 'stop'](jobId);

  if (!ok) {
    return NextResponse.json(
      { error: 'That run is no longer active (it may have already finished).' },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}
