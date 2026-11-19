import { describe, expect, it } from 'vitest';
import { priceSegments, priceUsage, sumCents, validateSlabs, type TariffDef } from '../src/services/pricing.js';
import { LocalTime } from '../src/lib/time.js';

const doc: TariffDef = {
  name: 'Doc example',
  slabs: [
    { upToM3: 10, rateCents: 1000 },
    { upToM3: null, rateCents: 1500 },
  ],
  serviceChargeCents: 40000,
  effectiveFrom: new Date('2026-01-01'),
};

describe('pricing', () => {
  it('prices 12 m³ at Rs.530 (design doc worked example)', () => {
    const lines = priceUsage(12, doc);
    expect(lines.map((l) => [l.kind, l.qtyM3 ?? null, l.amountCents])).toEqual([
      ['TIER', 10, 10000],
      ['TIER', 2, 3000],
      ['SERVICE', null, 40000],
    ]);
    expect(sumCents(lines)).toBe(53000);
  });

  it('charges only the service charge for zero usage', () => {
    expect(sumCents(priceUsage(0, doc))).toBe(40000);
  });

  it('splits a month when the tariff changes, pro-rating slab limits', () => {
    const newer: TariffDef = { ...doc, name: 'New', slabs: [{ upToM3: 10, rateCents: 2000 }, { upToM3: null, rateCents: 3000 }], serviceChargeCents: 50000 };
    // Half the month on each tariff, 6 m³ in each half. Slab limit becomes 5 m³ per half.
    const lines = priceSegments([
      { tariff: doc, usageM3: 6, fraction: 0.5 },
      { tariff: newer, usageM3: 6, fraction: 0.5 },
    ]);
    const tiers = lines.filter((l) => l.kind === 'TIER').map((l) => l.amountCents);
    expect(tiers).toEqual([5 * 1000, 1 * 1500, 5 * 2000, 1 * 3000]);
    expect(lines.at(-1)).toMatchObject({ kind: 'SERVICE', amountCents: 50000 });
  });

  it('validates slab tables', () => {
    expect(validateSlabs(doc.slabs)).toBeNull();
    expect(validateSlabs([{ upToM3: 10, rateCents: 100 }])).toMatch(/open-ended/);
    expect(validateSlabs([{ upToM3: 10, rateCents: 100 }, { upToM3: 5, rateCents: 1 }, { upToM3: null, rateCents: 1 }])).toMatch(/increase/);
  });
});

describe('local time (UTC+05:30)', () => {
  const t = new LocalTime(330);
  it('computes local month boundaries', () => {
    const { start, end } = t.monthRange('2026-10');
    expect(start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });
  it('knows the previous period across a year boundary', () => {
    expect(t.previousPeriod(new Date('2026-01-10T00:00:00Z'))).toBe('2025-12');
  });
});
