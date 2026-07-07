import fs from 'fs';
import path from 'path';
import { DriveVideoFile } from './types';

const VIDEO_EXTENSIONS = ['.mp4', '.mov'];

// Same safety caps as lib/google-drive.ts's recursive Drive walker, for the
// same reason: a pathological folder tree (deeply nested, or huge) can't
// make a single "list footage" request run away.
const RECURSIVE_MAX_FOLDERS = 300;
const RECURSIVE_MAX_DEPTH = 8;
const RECURSIVE_MAX_FILES = 1000;

export interface ListLocalFilesResult {
  files: DriveVideoFile[];
  truncated: boolean;
}

/**
 * Walks a local directory (and every subfolder beneath it) for .mp4/.mov
 * files, mirroring listVideoFilesRecursive's shape and behavior so the
 * existing footage-queue UI can render local and Drive footage
 * interchangeably. Only meaningful when this Next.js process itself is
 * running on the machine that actually has the footage -- see
 * config.localFootageEnabled's guard for why this isn't exposed by default.
 */
export async function listLocalVideoFilesRecursive(rootDir: string): Promise<ListLocalFilesResult> {
  const resolvedRoot = path.resolve(rootDir);
  const rootStat = await fs.promises.stat(resolvedRoot).catch(() => null);

  if (rootStat?.isFile()) {
    // A very natural mistake: pasting the path to the video itself rather
    // than the folder it's in. Point at exactly what to type instead of
    // just rejecting it.
    throw new Error(
      `"${rootDir}" is a file, not a folder. Point this at the folder that contains your videos instead, e.g. "${path.dirname(resolvedRoot)}".`
    );
  }

  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(
      `"${rootDir}" isn't a folder this server process can see. Local footage is read directly off the disk of the machine running this app -- if that's not the machine you're using right now, this won't work; point it at a path that exists on the machine actually running the app.`
    );
  }

  const files: DriveVideoFile[] = [];
  let foldersVisited = 0;
  let truncated = false;

  const queue: { dir: string; relPath: string; depth: number }[] = [
    { dir: resolvedRoot, relPath: '', depth: 0 },
  ];

  while (queue.length > 0) {
    if (files.length >= RECURSIVE_MAX_FILES || foldersVisited >= RECURSIVE_MAX_FOLDERS) {
      truncated = true;
      break;
    }

    const current = queue.shift()!;
    foldersVisited++;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      // Permission denied or the folder vanished mid-walk -- skip it rather
      // than failing the entire listing over one bad subfolder.
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);

      if (entry.isDirectory()) {
        if (current.depth >= RECURSIVE_MAX_DEPTH) continue;
        if (foldersVisited + queue.length >= RECURSIVE_MAX_FOLDERS) {
          truncated = true;
          continue;
        }
        queue.push({
          dir: fullPath,
          relPath: current.relPath ? `${current.relPath}/${entry.name}` : entry.name,
          depth: current.depth + 1,
        });
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!VIDEO_EXTENSIONS.includes(ext)) continue;

      const fileStat = await fs.promises.stat(fullPath).catch(() => null);
      files.push({
        id: fullPath,
        name: entry.name,
        mimeType: ext === '.mov' ? 'video/quicktime' : 'video/mp4',
        size: fileStat ? String(fileStat.size) : undefined,
        createdTime: fileStat?.birthtime?.toISOString(),
        modifiedTime: fileStat?.mtime?.toISOString(),
        folderPath: current.relPath || undefined,
        source: 'local',
        localPath: fullPath,
      });

      if (files.length >= RECURSIVE_MAX_FILES) {
        truncated = true;
        break;
      }
    }
  }

  files.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
  return { files, truncated };
}
