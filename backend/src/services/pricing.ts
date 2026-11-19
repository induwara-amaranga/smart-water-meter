/**
 * Tiered (slab) water pricing. Pure functions, mirrored by the Flutter app's
 * TariffCalculator so the in-app estimate matches the bill.
 *
 * Design doc example: 12 m³ with 0–10 @ Rs.10 and >10 @ Rs.15, Rs.400 service
 * → 10×10 + 2×15 + 400 = Rs.530.
 */

export interface Slab {
  /** Cumulative upper bound in m³ for this slab; null = no upper bound. */
  upToM3: number | null;
  rateCents: number;
}

export interface TariffDef {
  id?: number;
  name: string;
  slabs: Slab[];
  serviceChargeCents: number;
  effectiveFrom: Date;
}

export interface Line {
  kind: 'TIER' | 'SERVICE' | 'ARREARS' | 'PENALTY' | 'ADJUSTMENT';
  description: string;
  qtyM3?: number | null;
  rateCents?: number | null;
  amountCents: number;
  tariffVersionId?: number | null;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function validateSlabs(slabs: Slab[]): string | null {
  if (slabs.length === 0) return 'A tariff needs at least one slab';
  let prev = 0;
  for (let i = 0; i < slabs.length; i++) {
    const s = slabs[i];
    if (!Number.isInteger(s.rateCents) || s.rateCents < 0) return `Slab ${i + 1}: rate must be a whole number of cents`;
    if (s.upToM3 === null) {
      if (i !== slabs.length - 1) return 'Only the last slab can be open-ended';
    } else {
      if (s.upToM3 <= prev) return `Slab ${i + 1}: limits must increase`;
      prev = s.upToM3;
    }
  }
  if (slabs[slabs.length - 1].upToM3 !== null) return 'The last slab must be open-ended (no upper limit)';
  return null;
}

/**
 * Tier lines for one usage amount. `scale` shrinks slab limits for a partial
 * period (used when a tariff changes mid-month).
 */
export function tierLines(usageM3: number, tariff: TariffDef, scale = 1, labelSuffix = ''): Line[] {
  const lines: Line[] = [];
  let lower = 0;
  tariff.slabs.forEach((slab, i) => {
    const upper = slab.upToM3 === null ? Infinity : slab.upToM3 * scale;
    if (usageM3 <= lower) return;
    const qty = round3(Math.min(usageM3, upper) - lower);
    if (qty <= 0) return;
    const range =
      upper === Infinity ? `above ${fmt(lower)} m³` : `${fmt(round3(lower))}–${fmt(round3(upper))} m³`;
    lines.push({
      kind: 'TIER',
      description: `Tier ${i + 1} (${range})${labelSuffix}`,
      qtyM3: qty,
      rateCents: slab.rateCents,
      amountCents: Math.round(qty * slab.rateCents),
      tariffVersionId: tariff.id ?? null,
    });
    lower = upper;
  });
  return lines;
}

export interface Segment {
  tariff: TariffDef;
  usageM3: number;
  /** Fraction of the billing period this segment covers (0..1]. */
  fraction: number;
}

/**
 * Price a billing period that may span several tariff versions. Usage in each
 * segment is billed with that segment's tariff, with slab limits pro-rated by
 * the segment's share of the period. The service charge comes from the tariff
 * in force at the end of the period.
 */
export function priceSegments(segments: Segment[]): Line[] {
  if (segments.length === 0) return [];
  const multi = segments.length > 1;
  const lines: Line[] = [];
  for (const s of segments) {
    const suffix = multi ? ` · ${s.tariff.name}` : '';
    lines.push(...tierLines(Math.max(0, s.usageM3), s.tariff, multi ? s.fraction : 1, suffix));
  }
  const last = segments[segments.length - 1].tariff;
  lines.push({
    kind: 'SERVICE',
    description: 'Service charge',
    amountCents: last.serviceChargeCents,
    tariffVersionId: last.id ?? null,
  });
  return lines;
}

export const sumCents = (lines: Line[]) => lines.reduce((s, l) => s + l.amountCents, 0);

/** Simple single-tariff price for estimates and the calculator. */
export function priceUsage(usageM3: number, tariff: TariffDef): Line[] {
  return priceSegments([{ tariff, usageM3, fraction: 1 }]);
}
