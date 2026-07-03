import { NextRequest, NextResponse } from 'next/server';
import { requireDrive, NotConnectedError } from '@/lib/google-drive';
import { extractReferenceFromUrl } from '@/lib/reference-video';
import { writeSession } from '@/lib/session';

export const runtime = 'nodejs';
// Downloading + transcribing a reference video can take a while, same
// class of work as the main pipeline's transcription step.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let url = '';

  try {
    const body = await req.json();
    url = String(body.url || '').trim();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!url) {
    return NextResponse.json({ error: 'A video link is required.' }, { status: 400 });
  }

  let authCtx;
  try {
    authCtx = await requireDrive(req);
  } catch (err) {
    const status = err instanceof NotConnectedError ? 401 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Authorization error.' },
      { status }
    );
  }

  const { drive, session, accessToken } = authCtx;
  const refreshedTokens = authCtx.finalizeTokens();

  try {
    const result = await extractReferenceFromUrl(url, { drive, accessToken });
    const res = NextResponse.json(result);
    if (refreshedTokens) {
      writeSession(res, { ...session, tokens: refreshedTokens });
    }
    return res;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to process that video link.' },
      { status: 500 }
    );
  }
}
