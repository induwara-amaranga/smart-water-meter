import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const randomId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;

export const otpCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** Human-friendly claim code like "K7QF-29XM" (no 0/O/1/I to avoid misreading). */
export function claimCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => alphabet[randomInt(0, alphabet.length)];
  return `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`;
}

export const hashSecret = (s: string) => bcrypt.hash(s, 10);
export const verifySecret = (s: string, hash: string) => bcrypt.compare(s, hash);

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
