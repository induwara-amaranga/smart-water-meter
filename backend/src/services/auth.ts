import jwt from 'jsonwebtoken';
import type { AppContext } from '../context.js';
import { otpCode, randomToken, safeEqual, sha256, verifySecret } from '../lib/crypto.js';
import { HttpError, badRequest, unauthorized } from '../lib/errors.js';

export type StaffRole = 'ADMIN' | 'BILLING_OFFICER' | 'OPERATIONS' | 'CUSTOMER_SERVICE' | 'AUDITOR';

export interface AccessClaims {
  sub: string;
  typ: 'customer' | 'staff';
  role?: StaffRole;
}

const ALL: StaffRole[] = ['ADMIN', 'BILLING_OFFICER', 'OPERATIONS', 'CUSTOMER_SERVICE', 'AUDITOR'];

/** Role → permission map for the water board portal (design doc §6). */
export const PERMISSIONS = {
  'dashboard.view': ALL,
  'customers.view': ALL,
  'customers.manage': ['ADMIN', 'CUSTOMER_SERVICE'],
  'meters.view': ALL,
  'meters.manage': ['ADMIN', 'OPERATIONS'],
  'usage.view': ['ADMIN', 'OPERATIONS', 'BILLING_OFFICER', 'AUDITOR'],
  'tariffs.manage': ['ADMIN', 'BILLING_OFFICER'],
  'tariffs.approve': ['ADMIN'],
  'billing.view': ['ADMIN', 'BILLING_OFFICER', 'CUSTOMER_SERVICE', 'AUDITOR'],
  'billing.run': ['ADMIN', 'BILLING_OFFICER'],
  'payments.manage': ['ADMIN', 'BILLING_OFFICER'],
  'valve.request': ['ADMIN', 'OPERATIONS', 'BILLING_OFFICER'],
  'valve.approve': ['ADMIN', 'OPERATIONS'],
  'alerts.manage': ['ADMIN', 'OPERATIONS', 'CUSTOMER_SERVICE'],
  'tickets.manage': ['ADMIN', 'CUSTOMER_SERVICE', 'OPERATIONS'],
  'notices.manage': ['ADMIN', 'CUSTOMER_SERVICE'],
  'users.manage': ['ADMIN'],
  'audit.view': ['ADMIN', 'AUDITOR'],
} satisfies Record<string, StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export const can = (role: StaffRole | undefined, p: Permission) => !!role && (PERMISSIONS[p] as StaffRole[]).includes(role);

export const permissionsFor = (role: StaffRole) => (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));

// ------------------------------------------------------------------ tokens

export function verifyAccess(ctx: AppContext, token: string): AccessClaims {
  try {
    return jwt.verify(token, ctx.config.JWT_SECRET, { algorithms: ['HS256'] }) as AccessClaims;
  } catch {
    throw unauthorized();
  }
}

export async function issueTokens(ctx: AppContext, claims: AccessClaims) {
  const accessToken = jwt.sign(claims, ctx.config.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ctx.config.ACCESS_TOKEN_TTL_MIN * 60,
  });
  const refreshToken = randomToken(48);
  await ctx.db.query(
    `insert into refresh_tokens (token_hash, subject_type, subject_id, expires_at) values ($1,$2,$3,$4)`,
    [sha256(refreshToken), claims.typ === 'staff' ? 'STAFF' : 'CUSTOMER', claims.sub, new Date(ctx.now().getTime() + ctx.config.REFRESH_TOKEN_TTL_DAYS * 86400_000)],
  );
  return { accessToken, refreshToken, expiresIn: ctx.config.ACCESS_TOKEN_TTL_MIN * 60 };
}

/** Exchange a refresh token for a new pair (the old one is revoked: rotation). */
export async function rotateRefresh(ctx: AppContext, refreshToken: string, expect: 'customer' | 'staff') {
  const row = await ctx.db.one<{ subject_type: string; subject_id: string; expires_at: Date; revoked: boolean }>(
    `update refresh_tokens set revoked = true where token_hash = $1 and not revoked returning *`,
    [sha256(refreshToken)],
  );
  if (!row || new Date(row.expires_at) < ctx.now() || row.subject_type !== expect.toUpperCase()) throw unauthorized();
  if (expect === 'staff') {
    const s = await ctx.db.one<{ role: StaffRole; active: boolean }>(`select role, active from staff_users where id = $1`, [row.subject_id]);
    if (!s?.active) throw unauthorized();
    return issueTokens(ctx, { sub: row.subject_id, typ: 'staff', role: s.role });
  }
  return issueTokens(ctx, { sub: row.subject_id, typ: 'customer' });
}

