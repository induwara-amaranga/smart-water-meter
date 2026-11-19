import type { AppContext } from '../context.js';
import type { Db } from '../db/db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { raiseAlert } from './alerts.js';
import { recomputeAccount } from './accounts.js';
import { type Line, priceSegments, priceUsage, sumCents } from './pricing.js';
import { cumulativeAt } from './readings.js';
import { tariffAt, tariffWindows } from './tariffs.js';

/**
 * Monthly billing cycle (design doc §6):
 *   SNAPSHOT  closing reading of every meter + validation flags
 *   (officer resolves flagged items: accept / estimate / hold)
 *   GENERATED draft bills priced with the tariff(s) in force
 *   APPROVED  by a different officer than the one who generated
 *   PUBLISHED bills locked, customers notified, due date set
 */

export type Flag = 'MISSING' | 'STALE' | 'NEGATIVE' | 'SPIKE';

interface CycleRow {
  id: number;
  period: string;
  period_start: Date;
  period_end: Date;
  state: 'SNAPSHOT' | 'GENERATED' | 'APPROVED' | 'PUBLISHED';
  created_by: string | null;
  generated_by: string | null;
  approved_by: string | null;
  published_by: string | null;
}

interface ItemRow {
  cycle_id: number;
  account_id: string;
  meter_id: string;
  opening_l: number | null;
  closing_l: number | null;
  last_reading_at: Date | null;
  flags: Flag[];
  resolution: 'ACCEPT' | 'ESTIMATE' | 'HOLD' | null;
  note: string | null;
}

async function getCycle(db: Db, id: number): Promise<CycleRow> {
  const c = await db.one<CycleRow>(`select * from billing_cycles where id = $1`, [id]);
  if (!c) throw notFound('Billing cycle');
  return c;
}

async function avgRecentUsageL(db: Db, accountId: string): Promise<number | null> {
  const r = await db.one<{ avg: number | null; n: number }>(
    `select avg(closing_l - opening_l) as avg, count(*)::int as n from
       (select closing_l, opening_l from bills where account_id = $1 and status <> 'DRAFT' order by period desc limit 3) b`,
    [accountId],
  );
  return r && r.n > 0 ? Number(r.avg) : null;
}

