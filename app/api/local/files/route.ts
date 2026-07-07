import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { listLocalVideoFilesRecursive } from '@/lib/local-files';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!config.localFootageEnabled) {
    return NextResponse.json(
      {
        error:
          'Local footage is disabled on this deployment. Set ENABLE_LOCAL_FOOTAGE=true in your environment (only appropriate when running this app on your own machine, not a shared hosted deployment) to turn it on.',
      },
      { status: 403 }
    );
  }

  const dir = req.nextUrl.searchParams.get('dir');
  if (!dir || !dir.trim()) {
    return NextResponse.json({ error: 'Provide a folder path.' }, { status: 400 });
  }

  try {
    const result = await listLocalVideoFilesRecursive(dir.trim());
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list that folder.' },
      { status: 400 }
    );
  }
}
