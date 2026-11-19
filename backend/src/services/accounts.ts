import type { AppContext } from '../context.js';
import type { Db } from '../db/db.js';
import { forbidden, notFound } from '../lib/errors.js';

export interface AccountRow {
  id: string;
  account_no: string;
  holder_name: string;
  address: string;
  zone_id: number | null;
  status: string;
  meter_id: string | null;
  label?: string;
}

/** Customer-facing account JSON (the Flutter app's Account.fromJson). */
export const accountJson = (a: AccountRow) => ({
  id: a.id,
  accountNo: a.account_no,
  label: a.label ?? a.account_no,
  address: a.address,
  meterId: a.meter_id,
  holderName: a.holder_name,
  status: a.status,
});

export async function customerAccounts(db: Db, customerId: string): Promise<AccountRow[]> {
  return db.query<AccountRow>(
    `select a.*, m.label, mt.id as meter_id
     from account_members m join accounts a on a.id = m.account_id
     left join meters mt on mt.account_id = a.id
     where m.customer_id = $1 and a.status <> 'CLOSED'
     order by m.created_at`,
    [customerId],
  );
}

export async function assertAccountAccess(db: Db, customerId: string, accountId: string): Promise<AccountRow> {
  const row = await db.one<AccountRow>(
    `select a.*, m.label, mt.id as meter_id from account_members m join accounts a on a.id = m.account_id
     left join meters mt on mt.account_id = a.id where m.customer_id = $1 and a.id = $2`,
    [customerId, accountId],
  );
  if (!row) throw notFound('Account');
  return row;
}

export async function assertMeterAccess(db: Db, customerId: string, meterId: string): Promise<AccountRow> {
  const row = await db.one<AccountRow>(
    `select a.*, m.label, mt.id as meter_id from meters mt join accounts a on a.id = mt.account_id
     join account_members m on m.account_id = a.id where m.customer_id = $1 and mt.id = $2`,
    [customerId, meterId],
  );
  if (!row) throw notFound('Meter');
  if (row.status === 'CLOSED') throw forbidden('This account is closed');
  return row;
}

export async function nextAccountNo(db: Db): Promise<string> {
  const r = await db.one<{ n: number }>(`select nextval('account_no_seq')::int as n`);
  return `SW-${r!.n}`;
}

// ------------------------------------------------------------------ ledger

/**
 * Account ledger: bills (current charges) + adjustments − payments.
 * Payments and credits are allocated to bills oldest first; each bill is then
 * marked PAID, PUBLISHED (unpaid, not yet due) or OVERDUE.
 */
export async function recomputeAccount(ctx: AppContext, accountId: string, db: Db = ctx.db) {
  const [{ paid, last_paid_at }] = await db.query<{ paid: number; last_paid_at: Date | null }>(
    `select coalesce(sum(amount_cents),0)::int as paid, max(paid_at) as last_paid_at
     from payments where account_id = $1 and status = 'SUCCESS'`,
    [accountId],
  );
  const [{ adj }] = await db.query<{ adj: number }>(
    `select coalesce(sum(amount_cents),0)::int as adj from adjustments where account_id = $1`,
    [accountId],
  );
  const bills = await db.query<{ id: string; current_cents: number; due_date: Date | null; status: string; paid_at: Date | null }>(
    `select id, current_cents, due_date, status, paid_at from bills
     where account_id = $1 and status <> 'DRAFT' order by period`,
    [accountId],
  );

  let available = paid - adj;
  let owed = adj - paid;
  const now = ctx.now();
  for (const b of bills) {
    owed += b.current_cents;
    let status: string;
    let paidAt: Date | null = null;
    if (available >= b.current_cents) {
      available -= b.current_cents;
      status = 'PAID';
      paidAt = b.paid_at ?? last_paid_at ?? now;
    } else {
      available = 0;
      status = b.due_date && new Date(b.due_date) < now ? 'OVERDUE' : 'PUBLISHED';
    }
    if (status !== b.status || (paidAt?.getTime() ?? null) !== (b.paid_at ? new Date(b.paid_at).getTime() : null)) {
      await db.query(`update bills set status = $2, paid_at = $3 where id = $1`, [b.id, status, paidAt]);
    }
  }
  return { owedCents: owed };
}

export async function balance(ctx: AppContext, accountId: string) {
  const { owedCents } = await recomputeAccount(ctx, accountId);
  const last = await ctx.db.one<{ amount_cents: number; paid_at: Date }>(
    `select amount_cents, paid_at from payments where account_id = $1 and status = 'SUCCESS' order by paid_at desc limit 1`,
    [accountId],
  );
  const due = await ctx.db.one<{ due_date: Date }>(
    `select due_date from bills where account_id = $1 and status in ('PUBLISHED','OVERDUE') order by period limit 1`,
    [accountId],
  );
  return {
    amountDueCents: Math.max(0, owedCents),
    creditCents: Math.max(0, -owedCents),
    lastPaymentCents: last?.amount_cents ?? null,
    lastPaymentAt: last?.paid_at ?? null,
    dueDate: due?.due_date ?? null,
  };
}