export async function createCycle(ctx: AppContext, period: string, staffId: string | null) {
  const { start, end } = ctx.time.monthRange(period);
  if (end > ctx.now()) throw badRequest(`${period} has not ended yet`);
  if (await ctx.db.one(`select 1 from billing_cycles where period = $1`, [period])) throw conflict(`A billing cycle for ${period} already exists`);

  const cycle = await ctx.db.one<CycleRow>(
    `insert into billing_cycles (period, period_start, period_end, state, created_by) values ($1,$2,$3,'SNAPSHOT',$4) returning *`,
    [period, start, end, staffId],
  );
  const accounts = await ctx.db.query<{ account_id: string; meter_id: string }>(
    `select a.id as account_id, m.id as meter_id from accounts a join meters m on m.account_id = a.id
     where a.status in ('ACTIVE','SUSPENDED') order by a.account_no`,
  );

  for (const a of accounts) {
    const prevBill = await ctx.db.one<{ closing_l: number }>(
      `select closing_l from bills where account_id = $1 and period < $2 order by period desc limit 1`,
      [a.account_id, period],
    );
    const [startTotal, endTotal] = await cumulativeAt(ctx.db, a.meter_id, [start, end]);
    const last = await ctx.db.one<{ ts: Date }>(
      `select ts from readings where meter_id = $1 and ts < $2 order by ts desc limit 1`,
      [a.meter_id, end],
    );
    const opening = prevBill?.closing_l ?? startTotal;
    const closing = endTotal;
    const flags: Flag[] = [];
    if (closing === null || opening === null || !last) flags.push('MISSING');
    else {
      if (end.getTime() - new Date(last.ts).getTime() > 24 * 3600_000) flags.push('STALE');
      if (closing < opening - 1) flags.push('NEGATIVE');
      const avg = await avgRecentUsageL(ctx.db, a.account_id);
      if (avg !== null && avg > 0 && closing - opening > Math.max(3 * avg, 5000)) flags.push('SPIKE');
    }
    await ctx.db.query(
      `insert into billing_cycle_items (cycle_id, account_id, meter_id, opening_l, closing_l, last_reading_at, flags, resolution)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [cycle!.id, a.account_id, a.meter_id, opening, closing, last?.ts ?? null, flags, flags.length ? null : 'ACCEPT'],
    );
  }
  return cycleSummary(ctx, cycle!.id);
}

export async function resolveItem(
  ctx: AppContext,
  cycleId: number,
  accountId: string,
  input: { resolution: 'ACCEPT' | 'ESTIMATE' | 'HOLD'; closingL?: number; note?: string },
) {
  const cycle = await getCycle(ctx.db, cycleId);
  if (cycle.state !== 'SNAPSHOT') throw conflict('Exceptions can only be changed before bills are generated');
  const item = await ctx.db.one<ItemRow>(`select * from billing_cycle_items where cycle_id = $1 and account_id = $2`, [cycleId, accountId]);
  if (!item) throw notFound('Billing item');

  let closing = item.closing_l;
  if (input.resolution === 'ESTIMATE') {
    if (input.closingL !== undefined) closing = input.closingL;
    else {
      const avg = (await avgRecentUsageL(ctx.db, accountId)) ?? 0;
      closing = (item.opening_l ?? 0) + avg;
    }
  }
  if (input.resolution === 'ACCEPT' && (item.flags.includes('MISSING') || item.flags.includes('NEGATIVE'))) {
    throw badRequest('Missing or negative readings cannot be accepted as-is. Estimate or hold this bill.');
  }
  if (closing !== null && item.opening_l !== null && closing < item.opening_l) throw badRequest('Closing reading cannot be below the opening reading');

  await ctx.db.query(
    `update billing_cycle_items set resolution = $3, closing_l = $4, opening_l = coalesce(opening_l, $4), note = $5
     where cycle_id = $1 and account_id = $2`,
    [cycleId, accountId, input.resolution, closing, input.note ?? null],
  );
}

/** Price one account's period, splitting at tariff changes. */
async function priceItem(ctx: AppContext, item: ItemRow, start: Date, end: Date): Promise<Line[]> {
  const usageL = Math.max(0, (item.closing_l ?? 0) - (item.opening_l ?? 0));
  const windows = await tariffWindows(ctx.db, start, end);
  if (windows.length === 1) return priceSegments([{ tariff: windows[0].tariff, usageM3: usageL / 1000, fraction: 1 }]);

  // Usage per tariff window from readings, scaled so the parts add up to the billed total.
  const bounds = [windows[0].from, ...windows.map((w) => w.to)];
  const totals = await cumulativeAt(ctx.db, item.meter_id, bounds);
  const raw = windows.map((_, i) => Math.max(0, (totals[i + 1] ?? 0) - (totals[i] ?? 0)));
  const rawSum = raw.reduce((s, v) => s + v, 0);
  return priceSegments(
    windows.map((w, i) => ({
      tariff: w.tariff,
      usageM3: (rawSum > 0 ? (raw[i] / rawSum) * usageL : usageL * w.fraction) / 1000,
      fraction: w.fraction,
    })),
  );
}

export async function generateBills(ctx: AppContext, cycleId: number, staffId: string | null) {
  const cycle = await getCycle(ctx.db, cycleId);
  if (cycle.state !== 'SNAPSHOT' && cycle.state !== 'GENERATED') throw conflict(`Cycle is already ${cycle.state.toLowerCase()}`);
  const items = await ctx.db.query<ItemRow>(`select * from billing_cycle_items where cycle_id = $1`, [cycleId]);
  const open = items.filter((i) => i.resolution === null);
  if (open.length) throw conflict(`${open.length} flagged account(s) still need a decision in the exceptions queue`);

  await ctx.db.query(`delete from bills where cycle_id = $1 and status = 'DRAFT'`, [cycleId]);
  const start = new Date(cycle.period_start);
  const end = new Date(cycle.period_end);
  let count = 0;

  for (const item of items) {
    if (item.resolution === 'HOLD') continue;
    const lines = await priceItem(ctx, item, start, end);
    const current = sumCents(lines);
    const { owedCents } = await recomputeAccount(ctx, item.account_id);
    if (owedCents > 0) lines.push({ kind: 'ARREARS', description: 'Arrears brought forward', amountCents: owedCents });
    if (owedCents < 0) lines.push({ kind: 'ADJUSTMENT', description: 'Credit brought forward', amountCents: owedCents });

    const synced = await ctx.db.one(
      `select 1 from readings where meter_id = $1 and ts >= $2 and ts < $3 and (backlog or ts_corrected) limit 1`,
      [item.meter_id, start, end],
    );
    const basis = item.resolution === 'ESTIMATE' ? 'ESTIMATED' : synced ? 'SD_SYNCED' : 'LIVE';

    await ctx.db.tx(async (t) => {
      const bill = await t.one<{ id: string }>(
        `insert into bills (account_id, cycle_id, period, opening_l, closing_l, status, data_basis, current_cents, arrears_cents, total_cents, reading_date)
         values ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,$9,$10) returning id`,
        [item.account_id, cycleId, cycle.period, item.opening_l ?? 0, item.closing_l ?? item.opening_l ?? 0, basis, current, owedCents, current + owedCents, item.last_reading_at ?? end],
      );
      for (const [i, l] of lines.entries()) {
        await t.query(
          `insert into bill_lines (bill_id, position, kind, description, qty_m3, rate_cents, amount_cents, tariff_version_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [bill!.id, i, l.kind, l.description, l.qtyM3 ?? null, l.rateCents ?? null, l.amountCents, l.tariffVersionId ?? null],
        );
      }
    });
    count++;
  }
  await ctx.db.query(`update billing_cycles set state = 'GENERATED', generated_by = $2, generated_at = now() where id = $1`, [cycleId, staffId]);
  return { ...(await cycleSummary(ctx, cycleId)), generated: count };
}

