import { NextRequest, NextResponse } from 'next/server';
import { requireDrive, NotConnectedError, ensureArchiveFolder, uploadArchiveFile } from '@/lib/google-drive';
import { writeSession } from '@/lib/session';

export const runtime = 'nodejs';

// Called when the client's local run-history storage (localStorage) is
// about to overflow: rather than silently deleting the oldest finished
// runs, their generated files get uploaded here to a Drive folder the app
// manages, and the client keeps only a lightweight link to each instead of
// the full base64 payload. See components/Dashboard.tsx's
// archiveOverflowIfNeeded for the client side of this.
export async function POST(req: NextRequest) {
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

  const { drive, session } = authCtx;

  let body: {
    docxFilename?: string;
    docxBase64?: string;
    fcpxmlFilename?: string;
    fcpxmlBase64?: string;
    srtFilename?: string;
    srtBase64?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const folderId = await ensureArchiveFolder(drive);

    const [docxLink, fcpxmlLink, srtLink] = await Promise.all([
      body.docxFilename && body.docxBase64
        ? uploadArchiveFile(
            drive,
            folderId,
            body.docxFilename,
            body.docxBase64,
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          )
        : Promise.resolve(undefined),
      body.fcpxmlFilename && body.fcpxmlBase64
        ? uploadArchiveFile(drive, folderId, body.fcpxmlFilename, body.fcpxmlBase64, 'application/xml')
        : Promise.resolve(undefined),
      body.srtFilename && body.srtBase64
        ? uploadArchiveFile(drive, folderId, body.srtFilename, body.srtBase64, 'application/x-subrip')
        : Promise.resolve(undefined),
    ]);

    const response = NextResponse.json({
      docxLink: docxLink?.webViewLink,
      fcpxmlLink: fcpxmlLink?.webViewLink,
      srtLink: srtLink?.webViewLink,
    });

    const refreshedTokens = authCtx.finalizeTokens();
    if (refreshedTokens) {
      writeSession(response, { ...session, tokens: refreshedTokens });
    }
    return response;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to archive to Drive.' },
      { status: 500 }
    );
  }
}
