import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { randomToken, verifySecret } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import {
  accountJson,
  assertAccountAccess,
  assertMeterAccess,
  balance,
  customerAccounts,
  nextAccountNo,
  recomputeAccount,
} from '../services/accounts.js';
import { alertJson, raiseAlert } from '../services/alerts.js';
import { customerJson, requestOtp, revokeRefresh, rotateRefresh, verifyOtp } from '../services/auth.js';
import { billJson, currentEstimate } from '../services/billing.js';
import { customerValve, startLive } from '../services/commands.js';
import { meterSummary } from '../services/meters.js';
import { billPdf } from '../services/pdf.js';
import { priceUsage, sumCents } from '../services/pricing.js';
import { type UsageRange, usageSeries } from '../services/readings.js';
import { tariffAt, tariffJson } from '../services/tariffs.js';
import { parse, requireCustomer } from './middleware.js';

const settingsSchema = z.object({
  budgetM3: z.number().positive().max(10_000).nullable().optional(),
  leakAlerts: z.boolean().optional(),
  usageAlerts: z.boolean().optional(),
  billAlerts: z.boolean().optional(),
  awayMode: z.boolean().optional(),
  emergencyContact: z.string().trim().max(32).nullable().optional(),
});

const settingsJson = (s: any) => ({
  budgetM3: s?.budget_m3 ?? null,
  leakAlerts: s?.leak_alerts ?? true,
  usageAlerts: s?.usage_alerts ?? true,
  billAlerts: s?.bill_alerts ?? true,
  awayMode: s?.away_mode ?? false,
  emergencyContact: s?.emergency_contact ?? null,
});

const ticketJson = (t: any) => ({
  id: t.id,
  accountId: t.account_id,
  category: t.category,
  subject: t.subject,
  description: t.description,
  status: t.status,
  resolutionNote: t.resolution_note,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
});

