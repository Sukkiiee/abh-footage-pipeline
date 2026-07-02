import { NextRequest, NextResponse } from 'next/server';
import { requireDrive, NotConnectedError } from '@/lib/google-drive';
import { buildCombinedFcpxml, CombinedFcpxmlSource } from '@/lib/fcpxml';
import { buildNarrativeDocx } from '@/lib/docx-export';
import { writeSession } from '@/lib/session';
import { config } from '@/lib/config';
import {
  NarrativeResult,
  NarrativeSection,
  ShortFormClip,
  VideoMetadata,
} from '@/lib/types';

export const runtime = 'nodejs';

interface CombineVideoInput {
  sourceFileName: string;
  narrative: NarrativeResult;
  clips: ShortFormClip[];
  metadata: VideoMetadata;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_');
}

/**
 * Merges several already-generated per-video results (narrative + clips +
 * metadata, all produced by /api/pipeline/run) into a single synthesized
 * NarrativeResult -- one section list with each video's sections prefixed
 * by its source filename -- so the existing single-narrative docx builder
 * (and the same result-card UI on the client) can be reused unmodified for
 * a combined document, rather than needing a parallel "combined docx"
 * layout to maintain.
 */
function buildCombinedNarrative(
  videos: CombineVideoInput[],
  titleHint?: string
): NarrativeResult {
  const sections: NarrativeSection[] = [];
  for (const video of videos) {
    for (const section of video.narrative.sections) {
      sections.push({
        heading: `[${video.sourceFileName}] ${section.heading}`,
        narrative: section.narrative,
        citations: section.citations,
      });
    }
  }

  const title =
    titleHint?.trim() || `Combined ABH Narrative (${videos.length} videos)`;
  const logline =
    videos.length === 1
      ? videos[0].narrative.logline
      : `Combined narrative across ${videos.length} videos: ${videos
          .map((v) => v.sourceFileName)
          .join(', ')}.`;

  return {
    title,
    titleOptions: [title],
    logline,
    themes: Array.from(
      new Set(videos.flatMap((v) => v.narrative.themes || []))
    ),
    sections,
    closingLine: videos.length === 1 ? videos[0].narrative.closingLine : undefined,
  };
}

export async function POST(req: NextRequest) {
  let videos: CombineVideoInput[] = [];
  let localMediaPath: string | undefined;
  let titleHint: string | undefined;

  try {
    const body = await req.json();
    videos = Array.isArray(body.videos) ? body.videos : [];
    localMediaPath = body.localMediaPath ? String(body.localMediaPath) : undefined;
    titleHint = body.titleHint ? String(body.titleHint) : undefined;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (videos.length === 0) {
    return NextResponse.json({ error: 'No videos provided to combine.' }, { status: 400 });
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
  const { session } = authCtx;
  const refreshedTokens = authCtx.finalizeTokens();

  try {
    const combinedNarrative = buildCombinedNarrative(videos, titleHint);

    // Tag each clip's rationale with its source video so the combined
    // picks table (and the reused single-narrative docx layout) still
    // shows which footage each clip came from, without changing the
    // shared ShortFormClip type just for this one display case.
    const flattenedClips: ShortFormClip[] = videos.flatMap((video) =>
      video.clips.map((clip) => ({
        ...clip,
        rationale: `[${video.sourceFileName}] ${clip.rationale}`,
      }))
    );

    // When combining, a single "local media path" only makes sense as the
    // folder all the source files live in on the editor's machine -- each
    // asset needs its own full path, built by joining that folder with
    // each video's own filename.
    const baseDir = localMediaPath?.trim() || config.defaultLocalMediaDir;
    const fcpxmlSources: CombinedFcpxmlSource[] = videos.map((video) => ({
      sourceFileName: video.sourceFileName,
      localMediaPath: `${baseDir.replace(/\/+$/, '')}/${video.sourceFileName}`,
      metadata: video.metadata,
      clips: video.clips,
    }));

    const fcpxmlString = buildCombinedFcpxml({
      sources: fcpxmlSources,
      videoTitle: titleHint,
    });

    const docxBuffer = await buildNarrativeDocx({
      sourceFileName: `${videos.length} videos combined`,
      narrative: combinedNarrative,
      clips: flattenedClips,
      generatedAt: new Date(),
    });

    const baseName = sanitizeFileName(
      combinedNarrative.title || `Combined - ${videos.length} videos`
    );

    const res = NextResponse.json({
      narrative: combinedNarrative,
      clips: flattenedClips,
      docxBase64: docxBuffer.toString('base64'),
      fcpxmlBase64: Buffer.from(fcpxmlString, 'utf8').toString('base64'),
      docxFilename: `${baseName} - ABH Narrative.docx`,
      fcpxmlFilename: `${baseName} - Flagged Clips.fcpxml`,
    });

    if (refreshedTokens) {
      writeSession(res, { ...session, tokens: refreshedTokens });
    }
    return res;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to combine results.' },
      { status: 500 }
    );
  }
}
