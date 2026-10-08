import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Secrets stored in the database (the AI provider key) are encrypted with AES-256-GCM. The key is derived (HKDF-SHA256)
 * from APP_SECRET, or from AUTH_SECRET when APP_SECRET is not set. Changing the secret makes stored values
 * unreadable; they must then be entered again. Format: `v1:` + base64(iv[12] | tag[16] | ciphertext).
 */
const PREFIX = 'v1:';

/** The server secret, read at call time from the environment (DEC-008). */
export function appSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.APP_SECRET || env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('APP_SECRET (or AUTH_SECRET) must be set, 32 characters or more, to store secrets');
  return secret;
}

const keyFor = (secret: string) => Buffer.from(hkdfSync('sha256', secret, 'ams', 'ai-setting-key', 32));

export function encryptSecret(plain: string, secret: string = appSecret()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decryptSecret(stored: string, secret: string = appSecret()): string {
  if (!stored.startsWith(PREFIX)) throw new Error('unknown secret format');
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(secret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('the saved secret cannot be decrypted (APP_SECRET changed?): enter the key again in Settings -> AI');
  }
}
