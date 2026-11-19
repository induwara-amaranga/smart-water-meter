import type { Db } from '../db/db.js';
import { notFound } from '../lib/errors.js';
import type { Segment, Slab, TariffDef } from './pricing.js';

interface TariffRow {
  id: number;
  name: string;
  slabs: Slab[];
  service_charge_cents: number;
  effective_from: Date;
  status: string;
  created_by: string | null;
  approved_by: string | null;
  created_at: Date;
  approved_at: Date | null;
}

export const toTariff = (r: TariffRow): TariffDef => ({
  id: r.id,
  name: r.name,
  slabs: r.slabs,
  serviceChargeCents: r.service_charge_cents,
  effectiveFrom: new Date(r.effective_from),
});

/** JSON shape used by the API (the Flutter app's Tariff.fromJson). */
export const tariffJson = (t: TariffDef) => ({
  id: t.id,
  name: t.name,
  slabs: t.slabs,
  serviceChargeCents: t.serviceChargeCents,
  effectiveFrom: t.effectiveFrom.toISOString(),
});

export const adminTariffJson = (r: TariffRow) => ({
  ...tariffJson(toTariff(r)),
  status: r.status,
  createdBy: r.created_by,
  approvedBy: r.approved_by,
  createdAt: r.created_at,
  approvedAt: r.approved_at,
});

/** The approved tariff in force at `at`. */
export async function tariffAt(db: Db, at: Date): Promise<TariffDef> {
  const row = await db.one<TariffRow>(
    `select * from tariff_versions where status = 'APPROVED' and effective_from <= $1
     order by effective_from desc, id desc limit 1`,
    [at],
  );
  if (!row) throw notFound('Active tariff');
  return toTariff(row);
}

/**
 * Tariff segments covering [start, end): one per approved tariff in force
 * during the period. Each has its time window and share of the period.
 */
export async function tariffWindows(
  db: Db,
  start: Date,
  end: Date,
): Promise<{ tariff: TariffDef; from: Date; to: Date; fraction: number }[]> {
  const first = await tariffAt(db, start);
  const later = (
    await db.query<TariffRow>(
      `select * from tariff_versions where status = 'APPROVED' and effective_from > $1 and effective_from < $2
       order by effective_from, id`,
      [start, end],
    )
  ).map(toTariff);
  const all = [first, ...later];
  const total = end.getTime() - start.getTime();
  return all.map((t, i) => {
    const from = i === 0 ? start : t.effectiveFrom;
    const to = i + 1 < all.length ? all[i + 1].effectiveFrom : end;
    return { tariff: t, from, to, fraction: (to.getTime() - from.getTime()) / total };
  });
}

export type { Segment };
