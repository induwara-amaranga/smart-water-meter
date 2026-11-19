import type { AppContext } from '../context.js';
import type { Db } from '../db/db.js';
import type { Reading } from '../mqtt/contract.js';

/**
 * Cumulative meter total (litres) at each instant: the last reading at or
 * before it. Before the first reading, the first reading's total is used, so
 * usage before installation counts as zero. Returns null if there are no readings.
 */
export async function cumulativeAt(db: Db, meterId: string, times: Date[]): Promise<(number | null)[]> {
  if (times.length === 0) return [];
  const rows = await db.query<{ i: number; total: number | null }>(
    `select b.i, coalesce(
        (select r.total_l from readings r where r.meter_id = $1 and r.ts <= b.t order by r.ts desc, r.seq desc limit 1),
        (select r.total_l from readings r where r.meter_id = $1 order by r.ts asc, r.seq asc limit 1)
      ) as total
     from unnest($2::timestamptz[]) with ordinality as b(t, i)
     order by b.i`,
    [meterId, times.map((t) => t.toISOString())],
  );
  return rows.map((r) => (r.total === null ? null : Number(r.total)));
}

/** Litres used in [from, to). */
export async function usageBetween(db: Db, meterId: string, from: Date, to: Date): Promise<number> {
  const [a, b] = await cumulativeAt(db, meterId, [from, to]);
  if (a === null || b === null) return 0;
  return Math.max(0, b - a);
}

export async function monthUsageLiters(ctx: AppContext, meterId: string): Promise<number> {
  const now = ctx.now();
  return usageBetween(ctx.db, meterId, ctx.time.startOfMonth(now), now);
}

export type UsageRange = 'day' | 'week' | 'month';

/** Bucketed usage for the app's Usage tab plus the previous period's total. */
export async function usageSeries(ctx: AppContext, meterId: string, range: UsageRange) {
  const now = ctx.now();
  const t = ctx.time;
  const p = t.parts(now);
  let starts: Date[];
  let prevFrom: Date;
  let prevTo: Date;

  if (range === 'day') {
    starts = Array.from({ length: p.hour + 1 }, (_, h) => t.at(p.year, p.month, p.day, h));
    prevFrom = t.at(p.year, p.month, p.day - 1);
    prevTo = t.at(p.year, p.month, p.day);
  } else if (range === 'week') {
    starts = Array.from({ length: 7 }, (_, i) => t.at(p.year, p.month, p.day - 6 + i));
    prevFrom = t.at(p.year, p.month, p.day - 13);
    prevTo = starts[0];
  } else {
    starts = Array.from({ length: p.day }, (_, i) => t.at(p.year, p.month, i + 1));
    prevFrom = t.at(p.year, p.month - 1, 1);
    prevTo = starts[0];
  }

  const boundaries = [...starts, now, prevFrom, prevTo];
  const totals = await cumulativeAt(ctx.db, meterId, boundaries);
  const diff = (a: number | null, b: number | null) => (a === null || b === null ? 0 : Math.max(0, b - a));

  const points = starts.map((start, i) => ({
    start: start.toISOString(),
    liters: round1(diff(totals[i], totals[i + 1])),
  }));
  const n = starts.length;
  return {
    points,
    totalLiters: round1(diff(totals[0], totals[n])),
    previousTotalLiters: round1(diff(totals[n + 1], totals[n + 2])),
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Store readings idempotently. Duplicates (same meter + seq) are ignored, so
 * QoS 1 redelivery and backlog re-uploads are harmless.
 *
 * Readings with ts = 0 (clock not set) are stored with the receive time as an
 * estimate and fixed later from bootId + upMs (see repairTimestamps).
 */
export async function insertReadings(
  db: Db,
  meterId: string,
  items: Reading[],
  opts: { backlog: boolean; receivedAt: Date },
): Promise<number> {
  let inserted = 0;
  for (const r of items) {
    const estimated = r.ts === 0;
    const ts = estimated ? opts.receivedAt : new Date(r.ts * 1000);
    const rows = await db.query(
      `insert into readings (meter_id, seq, ts, boot_id, up_ms, ts_estimated, total_l, flow_lpm, valve, backlog, received_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict do nothing returning seq`,
      [meterId, r.seq, ts, r.bootId ?? null, r.upMs ?? null, estimated, r.totalL, r.flowLpm ?? null, r.valve ?? null, opts.backlog, opts.receivedAt],
    );
    inserted += rows.length;
  }
  return inserted;
}

/**
 * Once a reading with a real timestamp arrives for a boot session, fix the
 * estimated timestamps of earlier readings from the same boot:
 * ts = anchor.ts - (anchor.upMs - reading.upMs).
 */
export async function repairTimestamps(db: Db, meterId: string, anchor: Reading): Promise<number> {
  if (!anchor.bootId || anchor.upMs === undefined || anchor.ts === 0) return 0;
  const rows = await db.query(
    `update readings set ts = to_timestamp($3::double precision - ($4::double precision - up_ms) / 1000.0),
            ts_estimated = false, ts_corrected = true
     where meter_id = $1 and boot_id = $2 and ts_estimated and up_ms is not null
     returning seq`,
    [meterId, anchor.bootId, anchor.ts, anchor.upMs],
  );
  return rows.length;
}