export async function approveCycle(ctx: AppContext, cycleId: number, staffId: string | null) {
  const cycle = await getCycle(ctx.db, cycleId);
  if (cycle.state !== 'GENERATED') throw conflict('Generate the bills before approving');
  if (staffId && cycle.generated_by === staffId) throw forbidden('A different officer must approve the bills they generated');
  await ctx.db.query(`update billing_cycles set state = 'APPROVED', approved_by = $2, approved_at = now() where id = $1`, [cycleId, staffId]);
  return cycleSummary(ctx, cycleId);
}

export async function publishCycle(ctx: AppContext, cycleId: number, staffId: string | null) {
  const cycle = await getCycle(ctx.db, cycleId);
  if (cycle.state !== 'APPROVED') throw conflict('Bills must be approved before publishing');
  const due = new Date(ctx.now().getTime() + ctx.config.BILL_DUE_DAYS * 86400_000);
  const bills = await ctx.db.query<{ id: string; account_id: string; total_cents: number }>(
    `update bills set status = 'PUBLISHED', published_at = now(), due_date = $2 where cycle_id = $1 and status = 'DRAFT'
     returning id, account_id, total_cents`,
    [cycleId, due],
  );
  await ctx.db.query(`update billing_cycles set state = 'PUBLISHED', published_by = $2, published_at = now() where id = $1`, [cycleId, staffId]);
  const monthName = monthLabel(cycle.period);
  for (const b of bills) {
    await recomputeAccount(ctx, b.account_id);
    await raiseAlert(ctx, {
      accountId: b.account_id,
      type: 'BILLING',
      severity: 'INFO',
      title: `Your ${monthName} bill is ready`,
      message: `Amount: Rs. ${(b.total_cents / 100).toFixed(2)}. Due ${due.toDateString()}.`,
      dedupeKey: `bill:${b.id}`,
    });
    ctx.bus.emit('bill:published', { accountId: b.account_id, billId: b.id, period: cycle.period });
  }
  return cycleSummary(ctx, cycleId);
}

