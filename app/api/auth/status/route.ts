import { NextRequest, NextResponse } from 'next/server';
import { readSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const session = readSession(req);
  return NextResponse.json({
    connected: !!session.tokens?.access_token,
    folderId: session.folderId || null,
    folderName: session.folderName || null,
  });
}
