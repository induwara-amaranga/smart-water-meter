import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { hashSecret, randomToken } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { balance, recomputeAccount } from '../services/accounts.js';
import { alertJson, raiseAlert } from '../services/alerts.js';
import { staffJson } from '../services/auth.js';
import {
  approveCycle,
  billJson,
  createCycle,
  cycleItemJson,
  cycleSummary,
  generateBills,
  publishCycle,
  resolveItem,
} from '../services/billing.js';
import { commandJson, decideStaffValve, requestStaffValve } from '../services/commands.js';
import { publishAllConfigs } from '../services/meters.js';
import { billPdf } from '../services/pdf.js';
import { priceUsage, sumCents, validateSlabs } from '../services/pricing.js';
import { adminTariffJson, tariffAt, toTariff } from '../services/tariffs.js';
import { ticketJson } from './customer.js';
import { allow, parse, pid } from './middleware.js';

const slabSchema = z.object({ upToM3: z.number().positive().nullable(), rateCents: z.number().int().min(0) });
const tariffBody = z.object({
  name: z.string().trim().min(2).max(80),
  slabs: z.array(slabSchema).min(1).max(10),
  serviceChargeCents: z.number().int().min(0),
  effectiveFrom: z.coerce.date(),
});

/** Tariffs, billing, payments, valve approvals, alerts, tickets, notices, users, audit, reports. */
export function adminBillingRouter(ctx: AppContext): Router {
  const r = Router();
  const { db } = ctx;
  const staff = (req: { auth?: { sub: string } }) => req.auth!.sub;

  // ------------------------------------------------------------------ tariffs
  r.get('/tariffs', allow('billing.view'), async (_req, res) => {
    const rows = await db.query(`select * from tariff_versions order by effective_from desc, id desc`);
    let activeId: number | null = null;
    try {
      activeId = (await tariffAt(db, ctx.now())).id ?? null;
    } catch {
      /* no active tariff yet */
    }
    res.json(rows.map((t: any) => ({ ...adminTariffJson(t), active: t.id === activeId })));
  });

  r.post('/tariffs', allow('tariffs.manage'), async (req, res) => {
    const b = parse(tariffBody, req.body);
    const err = validateSlabs(b.slabs);
    if (err) throw badRequest(err);
    const t = await db.one(
      `insert into tariff_versions (name, slabs, service_charge_cents, effective_from, created_by) values ($1,$2,$3,$4,$5) returning *`,
      [b.name, JSON.stringify(b.slabs), b.serviceChargeCents, b.effectiveFrom, staff(req)],
    );
    res.status(201).json(adminTariffJson(t));
  });

  r.patch('/tariffs/:id', allow('tariffs.manage'), async (req, res) => {
    const b = parse(tariffBody.partial(), req.body);
    const cur = await db.one(`select * from tariff_versions where id::text = $1`, [pid(req)]);
    if (!cur) throw notFound('Tariff');
    if (cur.status !== 'DRAFT') throw conflict('Only draft tariffs can be edited. Create a new version instead.');
    if (b.slabs) {
      const err = validateSlabs(b.slabs);
      if (err) throw badRequest(err);
    }
    const t = await db.one(
      `update tariff_versions set name = coalesce($2, name), slabs = coalesce($3::jsonb, slabs),
              service_charge_cents = coalesce($4, service_charge_cents), effective_from = coalesce($5, effective_from)
       where id = $1 returning *`,
      [cur.id, b.name ?? null, b.slabs ? JSON.stringify(b.slabs) : null, b.serviceChargeCents ?? null, b.effectiveFrom ?? null],
    );
    res.json(adminTariffJson(t));
  });

  /** Sample bills under a proposed tariff compared with the current one. */
  r.post('/tariffs/preview', allow('tariffs.manage'), async (req, res) => {
    const b = parse(
      tariffBody.omit({ name: true, effectiveFrom: true }).extend({ usagesM3: z.array(z.number().min(0).max(10_000)).max(20).default([5, 10, 15, 20, 30, 50]) }),
      req.body,
    );
    const err = validateSlabs(b.slabs);
    if (err) throw badRequest(err);
    const proposed = { name: 'Proposed', slabs: b.slabs, serviceChargeCents: b.serviceChargeCents, effectiveFrom: ctx.now() };
    let current = null;
    try {
      current = await tariffAt(db, ctx.now());
    } catch {
      /* none */
    }
    res.json(
      b.usagesM3.map((u) => {
        const next = sumCents(priceUsage(u, proposed));
        const now = current ? sumCents(priceUsage(u, current)) : null;
        return { usageM3: u, currentCents: now, proposedCents: next, changeCents: now === null ? null : next - now, lines: priceUsage(u, proposed) };
      }),
    );
  });

  r.post('/tariffs/:id/approve', allow('tariffs.approve'), async (req, res) => {
    const cur = await db.one(`select * from tariff_versions where id::text = $1`, [pid(req)]);
    if (!cur) throw notFound('Tariff');
    if (cur.status !== 'DRAFT') throw conflict('This tariff is not a draft');
    if (cur.created_by === staff(req)) throw forbidden('A different officer must approve a tariff they created');
    const t = await db.one(`update tariff_versions set status = 'APPROVED', approved_by = $2, approved_at = now() where id = $1 returning *`, [cur.id, staff(req)]);
    const def = toTariff(t);
    // A tariff change automatically creates a notice to all customers.
    const accounts = await db.query<{ id: string }>(`select id from accounts where status <> 'CLOSED'`);
    for (const a of accounts) {
      await raiseAlert(ctx, {
        accountId: a.id,
        type: 'NOTICE',
        severity: 'INFO',
        title: 'Water tariff change',
        message: `New rates ("${def.name}") apply from ${def.effectiveFrom.toDateString()}. Open the bill calculator to see the new prices.`,
        dedupeKey: `tariff:${t.id}:${a.id}`,
      });
    }
    if (def.effectiveFrom <= ctx.now()) await publishAllConfigs(ctx).catch(() => undefined);
    res.json(adminTariffJson(t));
  });

  // ------------------------------------------------------------------ billing
  r.get('/billing-cycles', allow('billing.view'), async (_req, res) => {
    const rows = await db.query<{ id: number }>(`select id from billing_cycles order by period desc`);
    res.json(await Promise.all(rows.map((c) => cycleSummary(ctx, c.id))));
  });

  r.post('/billing-cycles', allow('billing.run'), async (req, res) => {
    const { period } = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }), req.body);
    res.status(201).json(await createCycle(ctx, period ?? ctx.time.previousPeriod(ctx.now()), staff(req)));
  });

  const cycleId = (raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw notFound('Billing cycle');
    return n;
  };

  r.get('/billing-cycles/:id', allow('billing.view'), async (req, res) => {
    res.json(await cycleSummary(ctx, cycleId(pid(req))));
  });

  r.get('/billing-cycles/:id/items', allow('billing.view'), async (req, res) => {
    const { flagged } = parse(z.object({ flagged: z.enum(['true', 'false']).optional() }), req.query);
    const rows = await db.query(
      `select i.*, a.account_no, a.holder_name from billing_cycle_items i join accounts a on a.id = i.account_id
       where i.cycle_id = $1 and ($2::boolean is null or (cardinality(i.flags) > 0) = $2) order by a.account_no`,
      [cycleId(pid(req)), flagged === undefined ? null : flagged === 'true'],
    );
    res.json(rows.map(cycleItemJson));
  });

  r.patch('/billing-cycles/:id/items/:accountId', allow('billing.run'), async (req, res) => {
    const b = parse(
      z.object({ resolution: z.enum(['ACCEPT', 'ESTIMATE', 'HOLD']), closingL: z.number().min(0).optional(), note: z.string().max(500).optional() }),
      req.body,
    );
    await resolveItem(ctx, cycleId(pid(req)), pid(req, 'accountId'), b);
    res.json({ ok: true });
  });

  r.post('/billing-cycles/:id/generate', allow('billing.run'), async (req, res) => {
    res.json(await generateBills(ctx, cycleId(pid(req)), staff(req)));
  });
  r.post('/billing-cycles/:id/approve', allow('billing.run'), async (req, res) => {
    res.json(await approveCycle(ctx, cycleId(pid(req)), staff(req)));
  });
  r.post('/billing-cycles/:id/publish', allow('billing.run'), async (req, res) => {
    res.json(await publishCycle(ctx, cycleId(pid(req)), staff(req)));
  });

  r.get('/billing-cycles/:id/bills', allow('billing.view'), async (req, res) => {
    const rows = await db.query(
      `select b.*, a.account_no, a.holder_name from bills b join accounts a on a.id = b.account_id where b.cycle_id = $1 order by a.account_no`,
      [cycleId(pid(req))],
    );
    res.json(
      rows.map((b: any) => ({
        id: b.id,
        accountId: b.account_id,
        accountNo: b.account_no,
        holderName: b.holder_name,
        usageM3: (b.closing_l - b.opening_l) / 1000,
        currentCents: b.current_cents,
        arrearsCents: b.arrears_cents,
        totalCents: b.total_cents,
        status: b.status,
        dataBasis: b.data_basis,
      })),
    );
  });

  const loadBill = async (id: string) => {
    const b = await db.one(`select * from bills where id::text = $1`, [id]);
    if (!b) throw notFound('Bill');
    const acct = await db.one(`select a.*, m.id as meter_id from accounts a left join meters m on m.account_id = a.id where a.id = $1`, [b.account_id]);
    return { bill: { ...(await billJson(db, b)), accountId: b.account_id, accountNo: acct.account_no }, acct };
  };

  r.get('/bills/:id', allow('billing.view'), async (req, res) => {
    res.json((await loadBill(pid(req))).bill);
  });

  r.get('/bills/:id/pdf', allow('billing.view'), async (req, res) => {
    const { bill, acct } = await loadBill(pid(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.send(await billPdf(bill, acct));
  });

  // --------------------------------------------------------------- payments
  r.get('/payments', allow('billing.view'), async (req, res) => {
    const f = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req.query);
    const rows = await db.query(
      `select p.*, a.account_no, a.holder_name from payments p join accounts a on a.id = p.account_id
       where ($1::timestamptz is null or p.created_at >= $1) and ($2::timestamptz is null or p.created_at < $2)
       order by p.created_at desc limit 500`,
      [f.from ?? null, f.to ?? null],
    );
    res.json(
      rows.map((p: any) => ({
        id: p.id,
        accountId: p.account_id,
        accountNo: p.account_no,
        holderName: p.holder_name,
        amountCents: p.amount_cents,
        method: p.method,
        reference: p.reference,
        status: p.status,
        paidAt: p.paid_at,
        recordedByStaff: p.created_by_staff,
      })),
    );
  });

  /** Counter / bank payments recorded by staff. */
  r.post('/accounts/:id/payments', allow('payments.manage'), async (req, res) => {
    const b = parse(
      z.object({ amountCents: z.number().int().positive(), method: z.enum(['CASH', 'BANK', 'CHEQUE', 'CARD']), reference: z.string().trim().max(60).optional() }),
      req.body,
    );
    const a = await db.one(`select id from accounts where id::text = $1`, [pid(req)]);
    if (!a) throw notFound('Account');
    const ref = b.reference || `CTR-${randomToken(6).toUpperCase()}`;
    try {
      await db.query(
        `insert into payments (account_id, amount_cents, method, reference, status, paid_at, created_by_staff) values ($1,$2,$3,$4,'SUCCESS',now(),$5)`,
        [a.id, b.amountCents, b.method, ref, staff(req)],
      );
    } catch (e: any) {
      if (String(e?.message).includes('unique')) throw conflict('A payment with this reference already exists');
      throw e;
    }
    res.status(201).json({ reference: ref, balance: await balance(ctx, a.id) });
  });

  /** Credit notes (negative) and debit adjustments (positive). Bills stay locked; corrections go here. */
  r.post('/accounts/:id/adjustments', allow('payments.manage'), async (req, res) => {
    const b = parse(z.object({ amountCents: z.number().int().refine((v) => v !== 0, 'Amount cannot be zero'), reason: z.string().trim().min(5).max(300) }), req.body);
    const a = await db.one(`select id from accounts where id::text = $1`, [pid(req)]);
    if (!a) throw notFound('Account');
    await db.query(`insert into adjustments (account_id, amount_cents, reason, created_by) values ($1,$2,$3,$4)`, [a.id, b.amountCents, b.reason, staff(req)]);
    res.status(201).json({ balance: await balance(ctx, a.id) });
  });

  r.get('/arrears', allow('billing.view'), async (_req, res) => {
    // Accounts with an unpaid balance, or whose supply is currently cut (so they can be reconnected).
    const accounts = await db.query<{
      id: string; account_no: string; holder_name: string; address: string; status: string;
      meter_id: string | null; valve_state: string | null; online: boolean | null; pending_id: string | null; pending_type: string | null; pending_state: string | null;
    }>(
      `select a.id, a.account_no, a.holder_name, a.address, a.status, m.id as meter_id, m.valve_state, m.online,
              p.id as pending_id, p.type as pending_type, p.state as pending_state
       from accounts a left join meters m on m.account_id = a.id
       left join lateral (select c.id, c.type, c.state from commands c where c.meter_id = m.id and c.initiated_by_type = 'STAFF'
                          and c.state in ('AWAITING_APPROVAL','SENT','RECEIVED') order by c.created_at desc limit 1) p on true
       where exists (select 1 from bills b where b.account_id = a.id and b.status in ('PUBLISHED','OVERDUE'))
          or (a.status = 'SUSPENDED')`,
    );
    const out = [];
    for (const a of accounts) {
      const bal = await balance(ctx, a.id);
      if (bal.amountDueCents <= 0 && a.status !== 'SUSPENDED') continue;
      const overdue = await db.one<{ n: number; oldest: Date | null }>(
        `select count(*)::int as n, min(due_date) as oldest from bills where account_id = $1 and status = 'OVERDUE'`,
        [a.id],
      );
      out.push({
        accountId: a.id,
        accountNo: a.account_no,
        holderName: a.holder_name,
        address: a.address,
        accountStatus: a.status,
        meterId: a.meter_id,
        valve: a.valve_state,
        meterOnline: a.online,
        amountDueCents: bal.amountDueCents,
        overdueBills: overdue!.n,
        oldestDueDate: overdue!.oldest,
        lastPaymentAt: bal.lastPaymentAt,
        pendingRequest: a.pending_id ? { id: a.pending_id, type: a.pending_type, state: a.pending_state } : null,
      });
    }
    out.sort((x, y) => y.amountDueCents - x.amountDueCents);
    res.json(out);
  });

  r.post('/arrears/reminders', allow('payments.manage'), async (_req, res) => {
    const overdue = await db.query<{ account_id: string }>(`select distinct account_id from bills where status = 'OVERDUE'`);
    const stamp = ctx.time.periodOf(ctx.now()) + '-' + ctx.time.parts(ctx.now()).day;
    let sent = 0;
    for (const o of overdue) {
      const bal = await balance(ctx, o.account_id);
      if (bal.amountDueCents <= 0) continue;
      if (await raiseAlert(ctx, {
        accountId: o.account_id,
        type: 'BILLING',
        severity: 'WARNING',
        title: 'Payment reminder',
        message: `Rs. ${(bal.amountDueCents / 100).toFixed(2)} is overdue. Please pay to avoid disconnection.`,
        dedupeKey: `reminder:${o.account_id}:${stamp}`,
      })) sent++;
    }
    res.json({ sent });
  });

  // ------------------------------------------------------------ valve control
  r.get('/valve-requests', allow('meters.view'), async (req, res) => {
    const { state } = parse(z.object({ state: z.string().max(30).optional() }), req.query);
    const rows = await db.query(
      `select c.*, s.name as requested_by_name, ap.name as approved_by_name, a.id as account_id, a.account_no, a.holder_name
       from commands c left join staff_users s on s.id::text = c.initiated_by_id left join staff_users ap on ap.id = c.approved_by
       left join meters m on m.id = c.meter_id left join accounts a on a.id = m.account_id
       where c.initiated_by_type = 'STAFF' and ($1::text is null or c.state = $1) order by c.created_at desc limit 200`,
      [state ?? null],
    );
    res.json(
      rows.map((c: any) => ({
        ...commandJson(c),
        requestedByName: c.requested_by_name,
        approvedByName: c.approved_by_name,
        accountId: c.account_id,
        accountNo: c.account_no,
        holderName: c.holder_name,
      })),
    );
  });

  r.post('/valve-requests', allow('valve.request'), async (req, res) => {
    const b = parse(z.object({ meterId: z.string().trim().toUpperCase(), action: z.enum(['OPEN', 'CLOSE']), reason: z.string().trim().min(5).max(300) }), req.body);
    const c = await requestStaffValve(ctx, b.meterId, staff(req), b.action === 'OPEN', b.reason);
    res.status(201).json(commandJson(c));
  });

  r.post('/valve-requests/:id/approve', allow('valve.approve'), async (req, res) => {
    res.json(commandJson((await decideStaffValve(ctx, pid(req), staff(req), true)) as any));
  });

  r.post('/valve-requests/:id/reject', allow('valve.approve'), async (req, res) => {
    const { note } = parse(z.object({ note: z.string().max(300).optional() }), req.body ?? {});
    res.json(commandJson((await decideStaffValve(ctx, pid(req), staff(req), false, note)) as any));
  });

  r.get('/commands', allow('meters.view'), async (req, res) => {
    const { meterId } = parse(z.object({ meterId: z.string().optional() }), req.query);
    const rows = await db.query(`select * from commands where ($1::text is null or meter_id = $1) order by created_at desc limit 200`, [meterId ?? null]);
    res.json(rows.map(commandJson));
  });

  // ------------------------------------------------------------------- alerts
  r.get('/alerts', allow('meters.view'), async (req, res) => {
    const f = parse(z.object({ status: z.enum(['OPEN', 'RESOLVED']).optional(), type: z.string().max(20).optional() }), req.query);
    const rows = await db.query(
      `select al.*, a.account_no from alerts al left join accounts a on a.id = al.account_id
       where al.type <> 'NOTICE' and ($1::text is null or al.status = $1) and ($2::text is null or al.type = $2)
       order by al.created_at desc limit 300`,
      [f.status ?? null, f.type ?? null],
    );
    res.json(rows.map((x: any) => ({ ...alertJson(x), accountNo: x.account_no })));
  });

  r.patch('/alerts/:id', allow('alerts.manage'), async (req, res) => {
    parse(z.object({ status: z.literal('RESOLVED') }), req.body);
    const row = await db.one(`update alerts set status = 'RESOLVED', resolved_at = now() where id::text = $1 returning *`, [pid(req)]);
    if (!row) throw notFound('Alert');
    res.json(alertJson(row));
  });

  /** Turn an alert into a work order for a technician. */
  r.post('/alerts/:id/ticket', allow('tickets.manage'), async (req, res) => {
    const { assigneeId } = parse(z.object({ assigneeId: z.string().uuid().optional() }), req.body ?? {});
    const al = await db.one(`select * from alerts where id::text = $1`, [pid(req)]);
    if (!al) throw notFound('Alert');
    const t = await db.one(
      `insert into tickets (account_id, category, subject, description, status, assignee_id) values ($1,'Work order',$2,$3,$4,$5) returning *`,
      [al.account_id, al.title, `${al.message}\n\nFrom alert ${al.id} (${al.meter_id ?? 'no meter'})`, assigneeId ? 'IN_PROGRESS' : 'OPEN', assigneeId ?? null],
    );
    res.status(201).json(ticketJson(t));
  });

  // ------------------------------------------------------------------ tickets
  r.get('/tickets', allow('customers.view'), async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional() }), req.query);
    const rows = await db.query(
      `select t.*, c.name as customer_name, c.phone as customer_phone, a.account_no, s.name as assignee_name
       from tickets t left join customers c on c.id = t.customer_id left join accounts a on a.id = t.account_id
       left join staff_users s on s.id = t.assignee_id
       where ($1::text is null or t.status = $1) order by t.created_at desc limit 300`,
      [status ?? null],
    );
    res.json(
      rows.map((t: any) => ({
        ...ticketJson(t),
        customerName: t.customer_name,
        customerPhone: t.customer_phone,
        accountNo: t.account_no,
        assigneeId: t.assignee_id,
        assigneeName: t.assignee_name,
      })),
    );
  });

  r.patch('/tickets/:id', allow('tickets.manage'), async (req, res) => {
    const b = parse(
      z.object({
        status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']).optional(),
        assigneeId: z.string().uuid().nullable().optional(),
        resolutionNote: z.string().max(2000).optional(),
      }),
      req.body,
    );
    const t = await db.one(
      `update tickets set status = coalesce($2, status), assignee_id = case when $3::boolean then $4::uuid else assignee_id end,
              resolution_note = coalesce($5, resolution_note), updated_at = now() where id = $1 returning *`,
      [pid(req), b.status ?? null, b.assigneeId !== undefined, b.assigneeId ?? null, b.resolutionNote ?? null],
    );
    if (!t) throw notFound('Ticket');
    res.json(ticketJson(t));
  });

  // ------------------------------------------------------------------ notices
  r.get('/notices', allow('customers.view'), async (_req, res) => {
    res.json(await db.query(`select * from notices order by created_at desc limit 100`));
  });

  /** Broadcast to customers in the given zones (all customers if none). */
  r.post('/notices', allow('notices.manage'), async (req, res) => {
    const b = parse(
      z.object({ title: z.string().trim().min(3).max(120), body: z.string().trim().min(3).max(2000), zoneIds: z.array(z.number().int()).default([]) }),
      req.body,
    );
    const n = await db.one(`insert into notices (title, body, zone_ids, created_by) values ($1,$2,$3,$4) returning *`, [b.title, b.body, b.zoneIds, staff(req)]);
    const accounts = await db.query<{ id: string }>(
      `select id from accounts where status <> 'CLOSED' and (cardinality($1::int[]) = 0 or zone_id = any($1::int[]))`,
      [b.zoneIds],
    );
    for (const a of accounts) {
      await raiseAlert(ctx, { accountId: a.id, type: 'NOTICE', severity: 'INFO', title: b.title, message: b.body, dedupeKey: `notice:${n.id}:${a.id}` });
    }
    res.status(201).json({ ...n, recipients: accounts.length });
  });

  // ------------------------------------------------------------- staff users
  r.get('/users', allow('users.manage'), async (_req, res) => {
    res.json((await db.query(`select * from staff_users order by created_at`)).map(staffJson));
  });

  const roleEnum = z.enum(['ADMIN', 'BILLING_OFFICER', 'OPERATIONS', 'CUSTOMER_SERVICE', 'AUDITOR']);

  r.post('/users', allow('users.manage'), async (req, res) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(100), email: z.string().email(), password: z.string().min(8).max(100), role: roleEnum }), req.body);
    try {
      const s = await db.one(`insert into staff_users (name, email, password_hash, role) values ($1,$2,$3,$4) returning *`, [
        b.name,
        b.email.toLowerCase(),
        await hashSecret(b.password),
        b.role,
      ]);
      res.status(201).json(staffJson(s));
    } catch (e: any) {
      if (String(e?.message).includes('unique')) throw conflict('A user with that email exists');
      throw e;
    }
  });

  r.patch('/users/:id', allow('users.manage'), async (req, res) => {
    const b = parse(
      z.object({ name: z.string().trim().min(2).max(100).optional(), role: roleEnum.optional(), active: z.boolean().optional(), password: z.string().min(8).max(100).optional() }),
      req.body,
    );
    if (pid(req) === staff(req) && (b.active === false || (b.role && b.role !== 'ADMIN'))) throw badRequest('You cannot remove your own admin access');
    const s = await db.one(
      `update staff_users set name = coalesce($5, name), role = coalesce($2, role), active = coalesce($3, active), password_hash = coalesce($4, password_hash)
       where id::text = $1 returning *`,
      [pid(req), b.role ?? null, b.active ?? null, b.password ? await hashSecret(b.password) : null, b.name ?? null],
    );
    if (!s) throw notFound('User');
    if (b.active === false || b.password) await db.query(`update refresh_tokens set revoked = true where subject_id = $1`, [s.id]);
    res.json(staffJson(s));
  });

  r.get('/audit-logs', allow('audit.view'), async (req, res) => {
    const f = parse(z.object({ actorId: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }), req.query);
    const rows = await db.query(
      `select l.*, s.name as actor_name from audit_logs l left join staff_users s on s.id::text = l.actor_id
       where ($1::text is null or l.actor_id = $1) order by l.created_at desc limit $2`,
      [f.actorId ?? null, f.limit],
    );
    res.json(rows);
  });

  // ------------------------------------------------------------------ reports
  /** Monthly revenue and consumption per account, as JSON or CSV. */
  r.get('/reports/monthly', allow('billing.view'), async (req, res) => {
    const { period, format } = parse(
      z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), format: z.enum(['json', 'csv']).default('json') }),
      req.query,
    );
    const { start, end } = ctx.time.monthRange(period);
    const rows = await db.query(
      `select a.account_no, a.holder_name, z.name as zone, b.closing_l - b.opening_l as usage_l, b.current_cents, b.total_cents, b.status,
              (select coalesce(sum(amount_cents),0)::int from payments p where p.account_id = a.id and p.status = 'SUCCESS' and p.paid_at >= $2 and p.paid_at < $3) as paid_in_month
       from bills b join accounts a on a.id = b.account_id left join zones z on z.id = a.zone_id
       where b.period = $1 and b.status <> 'DRAFT' order by a.account_no`,
      [period, start, end],
    );
    const data = rows.map((x: any) => ({
      accountNo: x.account_no,
      holderName: x.holder_name,
      zone: x.zone,
      usageM3: Math.round(x.usage_l) / 1000,
      billedCents: x.current_cents,
      totalDueCents: x.total_cents,
      status: x.status,
      paidInMonthCents: x.paid_in_month,
    }));
    const totals = {
      accounts: data.length,
      usageM3: Math.round(data.reduce((s, d) => s + d.usageM3, 0) * 1000) / 1000,
      billedCents: data.reduce((s, d) => s + d.billedCents, 0),
      paidCents: data.reduce((s, d) => s + d.paidInMonthCents, 0),
    };
    if (format === 'csv') {
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['Account', 'Name', 'Zone', 'Usage m3', 'Billed Rs', 'Total due Rs', 'Status', 'Paid in month Rs'];
      const lines = data.map((d) =>
        [d.accountNo, d.holderName, d.zone, d.usageM3, (d.billedCents / 100).toFixed(2), (d.totalDueCents / 100).toFixed(2), d.status, (d.paidInMonthCents / 100).toFixed(2)]
          .map(esc)
          .join(','),
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="report-${period}.csv"`);
      res.send([header.map(esc).join(','), ...lines].join('\n'));
      return;
    }
    res.json({ period, totals, rows: data });
  });

  // Keep account balances in sync when staff view an account after payments.
  r.post('/accounts/:id/recompute', allow('payments.manage'), async (req, res) => {
    const a = await db.one(`select id from accounts where id::text = $1`, [pid(req)]);
    if (!a) throw notFound('Account');
    await recomputeAccount(ctx, a.id);
    res.json(await balance(ctx, a.id));
  });

  return r;
}
