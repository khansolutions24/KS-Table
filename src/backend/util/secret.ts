// Encryption of stored passwords (AES-256-GCM with a per-user key file in the
// user data directory) and passphrase based encryption for exported files.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let keyFile = '';
let key: Buffer | null = null;

export function initSecrets(userDataDir: string): void {
  keyFile = path.join(userDataDir, 'secret.key');
  key = null;
}

function localKey(): Buffer {
  if (key) return key;
  try {
    const k = fs.readFileSync(keyFile);
    if (k.length === 32) {
      key = k;
      return k;
    }
  } catch {
    // create below
  }
  const k = randomBytes(32);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, k, { mode: 0o600 });
  key = k;
  return k;
}

function seal(plain: string, k: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function open(sealed: string, k: Buffer): string {
  const buf = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export function encryptSecret(plain: string | null | undefined): string {
  if (!plain) return '';
  return 'v1:' + seal(plain, localKey());
}

export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return '';
  if (!stored.startsWith('v1:')) return stored;
  try {
    return open(stored.slice(3), localKey());
  } catch {
    return '';
  }
}

/** Encrypt with a user supplied passphrase (portable, used for connection export). */
export function encryptWithPassphrase(plain: string, passphrase: string, salt: Buffer): string {
  const k = scryptSync(passphrase, salt, 32);
  return seal(plain, k);
}

export function decryptWithPassphrase(sealed: string, passphrase: string, salt: Buffer): string {
  const k = scryptSync(passphrase, salt, 32);
  return open(sealed, k);
}