export async function cycleSummary(ctx: AppContext, cycleId: number) {
  const c = await getCycle(ctx.db, cycleId);
  const items = await ctx.db.one<{ total: number; flagged: number; unresolved: number; held: number }>(
    `select count(*)::int as total,
            count(*) filter (where cardinality(flags) > 0)::int as flagged,
            count(*) filter (where resolution is null)::int as unresolved,
            count(*) filter (where resolution = 'HOLD')::int as held
     from billing_cycle_items where cycle_id = $1`,
    [cycleId],
  );
  const bills = await ctx.db.one<{ n: number; total: number; usage: number }>(
    `select count(*)::int as n, coalesce(sum(total_cents),0)::int as total, coalesce(sum(closing_l - opening_l),0) as usage
     from bills where cycle_id = $1`,
    [cycleId],
  );
  return {
    id: c.id,
    period: c.period,
    state: c.state,
    periodStart: c.period_start,
    periodEnd: c.period_end,
    createdBy: c.created_by,
    generatedBy: c.generated_by,
    approvedBy: c.approved_by,
    publishedBy: c.published_by,
    accounts: items!.total,
    flagged: items!.flagged,
    unresolved: items!.unresolved,
    held: items!.held,
    bills: bills!.n,
    totalCents: bills!.total,
    usageM3: Math.round((bills!.usage / 1000) * 1000) / 1000,
  };
}

export const cycleItemJson = (i: ItemRow & { account_no?: string; holder_name?: string }) => ({
  accountId: i.account_id,
  accountNo: i.account_no,
  holderName: i.holder_name,
  meterId: i.meter_id,
  openingL: i.opening_l,
  closingL: i.closing_l,
  usageM3: i.opening_l !== null && i.closing_l !== null ? (i.closing_l - i.opening_l) / 1000 : null,
  lastReadingAt: i.last_reading_at,
  flags: i.flags,
  resolution: i.resolution,
  note: i.note,
});

// ------------------------------------------------------------ customer view

export async function billJson(db: Db, bill: any) {
  const lines = await db.query(`select * from bill_lines where bill_id = $1 order by position`, [bill.id]);
  return {
    id: bill.id,
    period: `${bill.period}-01`,
    openingL: bill.opening_l,
    closingL: bill.closing_l,
    usageM3: (bill.closing_l - bill.opening_l) / 1000,
    status: bill.status,
    dataBasis: bill.data_basis,
    currentCents: bill.current_cents,
    arrearsCents: bill.arrears_cents,
    totalCents: bill.total_cents,
    dueDate: bill.due_date,
    paidAt: bill.paid_at,
    readingDate: bill.reading_date,
    publishedAt: bill.published_at,
    lines: lines.map((l: any) => ({
      kind: l.kind,
      description: l.description,
      qtyM3: l.qty_m3,
      rateCents: l.rate_cents,
      amountCents: l.amount_cents,
    })),
  };
}

/** This month so far, priced with the current tariff (shown as "Estimate" in the app). */
export async function currentEstimate(ctx: AppContext, accountId: string, meterId: string) {
  const now = ctx.now();
  const start = ctx.time.startOfMonth(now);
  const [opening, closing] = await cumulativeAt(ctx.db, meterId, [start, now]);
  const usageM3 = Math.max(0, (closing ?? 0) - (opening ?? 0)) / 1000;
  const lines = priceUsage(usageM3, await tariffAt(ctx.db, now));
  const meter = await ctx.db.one<{ last_seen_at: Date | null }>(`select last_seen_at from meters where id = $1`, [meterId]);
  const total = sumCents(lines);
  return {
    id: `${accountId}-estimate`,
    period: `${ctx.time.periodOf(now)}-01`,
    openingL: opening ?? 0,
    closingL: closing ?? 0,
    usageM3,
    status: 'ESTIMATE',
    dataBasis: 'LIVE',
    currentCents: total,
    arrearsCents: 0,
    totalCents: total,
    dueDate: null,
    paidAt: null,
    readingDate: meter?.last_seen_at ?? null,
    lines: lines.map((l) => ({ kind: l.kind, description: l.description, qtyM3: l.qtyM3 ?? null, rateCents: l.rateCents ?? null, amountCents: l.amountCents })),
  };
}

function monthLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
