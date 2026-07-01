import { NextRequest, NextResponse } from 'next/server';
import {
  requireDrive,
  extractFolderId,
  verifyFolderAccess,
  NotConnectedError,
} from '@/lib/google-drive';
import { writeSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const { session } = await requireDrive(req);
    return NextResponse.json({
      folderId: session.folderId || null,
      folderName: session.folderName || null,
    });
  } catch (err) {
    if (err instanceof NotConnectedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load folder.' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const rawInput = String(body.folder || '').trim();
    if (!rawInput) {
      return NextResponse.json({ error: 'A folder ID or URL is required.' }, { status: 400 });
    }

    const { session, drive, finalizeTokens } = await requireDrive(req);
    const folderId = extractFolderId(rawInput);
    const { id, name } = await verifyFolderAccess(drive, folderId);

    const res = NextResponse.json({ folderId: id, folderName: name });
    const refreshedTokens = finalizeTokens();
    writeSession(res, {
      ...session,
      tokens: refreshedTokens || session.tokens,
      folderId: id,
      folderName: name,
    });
    return res;
  } catch (err) {
    if (err instanceof NotConnectedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to verify folder.' },
      { status: 400 }
    );
  }
}
