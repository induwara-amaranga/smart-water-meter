import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { randomToken, hashSecret } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { accountJson, balance, nextAccountNo } from '../services/accounts.js';
import { alertJson } from '../services/alerts.js';
import { normalizeIdentifier, rotateRefresh, revokeRefresh, staffJson, staffLogin } from '../services/auth.js';
import { commandJson } from '../services/commands.js';
import { adminMeterJson, getMeter, nextMeterId, publishConfig, registerMeter } from '../services/meters.js';
import { cumulativeAt, type UsageRange, usageSeries } from '../services/readings.js';
import { adminBillingRouter } from './admin-billing.js';
import { allow, audit, auditStaffWrites, parse, pid, requireStaff } from './middleware.js';

/** Water board portal API (React admin dashboard). Mounted at /api/v1/admin. */
export function adminRouter(ctx: AppContext): Router {
  const r = Router();
  const { db } = ctx;

  // ------------------------------------------------------------- auth (public)
  r.post('/auth/login', async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    res.json(await staffLogin(ctx, email, password));
  });
  r.post('/auth/refresh', async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10) }), req.body);
    res.json(await rotateRefresh(ctx, refreshToken, 'staff'));
  });
  r.post('/auth/logout', async (req, res) => {
    await revokeRefresh(ctx, (req.body as { refreshToken?: string })?.refreshToken);
    res.json({ ok: true });
  });

  r.use(requireStaff(ctx), auditStaffWrites(ctx));

  r.get('/me', async (req, res) => {
    const s = await db.one(`select * from staff_users where id = $1`, [req.auth!.sub]);
    if (!s) throw notFound('User');
    res.json(staffJson(s));
  });

  // ---------------------------------------------------------------- dashboard
  /** Litres used since `from` across all meters. */
  const fleetUsageSince = async (from: Date) => {
    const row = await db.one<{ used: number }>(
      `select coalesce(sum(greatest(0, m.total_l - coalesce(
          (select r.total_l from readings r where r.meter_id = m.id and r.ts <= $1 order by r.ts desc limit 1),
          (select r.total_l from readings r where r.meter_id = m.id order by r.ts asc limit 1),
          m.total_l))), 0) as used
       from meters m`,
      [from],
    );
    return row?.used ?? 0;
  };

  r.get('/stats/overview', allow('dashboard.view'), async (_req, res) => {
    const now = ctx.now();
    const meters = await db.one<{ total: number; online: number; assigned: number; closed: number }>(
      `select count(*)::int as total, count(*) filter (where online)::int as online,
              count(*) filter (where account_id is not null)::int as assigned,
              count(*) filter (where valve_state = 'closed')::int as closed from meters`,
    );
    const alerts = await db.one<{ open: number; critical: number; leaks: number }>(
      `select count(*)::int as open, count(*) filter (where severity = 'CRITICAL')::int as critical,
              count(*) filter (where type = 'LEAK')::int as leaks from alerts where status = 'OPEN' and type <> 'NOTICE'`,
    );
    const lastCycle = await db.one<{ id: number; period: string }>(`select id, period from billing_cycles where state = 'PUBLISHED' order by period desc limit 1`);
    const issued = lastCycle
      ? await db.one<{ n: number; total: number }>(`select count(*)::int as n, coalesce(sum(total_cents),0)::int as total from bills where cycle_id = $1`, [lastCycle.id])
      : { n: 0, total: 0 };
    const collected = await db.one<{ total: number }>(
      `select coalesce(sum(amount_cents),0)::int as total from payments where status = 'SUCCESS' and paid_at >= $1`,
      [ctx.time.startOfMonth(now)],
    );
    const overdue = await db.one<{ accounts: number; total: number }>(
      `select count(distinct account_id)::int as accounts, coalesce(sum(total_cents),0)::int as total from bills where status = 'OVERDUE'`,
    );
    const pending = await db.one<{ n: number }>(`select count(*)::int as n from commands where state = 'AWAITING_APPROVAL'`);
    const tickets = await db.one<{ n: number }>(`select count(*)::int as n from tickets where status in ('OPEN','IN_PROGRESS')`);

    res.json({
      meters: { ...meters, offline: meters!.total - meters!.online, onlinePct: meters!.total ? Math.round((meters!.online / meters!.total) * 1000) / 10 : 0 },
      consumption: {
        todayM3: Math.round((await fleetUsageSince(ctx.time.startOfDay(now))) / 10) / 100,
        monthM3: Math.round((await fleetUsageSince(ctx.time.startOfMonth(now))) / 10) / 100,
      },
      alerts,
      billing: {
        lastPeriod: lastCycle?.period ?? null,
        billsIssued: issued!.n,
        issuedCents: issued!.total,
        collectedThisMonthCents: collected!.total,
        overdueAccounts: overdue!.accounts,
        overdueCents: overdue!.total,
      },
      valveApprovalsPending: pending!.n,
      openTickets: tickets!.n,
    });
  });

  r.get('/stats/consumption', allow('dashboard.view'), async (req, res) => {
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }), req.query);
    const now = ctx.now();
    const p = ctx.time.parts(now);
    const bounds = Array.from({ length: days + 1 }, (_, i) => ctx.time.at(p.year, p.month, p.day - days + 1 + i));
    bounds[bounds.length - 1] = now;
    const rows = await db.query<{ i: number; total: number }>(
      `select b.i, sum(coalesce(
          (select r.total_l from readings r where r.meter_id = m.id and r.ts <= b.t order by r.ts desc limit 1),
          (select r.total_l from readings r where r.meter_id = m.id order by r.ts asc limit 1), 0)) as total
       from unnest($1::timestamptz[]) with ordinality as b(t, i) cross join meters m
       group by b.i order by b.i`,
      [bounds.map((b) => b.toISOString())],
    );
    const totals = rows.map((x) => Number(x.total));
    res.json(
      bounds.slice(0, -1).map((start, i) => ({
        date: start.toISOString(),
        liters: Math.round(Math.max(0, (totals[i + 1] ?? 0) - (totals[i] ?? 0))),
      })),
    );
  });

  r.get('/map/meters', allow('meters.view'), async (_req, res) => {
    const rows = await db.query(
      `select m.id, m.online, m.valve_state, m.last_seen_at, a.id as account_id, a.account_no, a.holder_name, a.lat, a.lng,
              z.name as zone, exists(select 1 from alerts al where al.meter_id = m.id and al.status = 'OPEN' and al.type = 'LEAK') as leak
       from meters m left join accounts a on a.id = m.account_id left join zones z on z.id = a.zone_id`,
    );
    res.json(
      rows.map((m: any) => ({
        meterId: m.id,
        accountId: m.account_id,
        accountNo: m.account_no,
        holderName: m.holder_name,
        zone: m.zone,
        lat: m.lat,
        lng: m.lng,
        online: m.online,
        valve: m.valve_state,
        leak: m.leak,
        lastSeenAt: m.last_seen_at,
        status: m.leak ? 'LEAK' : m.online ? 'OK' : 'OFFLINE',
      })),
    );
  });

  // -------------------------------------------------------------------- zones
  r.get('/zones', allow('customers.view'), async (_req, res) => {
    res.json(
      await db.query(
        `select z.id, z.name, count(a.id)::int as accounts from zones z left join accounts a on a.zone_id = z.id group by z.id order by z.name`,
      ),
    );
  });
  r.post('/zones', allow('customers.manage'), async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(2).max(60) }), req.body);
    const zrow = await db.one(`insert into zones (name) values ($1) on conflict (name) do nothing returning *`, [name]);
    if (!zrow) throw conflict('A zone with that name exists');
    res.status(201).json(zrow);
  });

  // ---------------------------------------------------------------- customers
  r.get('/customers', allow('customers.view'), async (req, res) => {
    const { q } = parse(z.object({ q: z.string().trim().max(100).optional() }), req.query);
    const rows = await db.query(
      `select c.*, count(m.account_id)::int as accounts from customers c left join account_members m on m.customer_id = c.id
       where $1::text is null or c.name ilike '%' || $1 || '%' or c.phone ilike '%' || $1 || '%' or c.email ilike '%' || $1 || '%'
       group by c.id order by c.created_at desc limit 100`,
      [q || null],
    );
    res.json(rows.map((c: any) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, accounts: c.accounts, createdAt: c.created_at })));
  });

  r.get('/customers/:id', allow('customers.view'), async (req, res) => {
    const c = await db.one(`select * from customers where id::text = $1`, [pid(req)]);
    if (!c) throw notFound('Customer');
    const accounts = await db.query(
      `select a.*, mb.label, mt.id as meter_id, mb.role as member_role from account_members mb join accounts a on a.id = mb.account_id
       left join meters mt on mt.account_id = a.id where mb.customer_id = $1`,
      [c.id],
    );
    const tickets = await db.query(`select * from tickets where customer_id = $1 order by created_at desc`, [c.id]);
    res.json({
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      createdAt: c.created_at,
      accounts: accounts.map((a: any) => ({ ...accountJson(a), memberRole: a.member_role })),
      tickets,
    });
  });

  r.post('/customers', allow('customers.manage'), async (req, res) => {
    const b = parse(
      z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim().max(20).optional(), email: z.string().email().optional() }),
      req.body,
    );
    if (!b.phone && !b.email) throw badRequest('Give a phone number or email');
    try {
      // Store contacts in the same normalised form the app's OTP login uses.
      const phone = b.phone ? normalizeIdentifier(b.phone).value : null;
      const email = b.email ? normalizeIdentifier(b.email).value : null;
      const c = await db.one(`insert into customers (name, phone, email) values ($1,$2,$3) returning *`, [b.name, phone, email]);
      res.status(201).json(c);
    } catch (e: any) {
      if (String(e?.message).includes('unique')) throw conflict('A customer with that phone or email exists');
      throw e;
    }
  });

  /**
   * Consumer registration at the counter, in one transaction:
   * consumer (new or existing) → service account → meter (existing unassigned, newly registered, or later).
   * The consumer can then sign in to the app with the same phone/email and sees the account straight away.
   */
  r.post('/registrations', allow('customers.manage'), async (req, res) => {
    const b = parse(
      z.object({
        customer: z.union([
          z.object({ existingId: z.string().uuid() }),
          z.object({ name: z.string().trim().min(2).max(100), phone: z.string().trim().max(20).optional(), email: z.string().trim().email().optional() }),
        ]),
        account: z.object({
          holderName: z.string().trim().max(120).optional(),
          address: z.string().trim().min(3).max(300),
          zoneId: z.number().int().nullable().optional(),
          lat: z.number().min(-90).max(90).nullable().optional(),
          lng: z.number().min(-180).max(180).nullable().optional(),
          label: z.string().trim().max(40).optional(),
        }),
        meter: z.discriminatedUnion('mode', [
          z.object({ mode: z.literal('existing'), meterId: z.string().trim().toUpperCase() }),
          z.object({ mode: z.literal('new'), meterId: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,32}$/).optional() }),
          z.object({ mode: z.literal('later') }),
        ]),
      }),
      req.body,
    );

    const result = await db.tx(async (t) => {
      let customer: any;
      if ('existingId' in b.customer) {
        customer = await t.one(`select * from customers where id = $1`, [b.customer.existingId]);
        if (!customer) throw notFound('Consumer');
      } else {
        if (!b.customer.phone && !b.customer.email) throw badRequest('Give a mobile number or email so the consumer can sign in to the app');
        const phone = b.customer.phone ? normalizeIdentifier(b.customer.phone).value : null;
        const email = b.customer.email ? normalizeIdentifier(b.customer.email).value : null;
        const existing = await t.one(`select id, name from customers where phone = $1 or email = $2`, [phone, email]);
        if (existing) throw conflict(`${existing.name || 'A consumer'} is already registered with that mobile number or email. Choose "Existing consumer" instead.`);
        customer = await t.one(`insert into customers (name, phone, email) values ($1,$2,$3) returning *`, [b.customer.name, phone, email]);
      }

      const account = await t.one(
        `insert into accounts (account_no, holder_name, address, zone_id, lat, lng) values ($1,$2,$3,$4,$5,$6) returning *`,
        [await nextAccountNo(t), b.account.holderName || customer.name, b.account.address, b.account.zoneId ?? null, b.account.lat ?? null, b.account.lng ?? null],
      );
      await t.query(`insert into account_settings (account_id) values ($1)`, [account.id]);
      await t.query(`insert into account_members (account_id, customer_id, role, label) values ($1,$2,'OWNER',$3)`, [account.id, customer.id, b.account.label || 'Home']);

      let meter: { meterId: string; deviceSecret?: string; claimCode?: string; qr?: string } | null = null;
      if (b.meter.mode === 'existing') {
        const m = await getMeter(t, b.meter.meterId);
        if (m.account_id) throw conflict(`Meter ${m.id} is already assigned to another account`);
        await t.query(`update meters set account_id = $2 where id = $1`, [m.id, account.id]);
        meter = { meterId: m.id };
      } else if (b.meter.mode === 'new') {
        const id = b.meter.meterId ?? (await nextMeterId(t));
        meter = await registerMeter(t, id);
        await t.query(`update meters set account_id = $2 where id = $1`, [id, account.id]);
      }
      return { customer, account: { ...account, meter_id: meter?.meterId ?? null }, meter };
    });

    if (result.meter) await publishConfig(ctx, result.meter.meterId).catch(() => undefined);
    res.status(201).json({
      customer: { id: result.customer.id, name: result.customer.name, phone: result.customer.phone, email: result.customer.email },
      account: adminAccountJson(result.account),
      meter: result.meter,
    });
  });

  // ----------------------------------------------------------------- accounts
  const adminAccountJson = (a: any) => ({
    id: a.id,
    accountNo: a.account_no,
    holderName: a.holder_name,
    address: a.address,
    zoneId: a.zone_id,
    zone: a.zone ?? null,
    lat: a.lat,
    lng: a.lng,
    status: a.status,
    meterId: a.meter_id ?? null,
    online: a.online ?? null,
    createdAt: a.created_at,
  });

  r.get('/accounts', allow('customers.view'), async (req, res) => {
    const f = parse(
      z.object({ q: z.string().trim().max(100).optional(), zoneId: z.coerce.number().int().optional(), status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']).optional() }),
      req.query,
    );
    const rows = await db.query(
      `select a.*, z.name as zone, m.id as meter_id, m.online from accounts a left join zones z on z.id = a.zone_id left join meters m on m.account_id = a.id
       where ($1::text is null or a.account_no ilike '%' || $1 || '%' or a.holder_name ilike '%' || $1 || '%' or m.id ilike '%' || $1 || '%')
         and ($2::int is null or a.zone_id = $2) and ($3::text is null or a.status = $3)
       order by a.account_no limit 200`,
      [f.q || null, f.zoneId ?? null, f.status ?? null],
    );
    res.json(rows.map(adminAccountJson));
  });

  r.get('/accounts/:id', allow('customers.view'), async (req, res) => {
    const a = await db.one(
      `select a.*, z.name as zone, m.id as meter_id, m.online from accounts a left join zones z on z.id = a.zone_id
       left join meters m on m.account_id = a.id where a.id::text = $1`,
      [pid(req)],
    );
    if (!a) throw notFound('Account');
    const members = await db.query(
      `select c.id, c.name, c.phone, c.email, mb.role, mb.label from account_members mb join customers c on c.id = mb.customer_id where mb.account_id = $1`,
      [a.id],
    );
    const bills = await db.query(
      `select id, period, status, total_cents, current_cents, due_date, paid_at, data_basis from bills where account_id = $1 order by period desc limit 12`,
      [a.id],
    );
    const payments = await db.query(`select * from payments where account_id = $1 order by created_at desc limit 20`, [a.id]);
    const adjustments = await db.query(`select * from adjustments where account_id = $1 order by created_at desc`, [a.id]);
    const alerts = await db.query(`select * from alerts where account_id = $1 order by created_at desc limit 20`, [a.id]);
    const settings = await db.one(`select * from account_settings where account_id = $1`, [a.id]);
    res.json({
      ...adminAccountJson(a),
      balance: await balance(ctx, a.id),
      members,
      bills: bills.map((b: any) => ({ id: b.id, period: b.period, status: b.status, totalCents: b.total_cents, currentCents: b.current_cents, dueDate: b.due_date, paidAt: b.paid_at, dataBasis: b.data_basis })),
      payments: payments.map((p: any) => ({ id: p.id, amountCents: p.amount_cents, method: p.method, reference: p.reference, status: p.status, paidAt: p.paid_at })),
      adjustments: adjustments.map((x: any) => ({ id: x.id, amountCents: x.amount_cents, reason: x.reason, createdBy: x.created_by, createdAt: x.created_at })),
      alerts: alerts.map(alertJson),
      settings,
    });
  });

  const accountBody = z.object({
    holderName: z.string().trim().min(1).max(120),
    address: z.string().trim().max(300).default(''),
    zoneId: z.number().int().nullable().optional(),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    customerId: z.string().uuid().optional(),
    label: z.string().trim().max(40).optional(),
  });

  /** New connection: create the account (and optionally link an existing app customer). */
  r.post('/accounts', allow('customers.manage'), async (req, res) => {
    const b = parse(accountBody, req.body);
    const a = await db.tx(async (t) => {
      const row = await t.one(
        `insert into accounts (account_no, holder_name, address, zone_id, lat, lng) values ($1,$2,$3,$4,$5,$6) returning *`,
        [await nextAccountNo(t), b.holderName, b.address, b.zoneId ?? null, b.lat ?? null, b.lng ?? null],
      );
      await t.query(`insert into account_settings (account_id) values ($1)`, [row.id]);
      if (b.customerId) {
        await t.query(`insert into account_members (account_id, customer_id, role, label) values ($1,$2,'OWNER',$3)`, [row.id, b.customerId, b.label ?? 'Home']);
      }
      return row;
    });
    res.status(201).json(adminAccountJson(a));
  });

  r.patch('/accounts/:id', allow('customers.manage'), async (req, res) => {
    const b = parse(accountBody.partial().extend({ status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']).optional() }), req.body);
    const a = await db.one(
      `update accounts set holder_name = coalesce($2, holder_name), address = coalesce($3, address), zone_id = coalesce($4, zone_id),
              lat = coalesce($5, lat), lng = coalesce($6, lng), status = coalesce($7, status)
       where id::text = $1 returning *`,
      [pid(req), b.holderName ?? null, b.address ?? null, b.zoneId ?? null, b.lat ?? null, b.lng ?? null, b.status ?? null],
    );
    if (!a) throw notFound('Account');
    res.json(adminAccountJson(a));
  });

  r.post('/accounts/:id/assign-meter', allow('meters.manage'), async (req, res) => {
    const { meterId } = parse(z.object({ meterId: z.string().trim().toUpperCase() }), req.body);
    const a = await db.one(`select id from accounts where id::text = $1`, [pid(req)]);
    if (!a) throw notFound('Account');
    const m = await getMeter(db, meterId);
    if (m.account_id) throw conflict('This meter is already assigned to an account');
    if (await db.one(`select 1 from meters where account_id = $1`, [a.id])) throw conflict('This account already has a meter. Use "replace meter" instead.');
    await db.query(`update meters set account_id = $2 where id = $1`, [meterId, a.id]);
    res.json({ ok: true, meterId, accountId: a.id });
  });

  // ------------------------------------------------------------------- meters
  r.get('/meters', allow('meters.view'), async (req, res) => {
    const f = parse(z.object({ q: z.string().trim().max(50).optional(), status: z.enum(['online', 'offline', 'unassigned', 'closed']).optional() }), req.query);
    const rows = await db.query(
      `select m.*, a.account_no, a.holder_name from meters m left join accounts a on a.id = m.account_id
       where ($1::text is null or m.id ilike '%' || $1 || '%' or a.account_no ilike '%' || $1 || '%')
         and ($2::text is null or ($2 = 'online' and m.online) or ($2 = 'offline' and not m.online)
              or ($2 = 'unassigned' and m.account_id is null) or ($2 = 'closed' and m.valve_state = 'closed'))
       order by m.id limit 500`,
      [f.q || null, f.status ?? null],
    );
    res.json(rows.map(adminMeterJson));
  });

  r.get('/meters/:id', allow('meters.view'), async (req, res) => {
    const m = await db.one(
      `select m.*, a.account_no, a.holder_name from meters m left join accounts a on a.id = m.account_id where m.id = $1`,
      [pid(req)],
    );
    if (!m) throw notFound('Meter');
    const events = await db.query(`select * from device_events where meter_id = $1 order by ts desc limit 20`, [m.id]);
    const commands = await db.query(`select * from commands where meter_id = $1 order by created_at desc limit 20`, [m.id]);
    const alerts = await db.query(`select * from alerts where meter_id = $1 order by created_at desc limit 20`, [m.id]);
    const readings = await db.one<{ n: number; first: Date; last: Date; backlog: number }>(
      `select count(*)::int as n, min(ts) as first, max(ts) as last, count(*) filter (where backlog)::int as backlog from readings where meter_id = $1`,
      [m.id],
    );
    res.json({
      ...adminMeterJson(m),
      readings,
      events: events.map((e: any) => ({ id: e.id, ts: e.ts, type: e.type, data: e.data })),
      commands: commands.map(commandJson),
      alerts: alerts.map(alertJson),
    });
  });

  /** Register a meter. The device secret and claim code are shown once: flash the secret, print the claim code/QR. */
  r.post('/meters', allow('meters.manage'), async (req, res) => {
    const { id } = parse(z.object({ id: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,32}$/).optional() }), req.body);
    const created = await registerMeter(db, id ?? (await nextMeterId(db)));
    const meterId = created.meterId;
    await publishConfig(ctx, meterId).catch(() => undefined);
    res.status(201).json(created);
  });

  r.patch('/meters/:id', allow('meters.manage'), async (req, res) => {
    const b = parse(
      z.object({
        calFactor: z.number().positive().max(100).optional(),
        telemetrySec: z.number().int().min(5).max(3600).optional(),
        heartbeatSec: z.number().int().min(10).max(3600).optional(),
      }),
      req.body,
    );
    const m = await db.one(
      `update meters set cal_factor = coalesce($2, cal_factor), telemetry_sec = coalesce($3, telemetry_sec),
              heartbeat_sec = coalesce($4, heartbeat_sec), config_ver = config_ver + 1 where id = $1 returning *`,
      [pid(req), b.calFactor ?? null, b.telemetrySec ?? null, b.heartbeatSec ?? null],
    );
    if (!m) throw notFound('Meter');
    await publishConfig(ctx, m.id);
    res.json(adminMeterJson(m));
  });

  r.post('/meters/:id/rotate-secret', allow('meters.manage'), async (req, res) => {
    await getMeter(db, pid(req));
    const secret = randomToken(24);
    await db.query(`update meters set device_secret_hash = $2 where id = $1`, [pid(req), await hashSecret(secret)]);
    res.json({ meterId: pid(req), deviceSecret: secret });
  });

  /** Detailed usage of one customer: access is logged (usage reveals when people are home). */
  r.get('/meters/:id/usage', allow('usage.view'), async (req, res) => {
    const { range } = parse(z.object({ range: z.enum(['day', 'week', 'month']).default('week') }), req.query);
    await getMeter(db, pid(req));
    await audit(ctx, req, 'VIEW_USAGE', 'meters', pid(req), { range });
    res.json(await usageSeries(ctx, pid(req), range as UsageRange));
  });

  r.get('/meters/:id/readings', allow('usage.view'), async (req, res) => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100) }), req.query);
    await audit(ctx, req, 'VIEW_READINGS', 'meters', pid(req), { limit });
    const rows = await db.query(
      `select seq, ts, total_l, flow_lpm, valve, backlog, ts_corrected, received_at from readings where meter_id = $1 order by ts desc limit $2`,
      [pid(req), limit],
    );
    res.json(rows.map((x: any) => ({ seq: x.seq, ts: x.ts, totalL: x.total_l, flowLpm: x.flow_lpm, valve: x.valve, backlog: x.backlog, tsCorrected: x.ts_corrected, receivedAt: x.received_at })));
  });

  // ---------------------------------------------------------------- analytics
  r.get('/analytics/top-consumers', allow('usage.view'), async (req, res) => {
    const { period, limit } = parse(
      z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }),
      req.query,
    );
    const range = period ? ctx.time.monthRange(period) : { start: ctx.time.startOfMonth(ctx.now()), end: ctx.now() };
    const meters = await db.query<{ id: string; account_id: string; account_no: string; holder_name: string; zone: string | null }>(
      `select m.id, a.id as account_id, a.account_no, a.holder_name, z.name as zone from meters m join accounts a on a.id = m.account_id left join zones z on z.id = a.zone_id`,
    );
    const out = [];
    for (const m of meters) {
      const [s, e] = await cumulativeAt(db, m.id, [range.start, range.end]);
      out.push({ meterId: m.id, accountId: m.account_id, accountNo: m.account_no, holderName: m.holder_name, zone: m.zone, usageM3: s === null || e === null ? 0 : Math.max(0, e - s) / 1000 });
    }
    out.sort((a, b) => b.usageM3 - a.usageM3);
    res.json(out.slice(0, limit));
  });

  r.get('/analytics/zones', allow('usage.view'), async (req, res) => {
    const { period } = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }), req.query);
    const range = period ? ctx.time.monthRange(period) : { start: ctx.time.startOfMonth(ctx.now()), end: ctx.now() };
    const meters = await db.query<{ id: string; zone: string | null }>(
      `select m.id, coalesce(z.name, 'Unzoned') as zone from meters m join accounts a on a.id = m.account_id left join zones z on z.id = a.zone_id`,
    );
    const zones = new Map<string, { zone: string; meters: number; usageM3: number }>();
    for (const m of meters) {
      const [s, e] = await cumulativeAt(db, m.id, [range.start, range.end]);
      const zrow = zones.get(m.zone!) ?? { zone: m.zone!, meters: 0, usageM3: 0 };
      zrow.meters++;
      zrow.usageM3 += s === null || e === null ? 0 : Math.max(0, e - s) / 1000;
      zones.set(m.zone!, zrow);
    }
    res.json([...zones.values()].map((z) => ({ ...z, usageM3: Math.round(z.usageM3 * 1000) / 1000 })));
  });

  r.get('/analytics/anomalies', allow('meters.view'), async (_req, res) => {
    const rows = await db.query(
      `select al.*, a.account_no from alerts al left join accounts a on a.id = al.account_id
       where al.status = 'OPEN' and al.type in ('LEAK','DEVICE','HIGH_USAGE') order by al.created_at desc limit 200`,
    );
    res.json(rows.map((x: any) => ({ ...alertJson(x), accountNo: x.account_no })));
  });

  r.use(adminBillingRouter(ctx));
  return r;
}
