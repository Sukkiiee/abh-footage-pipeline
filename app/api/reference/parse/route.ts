import { NextRequest, NextResponse } from 'next/server';
import mammoth from 'mammoth';

export const runtime = 'nodejs';

// Extracts plain text from an uploaded reference document so it can be fed
// into the narrative/short-form prompts as style/soundbite guidance. Plain
// text/markdown files are read directly in the browser (no server round
// trip needed); this route only handles formats that need real parsing.
// .docx via mammoth. PDF is intentionally not supported yet -- ask the
// user to convert to .txt/.docx first rather than silently failing.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const filename = String(body.filename || 'reference document');
    const base64 = String(body.base64 || '');

    if (!base64) {
      return NextResponse.json({ error: 'No file content provided.' }, { status: 400 });
    }

    if (!/\.docx$/i.test(filename)) {
      return NextResponse.json(
        { error: `Unsupported reference file type for "${filename}". Only .txt/.md (parsed in-browser) and .docx are supported right now.` },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(base64, 'base64');
    const result = await mammoth.extractRawText({ buffer });
    return NextResponse.json({ text: result.value });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to parse reference document.' },
      { status: 500 }
    );
  }
}