/** Customer app API (Flutter mobile + web). */
export function customerRouter(ctx: AppContext): Router {
  const r = Router();
  const { db } = ctx;

  // ------------------------------------------------------------- auth (public)
  r.post('/auth/otp/request', async (req, res) => {
    const { identifier } = parse(z.object({ identifier: z.string().min(3).max(100) }), req.body);
    await requestOtp(ctx, identifier);
    res.json({ sent: true });
  });

  r.post('/auth/otp/verify', async (req, res) => {
    const { identifier, code } = parse(z.object({ identifier: z.string().min(3).max(100), code: z.string().regex(/^\d{6}$/) }), req.body);
    res.json(await verifyOtp(ctx, identifier, code));
  });

  r.post('/auth/refresh', async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(10) }), req.body);
    res.json(await rotateRefresh(ctx, refreshToken, 'customer'));
  });

  r.post('/auth/logout', async (req, res) => {
    await revokeRefresh(ctx, (req.body as { refreshToken?: string })?.refreshToken);
    res.json({ ok: true });
  });

  r.get('/tariffs/active', async (_req, res) => {
    res.json(tariffJson(await tariffAt(db, ctx.now())));
  });

  r.post('/tariffs/calculate', async (req, res) => {
    const { usageM3 } = parse(z.object({ usageM3: z.number().min(0).max(100_000) }), req.body);
    const lines = priceUsage(usageM3, await tariffAt(db, ctx.now()));
    res.json({ usageM3, lines, totalCents: sumCents(lines) });
  });

  // ------------------------------------------------------------ signed in only
  r.use(requireCustomer(ctx));
  const me = (req: { auth?: { sub: string } }) => req.auth!.sub;

  r.get('/me', async (req, res) => {
    const c = await db.one(`select * from customers where id = $1`, [me(req)]);
    if (!c) throw notFound('Customer');
    res.json(customerJson(c));
  });

  r.patch('/me', async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        email: z.string().trim().toLowerCase().email().nullable().optional(),
        phone: z.string().trim().max(20).nullable().optional(),
      }),
      req.body,
    );
    try {
      const c = await db.one(
        `update customers set name = $2, email = coalesce($3, email), phone = coalesce($4, phone) where id = $1 returning *`,
        [me(req), body.name, body.email ?? null, body.phone ?? null],
      );
      res.json(customerJson(c));
    } catch (e: any) {
      if (String(e?.message).includes('unique')) throw conflict('That phone number or email is used by another account');
      throw e;
    }
  });

  r.post('/me/fcm-token', async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(4096) }), req.body);
    await db.query(`update customers set fcm_tokens = array(select distinct unnest(fcm_tokens || $2::text[])) where id = $1`, [me(req), [token]]);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------- accounts/meters
  r.get('/accounts', async (req, res) => {
    const rows = await customerAccounts(db, me(req));
    res.json(rows.filter((a) => a.meter_id).map(accountJson));
  });

  r.post('/meters/claim', async (req, res) => {
    const body = parse(
      z.object({ meterId: z.string().trim().min(3).max(32), claimCode: z.string().trim().min(4).max(32), label: z.string().trim().max(40).optional() }),
      req.body,
    );
    const meterId = body.meterId.toUpperCase();
    const meter = await db.one<{ id: string; account_id: string | null; claim_code_hash: string }>(`select * from meters where id = $1`, [meterId]);
    if (!meter || !(await verifySecret(body.claimCode.toUpperCase(), meter.claim_code_hash))) {
      throw badRequest('Meter ID or claim code is incorrect.');
    }
    const label = body.label || 'Home';
    const customerId = me(req);
    const accountId = await db.tx(async (t) => {
      if (meter.account_id) {
        const owner = await t.one<{ customer_id: string }>(`select customer_id from account_members where account_id = $1 and role = 'OWNER'`, [meter.account_id]);
        if (owner?.customer_id === customerId) throw conflict('This meter is already linked to your account.');
        if (owner) throw conflict('This meter is already linked to another customer. Ask them to add you as a family member.');
        await t.query(`insert into account_members (account_id, customer_id, role, label) values ($1,$2,'OWNER',$3)`, [meter.account_id, customerId, label]);
        return meter.account_id;
      }
      const c = await t.one<{ name: string }>(`select name from customers where id = $1`, [customerId]);
      const a = await t.one<{ id: string }>(
        `insert into accounts (account_no, holder_name) values ($1,$2) returning id`,
        [await nextAccountNo(t), c?.name || 'Customer'],
      );
      await t.query(`insert into account_settings (account_id) values ($1)`, [a!.id]);
      await t.query(`insert into account_members (account_id, customer_id, role, label) values ($1,$2,'OWNER',$3)`, [a!.id, customerId, label]);
      await t.query(`update meters set account_id = $2 where id = $1`, [meterId, a!.id]);
      return a!.id;
    });
    res.status(201).json(accountJson(await assertAccountAccess(db, customerId, accountId)));
  });

  r.get('/meters/:id/summary', async (req, res) => {
    const acct = await assertMeterAccess(db, me(req), req.params.id);
    res.json(await meterSummary(ctx, req.params.id, acct.id));
  });

  r.post('/meters/:id/live', async (req, res) => {
    await assertMeterAccess(db, me(req), req.params.id);
    res.json(await startLive(ctx, req.params.id));
  });

  r.post('/meters/:id/valve', async (req, res) => {
    const { action } = parse(z.object({ action: z.enum(['OPEN', 'CLOSE']) }), req.body);
    await assertMeterAccess(db, me(req), req.params.id);
    res.status(202).json(await customerValve(ctx, req.params.id, me(req), action === 'OPEN'));
  });

  r.get('/meters/:id/usage', async (req, res) => {
    const { range } = parse(z.object({ range: z.enum(['day', 'week', 'month']).default('week') }), req.query);
    await assertMeterAccess(db, me(req), req.params.id);
    res.json(await usageSeries(ctx, req.params.id, range as UsageRange));
  });

  // ------------------------------------------------------------------ billing
  r.get('/accounts/:id/balance', async (req, res) => {
    await assertAccountAccess(db, me(req), req.params.id);
    res.json(await balance(ctx, req.params.id));
  });

  r.get('/accounts/:id/bills', async (req, res) => {
    await assertAccountAccess(db, me(req), req.params.id);
    await recomputeAccount(ctx, req.params.id);
    const bills = await db.query(`select * from bills where account_id = $1 and status <> 'DRAFT' order by period desc limit 24`, [req.params.id]);
    res.json(await Promise.all(bills.map((b) => billJson(db, b))));
  });

  r.get('/bills/estimate', async (req, res) => {
    const { accountId } = parse(z.object({ accountId: z.string().uuid() }), req.query);
    const acct = await assertAccountAccess(db, me(req), accountId);
    if (!acct.meter_id) throw notFound('Meter');
    res.json(await currentEstimate(ctx, accountId, acct.meter_id));
  });

  const loadBill = async (customerId: string, billId: string) => {
    const bill = await db.one(`select * from bills where id = $1 and status <> 'DRAFT'`, [billId]);
    if (!bill) throw notFound('Bill');
    const acct = await assertAccountAccess(db, customerId, bill.account_id);
    return { bill: await billJson(db, bill), acct };
  };

  r.get('/bills/:id', async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Bill');
    res.json((await loadBill(me(req), req.params.id)).bill);
  });

  r.get('/bills/:id/pdf', async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Bill');
    const { bill, acct } = await loadBill(me(req), req.params.id);
    const pdf = await billPdf(bill, acct);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bill-${acct.account_no}-${bill.period.slice(0, 7)}.pdf"`);
    res.send(pdf);
  });

  /**
   * Sandbox checkout: records the payment as successful immediately. A real
   * gateway (e.g. PayHere) would return a checkout URL here and confirm the
   * payment later through a webhook.
   */
  r.post('/payments/checkout', async (req, res) => {
    const { accountId, amountCents, method } = parse(
      z.object({ accountId: z.string().uuid(), amountCents: z.number().int().positive().max(100_000_000), method: z.enum(['CARD', 'WALLET']).default('CARD') }),
      req.body,
    );
    await assertAccountAccess(db, me(req), accountId);
    const reference = `PAY-${randomToken(6).toUpperCase()}`;
    const p = await db.one<{ id: string }>(
      `insert into payments (account_id, amount_cents, method, reference, status, paid_at) values ($1,$2,$3,$4,'SUCCESS',now()) returning id`,
      [accountId, amountCents, method, reference],
    );
    await recomputeAccount(ctx, accountId);
    await raiseAlert(ctx, {
      accountId,
      type: 'BILLING',
      severity: 'INFO',
      title: 'Payment received',
      message: `Thank you. Rs. ${(amountCents / 100).toFixed(2)} received (ref ${reference}).`,
      dedupeKey: `payment:${p!.id}`,
    });
    res.status(201).json({ status: 'SUCCESS', reference, amountCents, paymentId: p!.id });
  });

  r.get('/accounts/:id/payments', async (req, res) => {
    await assertAccountAccess(db, me(req), req.params.id);
    const rows = await db.query(`select * from payments where account_id = $1 order by created_at desc limit 50`, [req.params.id]);
    res.json(rows.map((p: any) => ({ id: p.id, amountCents: p.amount_cents, method: p.method, reference: p.reference, status: p.status, paidAt: p.paid_at })));
  });

  // --------------------------------------------------------- alerts/settings
  r.get('/alerts', async (req, res) => {
    const rows = await db.query(
      `select a.* from alerts a join account_members m on m.account_id = a.account_id
       where m.customer_id = $1 order by a.created_at desc limit 100`,
      [me(req)],
    );
    res.json(rows.map(alertJson));
  });

  r.patch('/alerts/:id', async (req, res) => {
    const { read } = parse(z.object({ read: z.boolean() }), req.body);
    const row = await db.one(
      `update alerts a set read = $3 from account_members m
       where a.id::text = $1 and m.account_id = a.account_id and m.customer_id = $2 returning a.*`,
      [req.params.id, me(req), read],
    );
    if (!row) throw notFound('Alert');
    res.json(alertJson(row));
  });

  r.get('/accounts/:id/settings', async (req, res) => {
    await assertAccountAccess(db, me(req), req.params.id);
    res.json(settingsJson(await db.one(`select * from account_settings where account_id = $1`, [req.params.id])));
  });

  r.put('/accounts/:id/settings', async (req, res) => {
    const s = parse(settingsSchema, req.body);
    await assertAccountAccess(db, me(req), req.params.id);
    if (s.awayMode && !s.emergencyContact) throw badRequest('Add an emergency contact to turn on Away Mode');
    const row = await db.one(
      `insert into account_settings (account_id, budget_m3, leak_alerts, usage_alerts, bill_alerts, away_mode, emergency_contact)
       values ($1,$2,coalesce($3,true),coalesce($4,true),coalesce($5,true),coalesce($6,false),$7)
       on conflict (account_id) do update set budget_m3 = excluded.budget_m3,
         leak_alerts = coalesce($3, account_settings.leak_alerts), usage_alerts = coalesce($4, account_settings.usage_alerts),
         bill_alerts = coalesce($5, account_settings.bill_alerts), away_mode = coalesce($6, account_settings.away_mode),
         emergency_contact = excluded.emergency_contact
       returning *`,
      [req.params.id, s.budgetM3 ?? null, s.leakAlerts ?? null, s.usageAlerts ?? null, s.billAlerts ?? null, s.awayMode ?? null, s.emergencyContact || null],
    );
    res.json(settingsJson(row));
  });

  // ------------------------------------------------------------------ tickets
  r.get('/tickets', async (req, res) => {
    const rows = await db.query(`select * from tickets where customer_id = $1 order by created_at desc`, [me(req)]);
    res.json(rows.map(ticketJson));
  });

  r.post('/tickets', async (req, res) => {
    const body = parse(
      z.object({
        category: z.string().trim().min(2).max(40),
        subject: z.string().trim().min(3).max(120),
        description: z.string().trim().max(2000).default(''),
        accountId: z.string().uuid().optional(),
      }),
      req.body,
    );
    let accountId = body.accountId ?? null;
    if (accountId) await assertAccountAccess(db, me(req), accountId);
    else accountId = (await customerAccounts(db, me(req)))[0]?.id ?? null;
    const t = await db.one(
      `insert into tickets (customer_id, account_id, category, subject, description) values ($1,$2,$3,$4,$5) returning *`,
      [me(req), accountId, body.category, body.subject, body.description],
    );
    res.status(201).json(ticketJson(t));
  });

  return r;
}

export { ticketJson };
