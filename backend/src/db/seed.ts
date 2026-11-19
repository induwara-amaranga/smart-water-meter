import type { AppContext } from '../context.js';
import { hashSecret } from '../lib/crypto.js';
import { recomputeAccount } from '../services/accounts.js';
import { approveCycle, createCycle, generateBills, publishCycle } from '../services/billing.js';
import { registerMeter } from '../services/meters.js';

/**
 * Demo data so the apps work out of the box. Runs only on an empty database.
 * Logins and meter secrets are listed in the README. Never use in production.
 */
export const DEMO = {
  staff: [
    { name: 'Admin User', email: 'admin@swm.local', password: 'Admin@123', role: 'ADMIN' },
    { name: 'Bimal Billing', email: 'billing@swm.local', password: 'Billing@123', role: 'BILLING_OFFICER' },
    { name: 'Chathu Billing', email: 'billing2@swm.local', password: 'Billing@123', role: 'BILLING_OFFICER' },
    { name: 'Ops Technician', email: 'ops@swm.local', password: 'Ops@12345', role: 'OPERATIONS' },
    { name: 'Support Desk', email: 'cs@swm.local', password: 'Support@123', role: 'CUSTOMER_SERVICE' },
    { name: 'Audit Viewer', email: 'auditor@swm.local', password: 'Audit@123', role: 'AUDITOR' },
  ],
  customer: { name: 'Demo Customer', phone: '+94771234567', email: 'demo@swm.local' },
  meters: [
    { id: 'SWM-000123', secret: 'demo-secret-123', claim: 'ABCD-1111', account: { label: 'Home', holder: 'Demo Customer', address: '12 Lake Road, Kotte', zone: 'Kotte', lat: 6.8905, lng: 79.9037, budget: 15, dailyL: 430 } },
    { id: 'SWM-000456', secret: 'demo-secret-456', claim: 'ABCD-2222', account: { label: 'Parents', holder: 'Demo Customer', address: '5 Temple Lane, Piliyandala', zone: 'Piliyandala', lat: 6.8018, lng: 79.9227, budget: null, dailyL: 310 } },
    { id: 'SWM-000555', secret: 'demo-secret-555', claim: 'ABCD-5555', account: { label: 'Shop', holder: 'Lakeside Bakery', address: '88 High Level Road, Maharagama', zone: 'Maharagama', lat: 6.848, lng: 79.9265, budget: null, dailyL: 900, noCustomer: true } },
    { id: 'SWM-000789', secret: 'demo-secret-789', claim: 'ABCD-1234' },
    { id: 'SWM-000999', secret: 'demo-secret-999', claim: 'WXYZ-9876' },
  ],
};

// Typical household hourly profile (share of daily use), morning and evening peaks.
const PROFILE = [0.5, 0.2, 0, 0, 0, 1.5, 7, 11, 8, 4, 3, 3.5, 5, 4, 2.5, 2.5, 3, 6, 10, 9, 6, 3.5, 2, 1];
const PROFILE_SUM = PROFILE.reduce((a, b) => a + b, 0);

