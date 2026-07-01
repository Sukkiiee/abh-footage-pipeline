import { NextRequest, NextResponse } from 'next/server';
import { encrypt, decrypt } from './crypto';
import { SessionData } from './types';

export const SESSION_COOKIE = 'abh_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function readSession(req: NextRequest): SessionData {
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return {};
  const plaintext = decrypt(raw);
  if (!plaintext) return {};
  try {
    return JSON.parse(plaintext) as SessionData;
  } catch {
    return {};
  }
}

export function writeSession(res: NextResponse, data: SessionData): void {
  const encrypted = encrypt(JSON.stringify(data));
  res.cookies.set(SESSION_COOKIE, encrypted, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export function clearSession(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