export async function revokeRefresh(ctx: AppContext, refreshToken: string | undefined) {
  if (refreshToken) await ctx.db.query(`update refresh_tokens set revoked = true where token_hash = $1`, [sha256(refreshToken)]);
}

// --------------------------------------------------------------- customers

/** Normalise "077 123 4567" / "+94771234567" / "Name@Mail.com". */
export function normalizeIdentifier(raw: string): { kind: 'phone' | 'email'; value: string } {
  const s = raw.trim();
  if (s.includes('@')) {
    const email = s.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid email address');
    return { kind: 'email', value: email };
  }
  let digits = s.replace(/[\s()-]/g, '');
  if (/^0\d{9}$/.test(digits)) digits = `+94${digits.slice(1)}`;
  else if (/^94\d{9}$/.test(digits)) digits = `+${digits}`;
  if (!/^\+\d{8,15}$/.test(digits)) throw badRequest('Enter a valid mobile number or email');
  return { kind: 'phone', value: digits };
}

export async function requestOtp(ctx: AppContext, identifier: string) {
  const id = normalizeIdentifier(identifier);
  const recent = await ctx.db.one(`select 1 from otp_codes where identifier = $1 and created_at > $2`, [
    id.value,
    new Date(ctx.now().getTime() - 30_000),
  ]);
  if (recent) throw new HttpError(429, 'Please wait 30 seconds before requesting another code');
  const code = otpCode();
  await ctx.db.query(
    `insert into otp_codes (identifier, code_hash, expires_at, attempts, created_at) values ($1,$2,$3,0,$4)
     on conflict (identifier) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`,
    [id.value, sha256(code), new Date(ctx.now().getTime() + 5 * 60_000), ctx.now()],
  );
  // SMS / email delivery plugs in here. Until a provider is configured the code is logged.
  ctx.log.info({ to: id.value, code: ctx.config.NODE_ENV === 'production' ? '******' : code }, `otp: send via ${id.kind === 'phone' ? 'SMS' : 'email'}`);
}

export async function verifyOtp(ctx: AppContext, identifier: string, code: string) {
  const id = normalizeIdentifier(identifier);
  const devOk = ctx.config.NODE_ENV !== 'production' && !!ctx.config.DEV_OTP && safeEqual(code, ctx.config.DEV_OTP);
  if (!devOk) {
    const row = await ctx.db.one<{ code_hash: string; expires_at: Date; attempts: number }>(
      `update otp_codes set attempts = attempts + 1 where identifier = $1 returning *`,
      [id.value],
    );
    if (!row || new Date(row.expires_at) < ctx.now()) throw badRequest('This code has expired. Request a new one.');
    if (row.attempts > 5) throw new HttpError(429, 'Too many attempts. Request a new code.');
    if (!safeEqual(sha256(code), row.code_hash)) throw badRequest('Incorrect code');
  }
  await ctx.db.query(`delete from otp_codes where identifier = $1`, [id.value]);

  const col = id.kind === 'phone' ? 'phone' : 'email';
  let customer = await ctx.db.one(`select * from customers where ${col} = $1`, [id.value]);
  customer ??= await ctx.db.one(`insert into customers (${col}, name) values ($1, '') returning *`, [id.value]);
  const tokens = await issueTokens(ctx, { sub: customer.id, typ: 'customer' });
  return { ...tokens, customer: customerJson(customer) };
}

export const customerJson = (c: any) => ({ id: c.id, name: c.name || 'Customer', phone: c.phone, email: c.email });

// ------------------------------------------------------------------- staff

export async function staffLogin(ctx: AppContext, email: string, password: string) {
  const s = await ctx.db.one(`select * from staff_users where email = $1`, [email.trim().toLowerCase()]);
  if (!s || !s.active || !(await verifySecret(password, s.password_hash))) throw unauthorized('Email or password is incorrect');
  const tokens = await issueTokens(ctx, { sub: s.id, typ: 'staff', role: s.role });
  return { ...tokens, user: staffJson(s) };
}

export const staffJson = (s: any) => ({
  id: s.id,
  name: s.name,
  email: s.email,
  role: s.role,
  active: s.active,
  permissions: permissionsFor(s.role),
  createdAt: s.created_at,
});