/** Deterministic pseudo-random numbers so every fresh database looks the same. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export async function seedDemo(ctx: AppContext): Promise<boolean> {
  const { db } = ctx;
  if (await db.one(`select 1 from tariff_versions limit 1`)) return false;
  const now = ctx.now();
  const t = ctx.time;
  const p = t.parts(now);

  // Staff
  const staffIds: Record<string, string> = {};
  for (const s of DEMO.staff) {
    const row = await db.one<{ id: string }>(
      `insert into staff_users (name, email, password_hash, role) values ($1,$2,$3,$4) returning id`,
      [s.name, s.email, await hashSecret(s.password), s.role],
    );
    staffIds[s.email] = row!.id;
  }

  // Tariff (from the design doc example, extended with a third tier)
  await db.query(
    `insert into tariff_versions (name, slabs, service_charge_cents, effective_from, status, created_by, approved_by, approved_at)
     values ($1,$2,$3,$4,'APPROVED',$5,$6,now())`,
    [
      'Domestic 2026',
      JSON.stringify([
        { upToM3: 10, rateCents: 1000 },
        { upToM3: 20, rateCents: 1500 },
        { upToM3: null, rateCents: 2500 },
      ]),
      40000,
      t.at(p.year - 1, p.month, 1),
      staffIds['billing@swm.local'],
      staffIds['admin@swm.local'],
    ],
  );

  // Zones
  const zoneIds: Record<string, number> = {};
  for (const name of ['Kotte', 'Piliyandala', 'Maharagama']) {
    zoneIds[name] = (await db.one<{ id: number }>(`insert into zones (name) values ($1) returning id`, [name]))!.id;
  }

  // Customer
  const customer = await db.one<{ id: string }>(`insert into customers (name, phone, email) values ($1,$2,$3) returning id`, [
    DEMO.customer.name,
    DEMO.customer.phone,
    DEMO.customer.email,
  ]);

  // Meters, accounts, history
  const days = 130; // enough history for three full past months of bills
  const start = t.startOfDay(new Date(now.getTime() - days * 86400_000));
  let accountSeq = 0;
  for (const [mi, m] of DEMO.meters.entries()) {
    await registerMeter(db, m.id, { secret: m.secret, claimCode: m.claim });
    if (!m.account) continue;
    const a = m.account;
    accountSeq++;
    const acct = await db.one<{ id: string }>(
      `insert into accounts (account_no, holder_name, address, zone_id, lat, lng) values ($1,$2,$3,$4,$5,$6) returning id`,
      [`SW-${100000 + accountSeq}`, a.holder, a.address, zoneIds[a.zone], a.lat, a.lng],
    );
    await db.query(`insert into account_settings (account_id, budget_m3) values ($1,$2)`, [acct!.id, a.budget]);
    if (!('noCustomer' in a)) {
      await db.query(`insert into account_members (account_id, customer_id, role, label) values ($1,$2,'OWNER',$3)`, [acct!.id, customer!.id, a.label]);
    }

    // Hourly cumulative readings for the last `days` days, ending an hour ago.
    const rand = rng(1000 + mi);
    const seqs: number[] = [];
    const tss: string[] = [];
    const totals: number[] = [];
    const flows: number[] = [];
    let total = 150_000 + mi * 70_000;
    let seq = 1;
    for (let ts = start.getTime(); ts <= now.getTime() - 3600_000; ts += 3600_000) {
      const hour = t.parts(new Date(ts)).hour;
      const dayFactor = 0.75 + rand() * 0.5;
      const used = ((a.dailyL * PROFILE[hour]) / PROFILE_SUM) * dayFactor;
      total += used;
      seqs.push(seq++);
      tss.push(new Date(ts).toISOString());
      totals.push(Math.round(total * 1000) / 1000);
      flows.push(used > 1 ? Math.round((used / 60) * 10) / 10 : 0);
    }
    await db.query(
      `insert into readings (meter_id, seq, ts, total_l, flow_lpm, valve)
       select $1, s, ts, total, flow, 'open' from unnest($2::bigint[], $3::timestamptz[], $4::float8[], $5::float8[]) as u(s, ts, total, flow)`,
      [m.id, seqs, tss, totals, flows],
    );
    await db.query(
      `update meters set account_id = $2, total_l = $3, last_seen_at = $4, valve_state = 'open', online = false, rssi = -64, fw_version = '1.2.0' where id = $1`,
      [m.id, acct!.id, totals[totals.length - 1], tss[tss.length - 1]],
    );
  }

  // Three past billing cycles through the real billing workflow (two different officers).
  const generatedBy = staffIds['billing@swm.local'];
  const approvedBy = staffIds['billing2@swm.local'];
  const periods = [3, 2, 1].map((k) => t.periodOf(t.at(p.year, p.month - k, 1)));
  for (const period of periods) {
    const { start: ps, end: pe } = t.monthRange(period);
    if (ps < start) continue; // not enough history for this month
    const cycle = await createCycle(ctx, period, generatedBy);
    await db.query(`update billing_cycle_items set resolution = 'ACCEPT' where cycle_id = $1 and resolution is null`, [cycle.id]);
    await generateBills(ctx, cycle.id, generatedBy);
    await approveCycle(ctx, cycle.id, approvedBy);
    await publishCycle(ctx, cycle.id, generatedBy);
    // Back-date to look like a normal monthly run.
    const published = new Date(pe.getTime() + 3 * 86400_000);
    const due = new Date(published.getTime() + ctx.config.BILL_DUE_DAYS * 86400_000);
    await db.query(`update bills set published_at = $2, due_date = $3, created_at = $2 where cycle_id = $1`, [cycle.id, published, due]);
    await db.query(`update billing_cycles set published_at = $2, generated_at = $2, approved_at = $2 where id = $1`, [cycle.id, published]);

    // Customers paid every bill except the latest one.
    if (period !== periods[periods.length - 1]) {
      const bills = await db.query<{ account_id: string; total_cents: number }>(`select account_id, total_cents from bills where cycle_id = $1`, [cycle.id]);
      for (const b of bills) {
        const paidAt = new Date(published.getTime() + 6 * 86400_000);
        await db.query(
          `insert into payments (account_id, amount_cents, method, reference, status, paid_at, created_at) values ($1,$2,'CARD',$3,'SUCCESS',$4,$4)`,
          [b.account_id, b.total_cents, `PAY-DEMO-${period}-${b.account_id.slice(0, 6)}`, paidAt],
        );
      }
    }
  }
  const accounts = await db.query<{ id: string }>(`select id from accounts`);
  for (const a of accounts) await recomputeAccount(ctx, a.id);

  // Older notifications are already read; add a board notice.
  await db.query(`update alerts set read = true, status = 'RESOLVED'`);
  const notice = await db.one<{ id: number }>(
    `insert into notices (title, body, zone_ids, created_by) values ($1,$2,$3,$4) returning id`,
    [
      'Planned interruption',
      'Water supply in Kotte will be interrupted on Saturday 9 AM – 1 PM for pipeline maintenance.',
      [zoneIds.Kotte],
      staffIds['cs@swm.local'],
    ],
  );
  const kotte = await db.query<{ id: string }>(`select id from accounts where zone_id = $1`, [zoneIds.Kotte]);
  for (const a of kotte) {
    await db.query(
      `insert into alerts (account_id, type, severity, title, message, dedupe_key) values ($1,'NOTICE','INFO',$2,$3,$4)`,
      [a.id, 'Planned interruption', 'Water supply in Kotte will be interrupted on Saturday 9 AM – 1 PM for pipeline maintenance.', `notice:${notice!.id}:${a.id}`],
    );
  }
  await db.query(
    `insert into tickets (customer_id, account_id, category, subject, description, status, resolution_note)
     select $1, a.id, 'Billing', 'Query about arrears on last bill', 'The previous bill shows arrears although I paid on time.', 'RESOLVED', 'Payment was received after the bill date; arrears cleared.'
     from accounts a where a.account_no = 'SW-100001'`,
    [customer!.id],
  );
  // New accounts created later continue after the demo numbers.
  await db.query(`select setval('account_no_seq', 100100)`);
  return true;
}
