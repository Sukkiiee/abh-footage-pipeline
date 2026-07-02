import { VideoMetadata, ShortFormClip } from './types';

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

interface Fraction {
  num: number;
  den: number;
}

/**
 * ffprobe's r_frame_rate is exactly `num/den` (fps). The exact frame
 * duration is therefore the reciprocal, `den/num` seconds. Using that exact
 * fraction (rather than a rounded decimal fps) keeps every FCPXML time value
 * frame-accurate, which is what real NLEs expect and will otherwise flag as
 * "not frame aligned" on import.
 */
function frameDurationFraction(frameRateNum: number, frameRateDen: number): Fraction {
  const num = frameRateDen;
  const den = frameRateNum;
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

function secondsToFrames(seconds: number, frameRateNum: number, frameRateDen: number): number {
  const fps = frameRateNum / frameRateDen;
  return Math.max(0, Math.round(seconds * fps));
}

/** Renders a frame count as an FCPXML rational time string, e.g. "1001/30000s". */
function frameCountToTime(frames: number, frameDuration: Fraction): string {
  if (frames <= 0) return '0s';
  const totalNum = frames * frameDuration.num;
  const g = gcd(totalNum, frameDuration.den);
  return `${totalNum / g}/${frameDuration.den / g}s`;
}

function xmlEscape(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(str: string, max: number): string {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

export interface FcpxmlOptions {
  sourceFileName: string;
  /** Absolute local path (or file:// URI) where the editor's machine will find the source media. */
  localMediaPath: string;
  metadata: VideoMetadata;
  clips: ShortFormClip[];
  projectName?: string;
  /** User-supplied overall video title, if set. Used to build the default project name and prefix each clip name. */
  videoTitle?: string;
}

/**
 * Builds a valid FCPXML 1.10 document: one asset (the original source
 * file) and one project whose spine contains one asset-clip per flagged
 * short-form moment, laid out back-to-back in transcript order so an
 * editor opens the project and sees every flagged clip on the timeline
 * ready to review, trim, or discard.
 */
export function buildFcpxml(opts: FcpxmlOptions): string {
  const { metadata, clips } = opts;
  const frameDuration = frameDurationFraction(metadata.frameRateNum, metadata.frameRateDen);
  const formatId = 'r1';
  const assetId = 'r2';

  const srcUrl = opts.localMediaPath.startsWith('file://')
    ? opts.localMediaPath
    : `file://${opts.localMediaPath}`;

  const assetDurationFrames = secondsToFrames(
    metadata.durationSec,
    metadata.frameRateNum,
    metadata.frameRateDen
  );
  const assetDuration = frameCountToTime(assetDurationFrames, frameDuration);

  const titlePrefix = opts.videoTitle?.trim() ? `${opts.videoTitle.trim()} - ` : '';
  const projectName =
    opts.projectName || `${titlePrefix}${opts.sourceFileName} - Flagged Short-Form Clips`;

  let offsetFrames = 0;
  const spineItems = clips.map((clip, i) => {
    const inFrames = secondsToFrames(clip.startSec, metadata.frameRateNum, metadata.frameRateDen);
    const outFrames = secondsToFrames(clip.endSec, metadata.frameRateNum, metadata.frameRateDen);
    const durFrames = Math.max(1, outFrames - inFrames);

    const startTime = frameCountToTime(inFrames, frameDuration);
    const durTime = frameCountToTime(durFrames, frameDuration);
    const offsetTime = frameCountToTime(offsetFrames, frameDuration);
    offsetFrames += durFrames;

    const clipName = xmlEscape(
      `${titlePrefix}Clip ${i + 1}: ${truncate(clip.title || clip.hook, 60)}`
    );
    const markerNote = xmlEscape(
      `${clip.title} | Hook: ${truncate(clip.hook, 120)} | Idea: ${truncate(
        clip.singleIdea,
        120
      )} | Payoff: ${truncate(clip.payoff, 120)}`
    );

    return `        <asset-clip ref="${assetId}" offset="${offsetTime}" name="${clipName}" start="${startTime}" duration="${durTime}" format="${formatId}" tcFormat="NDF">
          <marker start="${startTime}" duration="${frameCountToTime(1, frameDuration)}" value="${markerNote}"/>
        </asset-clip>`;
  });

  const totalDuration = frameCountToTime(offsetFrames, frameDuration);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="${formatId}" name="ABHSourceFormat" frameDuration="${frameDuration.num}/${frameDuration.den}s" width="${metadata.width}" height="${metadata.height}"/>
    <asset id="${assetId}" name="${xmlEscape(opts.sourceFileName)}" start="0s" duration="${assetDuration}" hasVideo="1" format="${formatId}" hasAudio="${metadata.hasAudio ? '1' : '0'}" audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${xmlEscape(srcUrl)}"/>
    </asset>
  </resources>
  <library>
    <event name="ABH Flagged Clips">
      <project name="${xmlEscape(projectName)}">
        <sequence format="${formatId}" duration="${totalDuration}" tcStart="0s" tcFormat="NDF">
          <spine>
${spineItems.join('\n')}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

export interface CombinedFcpxmlSource {
  sourceFileName: string;
  /** Absolute local path (or file:// URI) where the editor's machine will find this source's media. */
  localMediaPath: string;
  metadata: VideoMetadata;
  clips: ShortFormClip[];
}

export interface CombinedFcpxmlOptions {
  sources: CombinedFcpxmlSource[];
  projectName?: string;
  /** Overall combined-video title, if set. Prefixes clip names. */
  videoTitle?: string;
}

/**
 * Builds one FCPXML timeline spanning multiple source videos: one <asset>
 * (and its own <format>, since different footage can have different frame
 * rates/resolutions) per source, with every flagged clip from every source
 * laid back-to-back on a single spine, in the order the sources were given.
 *
 * Each asset-clip's own start/duration stay frame-accurate in that clip's
 * *native* frame rate (they're trim points within its own source asset).
 * The running *offset* -- its position on the shared timeline -- is instead
 * expressed in the first source's frame rate, used as the sequence's overall
 * timebase; this is the standard way mixed-frame-rate timelines are
 * conformed in practice, since a single spine can only have one canonical
 * timebase for clip placement even when the clips themselves come from
 * differently-rated sources.
 */
export function buildCombinedFcpxml(opts: CombinedFcpxmlOptions): string {
  const { sources } = opts;
  if (sources.length === 0) {
    throw new Error('buildCombinedFcpxml requires at least one source video.');
  }

  const titlePrefix = opts.videoTitle?.trim() ? `${opts.videoTitle.trim()} - ` : '';
  const projectName =
    opts.projectName ||
    `${titlePrefix}Combined Flagged Short-Form Clips (${sources.length} videos)`;

  const canonical = sources[0].metadata;
  const canonicalFrameDuration = frameDurationFraction(
    canonical.frameRateNum,
    canonical.frameRateDen
  );

  const resourceBlocks: string[] = [];
  const spineItems: string[] = [];
  let offsetSeconds = 0;
  let clipCounter = 0;

  sources.forEach((source, sourceIndex) => {
    const formatId = `f${sourceIndex + 1}`;
    const assetId = `a${sourceIndex + 1}`;
    const frameDuration = frameDurationFraction(
      source.metadata.frameRateNum,
      source.metadata.frameRateDen
    );

    const srcUrl = source.localMediaPath.startsWith('file://')
      ? source.localMediaPath
      : `file://${source.localMediaPath}`;

    const assetDurationFrames = secondsToFrames(
      source.metadata.durationSec,
      source.metadata.frameRateNum,
      source.metadata.frameRateDen
    );
    const assetDuration = frameCountToTime(assetDurationFrames, frameDuration);

    resourceBlocks.push(
      `    <format id="${formatId}" name="ABHSourceFormat${sourceIndex + 1}" frameDuration="${frameDuration.num}/${frameDuration.den}s" width="${source.metadata.width}" height="${source.metadata.height}"/>`,
      `    <asset id="${assetId}" name="${xmlEscape(source.sourceFileName)}" start="0s" duration="${assetDuration}" hasVideo="1" format="${formatId}" hasAudio="${source.metadata.hasAudio ? '1' : '0'}" audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${xmlEscape(srcUrl)}"/>
    </asset>`
    );

    for (const clip of source.clips) {
      clipCounter++;
      const inFrames = secondsToFrames(
        clip.startSec,
        source.metadata.frameRateNum,
        source.metadata.frameRateDen
      );
      const outFrames = secondsToFrames(
        clip.endSec,
        source.metadata.frameRateNum,
        source.metadata.frameRateDen
      );
      const durFrames = Math.max(1, outFrames - inFrames);
      const clipDurationSeconds = durFrames * (frameDuration.num / frameDuration.den);

      const startTime = frameCountToTime(inFrames, frameDuration);
      const durTime = frameCountToTime(durFrames, frameDuration);
      const offsetFrames = secondsToFrames(
        offsetSeconds,
        canonical.frameRateNum,
        canonical.frameRateDen
      );
      const offsetTime = frameCountToTime(offsetFrames, canonicalFrameDuration);

      offsetSeconds += clipDurationSeconds;

      const clipName = xmlEscape(
        `${titlePrefix}Clip ${clipCounter}: ${truncate(clip.title || clip.hook, 50)} [${source.sourceFileName}]`
      );
      const markerNote = xmlEscape(
        `${clip.title} | Source: ${source.sourceFileName} | Hook: ${truncate(
          clip.hook,
          100
        )} | Idea: ${truncate(clip.singleIdea, 100)} | Payoff: ${truncate(clip.payoff, 100)}`
      );

      spineItems.push(
        `        <asset-clip ref="${assetId}" offset="${offsetTime}" name="${clipName}" start="${startTime}" duration="${durTime}" format="${formatId}" tcFormat="NDF">
          <marker start="${startTime}" duration="${frameCountToTime(1, frameDuration)}" value="${markerNote}"/>
        </asset-clip>`
      );
    }
  });

  const totalDurationFrames = secondsToFrames(
    offsetSeconds,
    canonical.frameRateNum,
    canonical.frameRateDen
  );
  const totalDuration = frameCountToTime(totalDurationFrames, canonicalFrameDuration);
  const sequenceFormatId = 'f1';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
${resourceBlocks.join('\n')}
  </resources>
  <library>
    <event name="ABH Flagged Clips (Combined)">
      <project name="${xmlEscape(projectName)}">
        <sequence format="${sequenceFormatId}" duration="${totalDuration}" tcStart="0s" tcFormat="NDF">
          <spine>
${spineItems.join('\n')}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
