import { google, drive_v3 } from 'googleapis';
import { OAuth2Client, Credentials } from 'google-auth-library';
import { NextRequest } from 'next/server';
import { config } from './config';
import { GoogleTokens, DriveVideoFile, SessionData } from './types';
import { readSession } from './session';

// Read-only is required because we need to list & download arbitrary
// existing footage in a folder the user picks, not just files this app
// creates itself (which is all the narrower drive.file scope would allow).
export const OAUTH_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'];

export function getRedirectUri(): string {
  return `${config.appUrl}/api/auth/google/callback`;
}

export function getOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    getRedirectUri()
  );
}

export function getAuthUrl(): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces a refresh_token every time, needed for "connect once"
    scope: OAUTH_SCOPES,
  });
}

export async function exchangeCodeForTokens(code: string): Promise<GoogleTokens> {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) {
    throw new Error('Google did not return an access token.');
  }
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || undefined,
    expiry_date: tokens.expiry_date || undefined,
    scope: tokens.scope || undefined,
    token_type: tokens.token_type || undefined,
  };
}

export interface AuthorizedDrive {
  drive: drive_v3.Drive;
  oauth2Client: OAuth2Client;
  /** Call after any Drive API usage; returns refreshed tokens if googleapis rotated them. */
  getRefreshedTokens: () => GoogleTokens | null;
}

export function getAuthorizedDrive(tokens: GoogleTokens): AuthorizedDrive {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(tokens as Credentials);

  let refreshed: GoogleTokens | null = null;
  oauth2Client.on('tokens', (newTokens) => {
    refreshed = {
      access_token: newTokens.access_token || tokens.access_token,
      refresh_token: newTokens.refresh_token || tokens.refresh_token,
      expiry_date: newTokens.expiry_date || tokens.expiry_date,
      scope: newTokens.scope || tokens.scope,
      token_type: newTokens.token_type || tokens.token_type,
    };
  });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  return {
    drive,
    oauth2Client,
    getRefreshedTokens: () => refreshed,
  };
}

/** Proactively refreshes the access token if it's expired or about to expire. */
export async function ensureFreshTokens(
  tokens: GoogleTokens
): Promise<GoogleTokens> {
  const isExpiring =
    !tokens.expiry_date || tokens.expiry_date < Date.now() + 60_000;
  if (!isExpiring || !tokens.refresh_token) return tokens;

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(tokens as Credentials);
  const { credentials } = await oauth2Client.refreshAccessToken();
  return {
    access_token: credentials.access_token || tokens.access_token,
    refresh_token: credentials.refresh_token || tokens.refresh_token,
    expiry_date: credentials.expiry_date || tokens.expiry_date,
    scope: credentials.scope || tokens.scope,
    token_type: credentials.token_type || tokens.token_type,
  };
}

/** Accepts a raw folder ID or a full Drive folder URL and returns the ID. */
export function extractFolderId(input: string): string {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch) return idParamMatch[1];
  return trimmed;
}

/**
 * Accepts a raw file ID or a full Drive file share URL (e.g.
 * `.../file/d/ID/view?usp=sharing` or `...?id=ID`) and returns the ID.
 * Lets a user run the pipeline against a specific video by pasting its
 * share link directly, without it needing to be listed via the connected
 * folder first. Access is still governed entirely by the connected
 * account's Drive permissions -- pasting a link to a file that account
 * can't see will simply fail when the API call is made.
 */
export function extractFileId(input: string): string {
  const trimmed = input.trim();
  const fileMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];
  const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch) return idParamMatch[1];
  return trimmed;
}

export async function verifyFolderAccess(
  drive: drive_v3.Drive,
  folderId: string
): Promise<{ id: string; name: string }> {
  const res = await drive.files.get({
    fileId: folderId,
    fields: 'id, name, mimeType',
    supportsAllDrives: true,
  });
  if (res.data.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('The provided ID/URL does not point to a Drive folder.');
  }
  return { id: res.data.id!, name: res.data.name || 'Untitled folder' };
}

export async function listVideoFiles(
  drive: drive_v3.Drive,
  folderId: string
): Promise<DriveVideoFile[]> {
  const mimeQuery = VIDEO_MIME_TYPES.map((m) => `mimeType='${m}'`).join(' or ');
  const q = `'${folderId}' in parents and (${mimeQuery}) and trashed = false`;

  const files: DriveVideoFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q,
      fields:
        'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink)',
      orderBy: 'createdTime desc',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files || []) {
      files.push({
        id: f.id!,
        name: f.name || 'Untitled',
        mimeType: f.mimeType || '',
        size: f.size || undefined,
        createdTime: f.createdTime || undefined,
        modifiedTime: f.modifiedTime || undefined,
        webViewLink: f.webViewLink || undefined,
      });
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return files;
}

async function listSubfolders(
  drive: drive_v3.Drive,
  folderId: string
): Promise<{ id: string; name: string }[]> {
  const q = `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed = false`;
  const subfolders: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files || []) {
      if (f.id) subfolders.push({ id: f.id, name: f.name || 'Untitled folder' });
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return subfolders;
}

