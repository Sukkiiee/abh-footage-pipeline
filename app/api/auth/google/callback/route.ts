import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens } from '@/lib/google-drive';
import { readSession, writeSession } from '@/lib/session';
import { config } from '@/lib/config';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const error = req.nextUrl.searchParams.get('error');

  if (error) {
    return NextResponse.redirect(
      `${config.appUrl}/?error=${encodeURIComponent(`Google denied access: ${error}`)}`
    );
  }
  if (!code) {
    return NextResponse.redirect(
      `${config.appUrl}/?error=${encodeURIComponent('No authorization code returned by Google.')}`
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const session = readSession(req);
    const res = NextResponse.redirect(`${config.appUrl}/`);
    writeSession(res, { ...session, tokens });
    return res;
  } catch (err) {
    return NextResponse.redirect(
      `${config.appUrl}/?error=${encodeURIComponent(
        err instanceof Error ? err.message : 'Failed to complete Google sign-in.'
      )}`
    );
  }
}
