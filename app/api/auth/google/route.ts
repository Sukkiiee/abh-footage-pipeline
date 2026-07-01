import { NextResponse } from 'next/server';
import { getAuthUrl } from '@/lib/google-drive';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const url = getAuthUrl();
    return NextResponse.redirect(url);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to build Google auth URL.' },
      { status: 500 }
    );
  }
}