// Safety caps so a pathological folder tree (deeply nested, or huge) can't
// make a single "list footage" request run away -- these are generous for
// any realistic footage-organization structure.
const RECURSIVE_MAX_FOLDERS = 300;
const RECURSIVE_MAX_DEPTH = 8;
const RECURSIVE_MAX_FILES = 1000;

export interface ListVideoFilesResult {
  files: DriveVideoFile[];
  /** True if a safety cap was hit before the whole folder tree was walked -- the list may be incomplete. */
  truncated: boolean;
}

/**
 * Walks the connected folder and every subfolder beneath it (breadth-first,
 * capped by depth/folder-count/file-count), collecting every .mp4/.mov
 * found anywhere in the tree. Each result's `folderPath` records which
 * subfolder it came from, relative to the connected root, so the UI can
 * show where a file actually lives.
 */
export async function listVideoFilesRecursive(
  drive: drive_v3.Drive,
  rootFolderId: string
): Promise<ListVideoFilesResult> {
  const files: DriveVideoFile[] = [];
  let foldersVisited = 0;
  let truncated = false;

  const queue: { id: string; path: string; depth: number }[] = [
    { id: rootFolderId, path: '', depth: 0 },
  ];

  while (queue.length > 0) {
    if (files.length >= RECURSIVE_MAX_FILES || foldersVisited >= RECURSIVE_MAX_FOLDERS) {
      truncated = true;
      break;
    }

    const current = queue.shift()!;
    foldersVisited++;

    const videoFilesHere = await listVideoFiles(drive, current.id);
    for (const f of videoFilesHere) {
      files.push({ ...f, folderPath: current.path || undefined });
      if (files.length >= RECURSIVE_MAX_FILES) {
        truncated = true;
        break;
      }
    }

    if (truncated || current.depth >= RECURSIVE_MAX_DEPTH) continue;

    const subfolders = await listSubfolders(drive, current.id);
    for (const sub of subfolders) {
      if (foldersVisited + queue.length >= RECURSIVE_MAX_FOLDERS) {
        truncated = true;
        break;
      }
      queue.push({
        id: sub.id,
        path: current.path ? `${current.path}/${sub.name}` : sub.name,
        depth: current.depth + 1,
      });
    }
  }

  return { files, truncated };
}

export async function getFileMetadata(
  drive: drive_v3.Drive,
  fileId: string
): Promise<DriveVideoFile> {
  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, createdTime, modifiedTime, webViewLink',
    supportsAllDrives: true,
  });
  return {
    id: res.data.id!,
    name: res.data.name || 'Untitled',
    mimeType: res.data.mimeType || '',
    size: res.data.size || undefined,
    createdTime: res.data.createdTime || undefined,
    modifiedTime: res.data.modifiedTime || undefined,
    webViewLink: res.data.webViewLink || undefined,
  };
}

/**
 * Builds the direct Drive media URL for a file's raw bytes, for passing
 * straight to ffmpeg as an HTTP input (with an Authorization header)
 * instead of downloading the whole file through Node first.
 *
 * ffmpeg's own HTTP demuxer supports byte-range requests, so it can seek
 * within the remote file exactly the way it would a local one -- which
 * matters because MP4/MOV containers often store their metadata atom
 * (`moov`) at the end of the file (typical of unprocessed camera footage
 * that hasn't been "web-optimized"/fast-started). A naive forward-only
 * download-then-pipe approach would have no way to jump to that trailing
 * metadata; ffmpeg's range-request seeking handles it transparently. Net
 * effect: the source video is never written to local/serverless disk at
 * all, only the small extracted audio track is.
 */
export function getDriveMediaUrl(fileId: string): string {
  const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`;
}

export class NotConnectedError extends Error {
  constructor() {
    super('Google Drive is not connected yet.');
    this.name = 'NotConnectedError';
  }
}

export interface AuthContext {
  session: SessionData;
  drive: drive_v3.Drive;
  /** The current (freshly-verified) access token -- needed anywhere that talks to Drive outside the googleapis client, e.g. ffmpeg's HTTP input. */
  accessToken: string;
  /** Call after finishing all Drive calls; returns updated tokens if googleapis rotated them, so the caller can persist them to the session cookie. */
  finalizeTokens: () => GoogleTokens | null;
}

/**
 * Central entry point every route handler uses to get an authorized Drive
 * client from the encrypted session cookie. Proactively refreshes an
 * expiring access token before making any calls, and exposes a
 * finalizeTokens() hook so the route can persist rotated tokens back to the
 * cookie on its way out.
 */
export async function requireDrive(req: NextRequest): Promise<AuthContext> {
  const session = readSession(req);
  if (!session.tokens?.access_token) {
    throw new NotConnectedError();
  }

  const freshTokens = await ensureFreshTokens(session.tokens);
  const proactivelyChanged =
    freshTokens.access_token !== session.tokens.access_token;

  const { drive, getRefreshedTokens } = getAuthorizedDrive(freshTokens);

  return {
    session,
    drive,
    accessToken: freshTokens.access_token,
    finalizeTokens: () => getRefreshedTokens() || (proactivelyChanged ? freshTokens : null),
  };
}
