import crypto from 'crypto';
import { config } from './config';

// AES-256-GCM encryption for the session cookie payload. Keeps Google OAuth
// tokens and folder selection out of a plaintext cookie without needing a
// database. SESSION_SECRET must decode (base64 or hex) to exactly 32 bytes.

function getKey(): Buffer {
  const secret = config.sessionSecret;
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(secret)) {
    key = Buffer.from(secret, 'hex');
  } else {
    key = Buffer.from(secret, 'base64');
  }
  if (key.length !== 32) {
    throw new Error(
      'SESSION_SECRET must decode to 32 bytes. Generate one with: openssl rand -base64 32'
    );
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64url');
}

export function decrypt(payload: string): string | null {
  try {
    const key = getKey();
    const raw = Buffer.from(payload, 'base64url');
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    return null;
  }
}
