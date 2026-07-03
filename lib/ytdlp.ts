import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';

// yt-dlp ships a standalone, self-contained binary per platform (no Python
// needed at runtime) but there's no reliable npm wrapper for it that
// doesn't also demand a `python` binary be on PATH just for its install
// script's version check -- which fails on plain macOS (only `python3`
// exists there by default). This fetches the real GitHub release binary
// directly instead, with its own caching, so it isn't gated on that.

function platformAssetName(): string {
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  if (process.platform === 'win32') return 'yt-dlp.exe';
  return 'yt-dlp_linux';
}

function candidateCacheDirs(): string[] {
  return [
    // Persists across `npm run dev` restarts locally; gitignored.
    path.join(process.cwd(), '.cache', 'yt-dlp'),
    // Falls back here if the project directory isn't writable (e.g. a
    // read-only serverless filesystem outside /tmp).
    path.join(os.tmpdir(), 'abh-yt-dlp-cache'),
  ];
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (targetUrl: string) => {
      https
        .get(targetUrl, (res) => {
          if (
            res.statusCode &&
            [301, 302, 303, 307, 308].includes(res.statusCode) &&
            res.headers.location
          ) {
            request(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Failed to download yt-dlp: HTTP ${res.statusCode}`));
            return;
          }
          const file = fs.createWriteStream(destPath);
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', reject);
        })
        .on('error', reject);
    };
    request(url);
  });
}

let cachedBinaryPath: string | null = null;

/**
 * Returns a path to a working yt-dlp binary, downloading it on first use
 * and caching it thereafter. Set YT_DLP_PATH to skip this entirely and use
 * a binary you've installed yourself (e.g. via `brew install yt-dlp`).
 */
export async function getYtDlpPath(): Promise<string> {
  if (cachedBinaryPath && fs.existsSync(cachedBinaryPath)) return cachedBinaryPath;

  if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
    cachedBinaryPath = process.env.YT_DLP_PATH;
    return cachedBinaryPath;
  }

  const assetName = platformAssetName();
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;
  let lastError: unknown;

  for (const dir of candidateCacheDirs()) {
    const destPath = path.join(dir, assetName);
    try {
      if (fs.existsSync(destPath)) {
        fs.chmodSync(destPath, 0o755);
        cachedBinaryPath = destPath;
        return destPath;
      }
      fs.mkdirSync(dir, { recursive: true });
      await downloadFile(url, destPath);
      fs.chmodSync(destPath, 0o755);
      cachedBinaryPath = destPath;
      return destPath;
    } catch (err) {
      lastError = err;
      continue; // try the next candidate directory
    }
  }

  throw new Error(
    `Could not obtain a yt-dlp binary (${lastError instanceof Error ? lastError.message : 'no writable cache directory'}). Set YT_DLP_PATH to a working yt-dlp binary (e.g. install one with \`brew install yt-dlp\` and point YT_DLP_PATH at it).`
  );
}
