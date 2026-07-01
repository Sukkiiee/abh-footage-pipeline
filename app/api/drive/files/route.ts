import { NextRequest, NextResponse } from 'next/server';
import { requireDrive, listVideoFiles, NotConnectedError } from '@/lib/google-drive';
import { writeSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const { session, drive, finalizeTokens } = await requireDrive(req);

    if (!session.folderId) {
      return NextResponse.json({ error: 'No Drive folder connected yet.' }, { status: 400 });
    }

    const files = await listVideoFiles(drive, session.folderId);
    files.sort((a, b) => {
      const at = a.createdTime ? Date.parse(a.createdTime) : 0;
      const bt = b.createdTime ? Date.parse(b.createdTime) : 0;
      return bt - at;
    });

    const res = NextResponse.json({ files });
    const refreshedTokens = finalizeTokens();
    if (refreshedTokens) {
      writeSession(res, { ...session, tokens: refreshedTokens });
    }
    return res;
  } catch (err) {
    if (err instanceof NotConnectedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list footage.' },
      { status: 500 }
    );
  }
}
