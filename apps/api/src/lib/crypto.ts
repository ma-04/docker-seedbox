import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** Derive a 32-byte subkey from APP_SECRET for a named purpose. */
export function deriveKey(appSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', appSecret, 'docker-seedbox', purpose, 32));
}

/** AES-256-GCM. Output: `v1:<iv b64>:<tag b64>:<ciphertext b64>`. */
export function encrypt(appSecret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(appSecret, 'at-rest'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(appSecret: string, blob: string): string {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(appSecret, 'at-rest'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

export const encryptJson = (appSecret: string, value: unknown): string => encrypt(appSecret, JSON.stringify(value));
export const decryptJson = <T>(appSecret: string, blob: string): T => JSON.parse(decrypt(appSecret, blob)) as T;
