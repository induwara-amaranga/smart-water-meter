import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { type AccessClaims, type Permission, can, verifyAccess } from '../services/auth.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AccessClaims;
  }
}

function bearer(req: Request): string {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw unauthorized();
  return h.slice(7);
}

export const requireCustomer =
  (ctx: AppContext): RequestHandler =>
  (req, _res, next) => {
    const claims = verifyAccess(ctx, bearer(req));
    if (claims.typ !== 'customer') throw forbidden();
    req.auth = claims;
    next();
  };

export const requireStaff =
  (ctx: AppContext): RequestHandler =>
  (req, _res, next) => {
    const claims = verifyAccess(ctx, bearer(req));
    if (claims.typ !== 'staff') throw forbidden();
    req.auth = claims;
    next();
  };

/** Per-route permission check for staff (use after requireStaff). */
export const allow =
  (p: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!can(req.auth?.role, p)) throw forbidden();
    next();
  };

/** A route parameter as a string (Express 5 types allow string[] for wildcard routes). */
export const pid = (req: Request, name = 'id'): string => String(req.params[name]);

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const res = schema.safeParse(data);
  if (!res.success) {
    const first = res.error.issues[0];
    throw badRequest(first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input', res.error.issues);
  }
  return res.data;
}

const REDACT = new Set(['password', 'code', 'refreshToken', 'deviceSecret']);

/** Record every successful staff write in the audit log. */
export const auditStaffWrites =
  (ctx: AppContext): RequestHandler =>
  (req, res, next) => {
    if (req.method === 'GET') return next();
    res.on('finish', () => {
      if (res.statusCode >= 400 || req.auth?.typ !== 'staff') return;
      const body = Object.fromEntries(
        Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, REDACT.has(k) ? '***' : v]),
      );
      const segments = req.path.split('/').filter(Boolean);
      ctx.db
        .query(`insert into audit_logs (actor_type, actor_id, action, entity, entity_id, detail, ip) values ('STAFF',$1,$2,$3,$4,$5,$6)`, [
          req.auth.sub,
          `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`,
          segments[0] ?? null,
          segments[1] ?? null,
          JSON.stringify(body),
          req.ip ?? null,
        ])
        .catch((err) => ctx.log.error({ err }, 'audit: failed to write'));
    });
    next();
  };

export async function audit(ctx: AppContext, req: Request, action: string, entity: string, entityId: string, detail: object = {}) {
  await ctx.db.query(`insert into audit_logs (actor_type, actor_id, action, entity, entity_id, detail, ip) values ($1,$2,$3,$4,$5,$6,$7)`, [
    req.auth?.typ === 'staff' ? 'STAFF' : 'CUSTOMER',
    req.auth?.sub ?? null,
    action,
    entity,
    entityId,
    JSON.stringify(detail),
    req.ip ?? null,
  ]);
}

export const errorHandler =
  (ctx: AppContext) =>
  (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ message: err.message, details: err.details });
      return;
    }
    if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
      res.status(400).json({ message: 'Request body is not valid JSON' });
      return;
    }
    ctx.log.error({ err }, 'http: unhandled error');
    res.status(500).json({ message: 'Something went wrong on our side' });
  };
