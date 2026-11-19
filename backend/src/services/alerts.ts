import type { AppContext } from '../context.js';
import type { Db } from '../db/db.js';

export type AlertType = 'LEAK' | 'HIGH_USAGE' | 'BUDGET' | 'DEVICE' | 'BILLING' | 'NOTICE';
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface NewAlert {
  accountId: string | null;
  meterId?: string | null;
  type: AlertType;
  severity: Severity;
  title: string;
  message: string;
  /** Alerts with the same key are raised only once (e.g. "leak:SWM-1:2026-11-19"). */
  dedupeKey?: string;
}

const settingFor: Partial<Record<AlertType, string>> = {
  LEAK: 'leak_alerts',
  HIGH_USAGE: 'usage_alerts',
  BUDGET: 'usage_alerts',
  BILLING: 'bill_alerts',
};

/**
 * Store an alert (unless it is a duplicate or the customer turned that alert
 * type off), notify the customer and push it to connected apps/dashboards.
 */
export async function raiseAlert(ctx: AppContext, a: NewAlert, db: Db = ctx.db): Promise<string | null> {
  const setting = settingFor[a.type];
  if (setting && a.accountId) {
    const s = await db.one<Record<string, boolean>>(`select ${setting} as enabled from account_settings where account_id = $1`, [a.accountId]);
    if (s && s.enabled === false) return null;
  }
  const row = await db.one<{ id: string }>(
    `insert into alerts (account_id, meter_id, type, severity, title, message, dedupe_key)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (dedupe_key) do nothing returning id`,
    [a.accountId, a.meterId ?? null, a.type, a.severity, a.title, a.message, a.dedupeKey ?? null],
  );
  if (!row) return null;
  ctx.bus.emit('alert:new', {
    accountId: a.accountId,
    meterId: a.meterId ?? null,
    alertId: row.id,
    type: a.type,
    severity: a.severity,
    title: a.title,
  });
  await notify(ctx, a, db);
  return row.id;
}

export async function resolveAlerts(ctx: AppContext, meterId: string, type: AlertType, db: Db = ctx.db): Promise<number> {
  const rows = await db.query(
    `update alerts set status = 'RESOLVED', resolved_at = now() where meter_id = $1 and type = $2 and status = 'OPEN' returning id`,
    [meterId, type],
  );
  return rows.length;
}

/**
 * Delivery to phones. Push (FCM), SMS and email providers plug in here; until
 * they are configured the message is logged so the flow can be demonstrated.
 */
async function notify(ctx: AppContext, a: NewAlert, db: Db): Promise<void> {
  if (!a.accountId) return;
  const members = await db.query<{ phone: string | null; email: string | null; tokens: string[] }>(
    `select c.phone, c.email, c.fcm_tokens as tokens from account_members m join customers c on c.id = m.customer_id
     where m.account_id = $1`,
    [a.accountId],
  );
  for (const m of members) {
    ctx.log.info({ to: m.phone ?? m.email, devices: m.tokens.length, title: a.title }, 'notify: push');
  }
  if (a.type === 'LEAK' || a.severity === 'CRITICAL') {
    const s = await db.one<{ away_mode: boolean; emergency_contact: string | null }>(
      `select away_mode, emergency_contact from account_settings where account_id = $1`,
      [a.accountId],
    );
    if (s?.away_mode && s.emergency_contact) {
      ctx.log.info({ to: s.emergency_contact, title: a.title }, 'notify: SMS to emergency contact (Away Mode)');
    }
  }
}

export const alertJson = (r: any) => ({
  id: r.id,
  accountId: r.account_id,
  meterId: r.meter_id,
  type: r.type,
  severity: r.severity,
  title: r.title,
  message: r.message,
  status: r.status,
  read: r.read,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});
