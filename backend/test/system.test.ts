import mqtt, { type MqttClient } from 'mqtt';
import { io as ioClient } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leakRules } from '../src/services/jobs.js';
import { type RunningServer, startServer } from '../src/server.js';

/**
 * End-to-end: the real server (PGlite in memory, embedded broker on a random
 * port, demo seed) driven as the customer app, a meter and water board staff.
 */
let srv: RunningServer;
let api: ReturnType<typeof request>;
let customerToken = '';
let meter: MqttClient;
const P = 'swm/v1/meters';

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function staffToken(email: string, password: string) {
  const res = await api.post('/api/v1/admin/auth/login').send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** A fake meter that acknowledges valve commands like the firmware. */
async function connectMeter(id: string, secret: string) {
  const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${srv.mqttPort}`, { clientId: `meter-${id}`, username: id, password: secret, reconnectPeriod: 0 });
  await c.subscribeAsync(`${P}/${id}/down/#`, { qos: 1 });
  c.on('message', (topic, buf) => {
    if (!topic.endsWith('/down/cmd')) return;
    const cmd = JSON.parse(buf.toString());
    c.publish(`${P}/${id}/up/cmd-ack`, JSON.stringify({ cmdId: cmd.cmdId, state: 'RECEIVED' }), { qos: 1 });
    if (cmd.type.startsWith('VALVE_')) {
      const valve = cmd.type === 'VALVE_CLOSE' ? 'closed' : 'open';
      setTimeout(() => c.publish(`${P}/${id}/up/cmd-ack`, JSON.stringify({ cmdId: cmd.cmdId, state: 'EXECUTED', valve }), { qos: 1 }), 100);
    }
  });
  return c;
}

beforeAll(async () => {
  srv = await startServer({
    config: { DATABASE_URL: '', PGLITE_DIR: 'memory', SEED_DEMO: true, NODE_ENV: 'test', LOG_LEVEL: 'silent', EMBEDDED_BROKER: true, DEV_OTP: '123456' },
    httpPort: 0,
    mqttPort: 0,
    jobs: false,
  });
  api = request(`http://127.0.0.1:${srv.httpPort}`);
}, 120_000);

afterAll(async () => {
  await meter?.endAsync();
  await srv?.close();
});

describe('customer app API', () => {
  it('signs in with a one-time code and lists the demo accounts', async () => {
    await api.post('/api/v1/auth/otp/request').send({ identifier: '077 123 4567' }).expect(200);
    const res = await api.post('/api/v1/auth/otp/verify').send({ identifier: '0771234567', code: '123456' }).expect(200);
    expect(res.body.customer.name).toBe('Demo Customer');
    customerToken = res.body.accessToken;

    const accounts = await api.get('/api/v1/accounts').set(auth(customerToken)).expect(200);
    expect(accounts.body.map((a: any) => a.meterId).sort()).toEqual(['SWM-000123', 'SWM-000456']);
  });

  it('rotates refresh tokens', async () => {
    const login = await api.post('/api/v1/auth/otp/verify').send({ identifier: '0771234567', code: '123456' }).expect(200);
    const first = await api.post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    expect(first.body.accessToken).toBeTruthy();
    await api.post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401); // already used
  });

  it('returns the home summary, usage, bills and balance', async () => {
    const s = await api.get('/api/v1/meters/SWM-000123/summary').set(auth(customerToken)).expect(200);
    expect(s.body).toMatchObject({ meterId: 'SWM-000123', online: false, valve: 'open', budgetM3: 15 });
    expect(s.body.tariff.slabs).toHaveLength(3);
    expect(s.body.monthUsageM3).toBeGreaterThan(0);

    const week = await api.get('/api/v1/meters/SWM-000123/usage?range=week').set(auth(customerToken)).expect(200);
    expect(week.body.points).toHaveLength(7);
    expect(week.body.totalLiters).toBeGreaterThan(1000);

    const accounts = (await api.get('/api/v1/accounts').set(auth(customerToken))).body;
    const home = accounts.find((a: any) => a.meterId === 'SWM-000123');
    const bills = await api.get(`/api/v1/accounts/${home.id}/bills`).set(auth(customerToken)).expect(200);
    expect(bills.body).toHaveLength(3);
    expect(bills.body[1].status).toBe('PAID');
    expect(['PUBLISHED', 'OVERDUE']).toContain(bills.body[0].status);
    const tiers = bills.body[0].lines.filter((l: any) => l.kind === 'TIER');
    expect(tiers.length).toBeGreaterThan(0);

    const bal = await api.get(`/api/v1/accounts/${home.id}/balance`).set(auth(customerToken)).expect(200);
    expect(bal.body.amountDueCents).toBe(bills.body[0].totalCents);

    const est = await api.get(`/api/v1/bills/estimate?accountId=${home.id}`).set(auth(customerToken)).expect(200);
    expect(est.body.status).toBe('ESTIMATE');

    const pdf = await api.get(`/api/v1/bills/${bills.body[0].id}/pdf`).set(auth(customerToken)).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('does not show other customers’ meters', async () => {
    await api.get('/api/v1/meters/SWM-000555/summary').set(auth(customerToken)).expect(404);
    await api.get('/api/v1/meters/SWM-000123/summary').expect(401);
  });

  it('claims a new meter with its claim code', async () => {
    await api.post('/api/v1/meters/claim').set(auth(customerToken)).send({ meterId: 'SWM-000789', claimCode: 'WRONG-1' }).expect(400);
    const res = await api.post('/api/v1/meters/claim').set(auth(customerToken)).send({ meterId: 'swm-000789', claimCode: 'abcd-1234', label: 'Shop' }).expect(201);
    expect(res.body).toMatchObject({ meterId: 'SWM-000789', label: 'Shop' });
    await api.post('/api/v1/meters/claim').set(auth(customerToken)).send({ meterId: 'SWM-000789', claimCode: 'ABCD-1234' }).expect(409);
  });

  it('pays the balance and marks the bill paid', async () => {
    const home = (await api.get('/api/v1/accounts').set(auth(customerToken))).body.find((a: any) => a.meterId === 'SWM-000123');
    const before = (await api.get(`/api/v1/accounts/${home.id}/balance`).set(auth(customerToken))).body;
    await api.post('/api/v1/payments/checkout').set(auth(customerToken)).send({ accountId: home.id, amountCents: before.amountDueCents }).expect(201);
    const after = (await api.get(`/api/v1/accounts/${home.id}/balance`).set(auth(customerToken))).body;
    expect(after.amountDueCents).toBe(0);
    const bills = (await api.get(`/api/v1/accounts/${home.id}/bills`).set(auth(customerToken))).body;
    expect(bills[0].status).toBe('PAID');
  });
});

describe('meter over MQTT', () => {
  it('rejects wrong credentials and foreign topics', async () => {
    await expect(
      mqtt.connectAsync(`mqtt://127.0.0.1:${srv.mqttPort}`, { clientId: 'meter-SWM-000123', username: 'SWM-000123', password: 'wrong', reconnectPeriod: 0 }),
    ).rejects.toThrow();
    await expect(
      mqtt.connectAsync(`mqtt://127.0.0.1:${srv.mqttPort}`, { clientId: 'not-a-meter', username: 'SWM-000123', password: 'demo-secret-123', reconnectPeriod: 0 }),
    ).rejects.toThrow();

    meter = await connectMeter('SWM-000123', 'demo-secret-123');
    // Another meter's topic is refused (SUBACK 128) but the meter stays connected.
    await expect(meter.subscribeAsync(`${P}/SWM-000456/down/cmd`, { qos: 1 })).rejects.toThrow(/Subscribe error/);
    expect(meter.connected).toBe(true);
  });

  it('ingests status and telemetry, idempotently', async () => {
    const before = (await srv.ctx.db.one<{ total_l: number }>(`select total_l from meters where id = 'SWM-000123'`))!.total_l;
    meter.publish(`${P}/SWM-000123/up/status`, JSON.stringify({ online: true, fw: '1.3.0' }), { qos: 1, retain: true });
    const reading = { seq: 17_000_000_001, ts: Math.floor(Date.now() / 1000), totalL: before + 120, flowLpm: 6.5, valve: 'open' };
    meter.publish(`${P}/SWM-000123/up/telemetry`, JSON.stringify(reading), { qos: 1 });
    meter.publish(`${P}/SWM-000123/up/telemetry`, JSON.stringify(reading), { qos: 1 }); // duplicate

    const s = await until(async () => {
      const r = await api.get('/api/v1/meters/SWM-000123/summary').set(auth(customerToken));
      return r.body.online && r.body.totalL === before + 120 ? r.body : null;
    });
    expect(s.flowLpm).toBe(6.5);
    expect(s.fw).toBe('1.3.0');
    const n = await srv.ctx.db.one<{ n: number }>(`select count(*)::int as n from readings where meter_id = 'SWM-000123' and seq = 17000000001`);
    expect(n!.n).toBe(1);
  });

  it('repairs timestamps of SD-buffered readings taken before the clock was set', async () => {
    const base = (await srv.ctx.db.one<{ total_l: number }>(`select total_l from meters where id = 'SWM-000123'`))!.total_l;
    const nowSec = Math.floor(Date.now() / 1000);
    meter.publish(
      `${P}/SWM-000123/up/backlog`,
      JSON.stringify({
        items: [
          { seq: 17_000_000_002, ts: 0, bootId: 'b1', upMs: 10_000, totalL: base + 1 },
          { seq: 17_000_000_003, ts: 0, bootId: 'b1', upMs: 70_000, totalL: base + 2 },
          { seq: 17_000_000_004, ts: nowSec, bootId: 'b1', upMs: 130_000, totalL: base + 3 },
        ],
      }),
      { qos: 1 },
    );
    const rows = await until(async () => {
      const r = await srv.ctx.db.query<{ seq: number; ts: Date; ts_corrected: boolean }>(
        `select seq, ts, ts_corrected from readings where meter_id = 'SWM-000123' and seq in (17000000002, 17000000003) order by seq`,
      );
      return r.length === 2 && r.every((x) => x.ts_corrected) ? r : null;
    });
    expect(Math.round(new Date(rows[0].ts).getTime() / 1000)).toBe(nowSec - 120);
    expect(Math.round(new Date(rows[1].ts).getTime() / 1000)).toBe(nowSec - 60);
  });

  it('closes the valve from the app with the full command lifecycle', async () => {
    const socket = ioClient(`http://127.0.0.1:${srv.httpPort}`, { auth: { token: customerToken }, transports: ['websocket'] });
    const events: any[] = [];
    socket.on('meter:valve', (e) => events.push(e));
    await until(async () => socket.connected);
    socket.emit('subscribe', { meterId: 'SWM-000123' });
    await new Promise((r) => setTimeout(r, 100));

    const res = await api.post('/api/v1/meters/SWM-000123/valve').set(auth(customerToken)).send({ action: 'CLOSE' }).expect(202);
    const cmdId = res.body.cmdId;
    await until(async () => events.find((e) => e.cmdId === cmdId && e.state === 'CONFIRMED'));
    expect(events.filter((e) => e.cmdId === cmdId).map((e) => e.state)).toEqual(['SENT', 'RECEIVED', 'CONFIRMED']);

    const s = await api.get('/api/v1/meters/SWM-000123/summary').set(auth(customerToken)).expect(200);
    expect(s.body.valve).toBe('closed');
    await api.post('/api/v1/meters/SWM-000123/valve').set(auth(customerToken)).send({ action: 'OPEN' }).expect(202);
    socket.close();
  });

  it('refuses valve commands for an offline meter', async () => {
    const r = await api.post('/api/v1/meters/SWM-000456/valve').set(auth(customerToken)).send({ action: 'CLOSE' }).expect(409);
    expect(r.body.message).toMatch(/offline/);
  });

  it('raises a leak alert after hours of continuous flow', async () => {
    const m = (await srv.ctx.db.one<{ total_l: number }>(`select total_l from meters where id = 'SWM-000456'`))!;
    const now = Date.now();
    // Replace the seeded hourly history for the last few hours with 15-minute readings of steady flow.
    await srv.ctx.db.query(`delete from readings where meter_id = 'SWM-000456' and ts > $1`, [new Date(now - 5 * 3600_000)]);
    for (let i = 0; i <= 16; i++) {
      await srv.ctx.db.query(`insert into readings (meter_id, seq, ts, total_l) values ('SWM-000456', $1, $2, $3)`, [
        8_000_000 + i,
        new Date(now - (16 - i) * 15 * 60_000),
        m.total_l + 50 + i * 20,
      ]);
    }
    await leakRules(srv.ctx);
    const alerts = (await api.get('/api/v1/alerts').set(auth(customerToken))).body;
    expect(alerts.find((a: any) => a.type === 'LEAK' && a.meterId === 'SWM-000456')).toBeTruthy();
  });
});

describe('water board portal', () => {
  it('enforces roles and shows dashboard stats', async () => {
    const auditor = await staffToken('auditor@swm.local', 'Audit@123');
    await api.post('/api/v1/admin/meters').set(auth(auditor)).send({}).expect(403);
    const stats = await api.get('/api/v1/admin/stats/overview').set(auth(auditor)).expect(200);
    expect(stats.body.meters.total).toBe(5);
    await api.get('/api/v1/admin/stats/overview').set(auth(customerToken)).expect(403);
  });

  it('runs a billing cycle with the two-officer rule', async () => {
    const { db } = srv.ctx;
    const last = await db.one<{ id: number; period: string }>(`select id, period from billing_cycles order by period desc limit 1`);
    // Re-run the most recent month from scratch through the API.
    await db.query(`delete from payments where account_id in (select account_id from bills where cycle_id = $1)`, [last!.id]);
    await db.query(`delete from bills where cycle_id = $1`, [last!.id]);
    await db.query(`delete from billing_cycles where id = $1`, [last!.id]);

    const b1 = await staffToken('billing@swm.local', 'Billing@123');
    const b2 = await staffToken('billing2@swm.local', 'Billing@123');
    const cycle = (await api.post('/api/v1/admin/billing-cycles').set(auth(b1)).send({ period: last!.period }).expect(201)).body;
    expect(cycle.accounts).toBe(4);
    await api.post('/api/v1/admin/billing-cycles').set(auth(b1)).send({ period: last!.period }).expect(409);

    const flagged = (await api.get(`/api/v1/admin/billing-cycles/${cycle.id}/items?flagged=true`).set(auth(b1)).expect(200)).body;
    for (const item of flagged) {
      await api.patch(`/api/v1/admin/billing-cycles/${cycle.id}/items/${item.accountId}`).set(auth(b1)).send({ resolution: 'HOLD' }).expect(200);
    }
    const gen = (await api.post(`/api/v1/admin/billing-cycles/${cycle.id}/generate`).set(auth(b1)).expect(200)).body;
    expect(gen.generated).toBeGreaterThan(0);
    await api.post(`/api/v1/admin/billing-cycles/${cycle.id}/approve`).set(auth(b1)).expect(403);
    await api.post(`/api/v1/admin/billing-cycles/${cycle.id}/approve`).set(auth(b2)).expect(200);
    const pub = (await api.post(`/api/v1/admin/billing-cycles/${cycle.id}/publish`).set(auth(b1)).expect(200)).body;
    expect(pub.state).toBe('PUBLISHED');
    expect(pub.totalCents).toBeGreaterThan(0);

    const csv = await api.get(`/api/v1/admin/reports/monthly?period=${last!.period}&format=csv`).set(auth(b1)).expect(200);
    expect(csv.text.split('\n').length).toBeGreaterThan(1);
  });

  it('needs a second officer to approve a board valve shut-off', async () => {
    const ops = await staffToken('ops@swm.local', 'Ops@12345');
    const admin = await staffToken('admin@swm.local', 'Admin@123');
    const req = (await api.post('/api/v1/admin/valve-requests').set(auth(ops)).send({ meterId: 'SWM-000123', action: 'CLOSE', reason: 'Unpaid for 3 months' }).expect(201)).body;
    expect(req.state).toBe('AWAITING_APPROVAL');
    await api.post(`/api/v1/admin/valve-requests/${req.id}/approve`).set(auth(ops)).expect(403);
    const ok = (await api.post(`/api/v1/admin/valve-requests/${req.id}/approve`).set(auth(admin)).expect(200)).body;
    expect(ok.state).toBe('SENT');
    await until(async () => (await srv.ctx.db.one(`select 1 from commands where id = $1 and state = 'CONFIRMED'`, [req.id])) ?? null);

    // The customer cannot reopen a supply the board closed.
    const r = await api.post('/api/v1/meters/SWM-000123/valve').set(auth(customerToken)).send({ action: 'OPEN' }).expect(403);
    expect(r.body.message).toMatch(/water board/);

    const logs = (await api.get('/api/v1/admin/audit-logs').set(auth(admin)).expect(200)).body;
    expect(logs.some((l: any) => String(l.action).includes('valve-requests'))).toBe(true);
  });

  it('registers a meter and returns its one-time credentials', async () => {
    const ops = await staffToken('ops@swm.local', 'Ops@12345');
    const m = (await api.post('/api/v1/admin/meters').set(auth(ops)).send({ id: 'SWM-777777' }).expect(201)).body;
    expect(m.deviceSecret).toBeTruthy();
    expect(m.qr).toContain('swm://claim?meter=SWM-777777');
    const c = await mqtt.connectAsync(`mqtt://127.0.0.1:${srv.mqttPort}`, { clientId: 'meter-SWM-777777', username: 'SWM-777777', password: m.deviceSecret, reconnectPeriod: 0 });
    await c.endAsync();
  });

  it('suspends the account on disconnection and reactivates it on reconnection', async () => {
    const admin = await staffToken('admin@swm.local', 'Admin@123');
    const ops = await staffToken('ops@swm.local', 'Ops@12345');
    // The previous test closed SWM-000123 for non-payment.
    const arrears = (await api.get('/api/v1/admin/arrears').set(auth(admin)).expect(200)).body;
    const row = arrears.find((a: any) => a.meterId === 'SWM-000123');
    expect(row).toMatchObject({ accountStatus: 'SUSPENDED', valve: 'closed', pendingRequest: null });

    const alerts = (await api.get('/api/v1/alerts').set(auth(customerToken))).body;
    expect(alerts.find((a: any) => a.title === 'Water supply disconnected')).toBeTruthy();

    // Closing again is refused; reconnection needs a second officer too.
    await api.post('/api/v1/admin/valve-requests').set(auth(ops)).send({ meterId: 'SWM-000123', action: 'CLOSE', reason: 'Duplicate request' }).expect(409);
    const req = (await api.post('/api/v1/admin/valve-requests').set(auth(ops)).send({ meterId: 'SWM-000123', action: 'OPEN', reason: 'Balance settled at counter' }).expect(201)).body;
    await api.post('/api/v1/admin/valve-requests').set(auth(admin)).send({ meterId: 'SWM-000123', action: 'OPEN', reason: 'Second request' }).expect(409);
    await api.post(`/api/v1/admin/valve-requests/${req.id}/approve`).set(auth(admin)).expect(200);
    await until(async () => (await srv.ctx.db.one(`select 1 from accounts a join meters m on m.account_id = a.id where m.id = 'SWM-000123' and a.status = 'ACTIVE'`)) ?? null);

    const list = (await api.get('/api/v1/admin/valve-requests').set(auth(admin)).expect(200)).body;
    expect(list.find((x: any) => x.id === req.id)).toMatchObject({ state: 'CONFIRMED', accountNo: 'SW-100001', approvedByName: 'Admin User' });
  });

  it('registers a consumer at the counter who can then sign in to the app', async () => {
    const cs = await staffToken('cs@swm.local', 'Support@123');
    const auditor = await staffToken('auditor@swm.local', 'Audit@123');
    const body = {
      customer: { name: 'Kamala Perera', phone: '071 555 0101' },
      account: { address: '21 Station Road, Kotte', zoneId: 1, label: 'Home' },
      meter: { mode: 'new' },
    };
    await api.post('/api/v1/admin/registrations').set(auth(auditor)).send(body).expect(403);
    const reg = (await api.post('/api/v1/admin/registrations').set(auth(cs)).send(body).expect(201)).body;
    expect(reg.customer.phone).toBe('+94715550101');
    expect(reg.account.accountNo).toMatch(/^SW-\d+$/);
    expect(reg.meter.meterId).toMatch(/^SWM-\d{6}$/);
    expect(reg.meter.deviceSecret).toBeTruthy();
    await api.post('/api/v1/admin/registrations').set(auth(cs)).send(body).expect(409); // same phone

    // Existing unassigned meter for a second connection of the same consumer.
    const second = (await api.post('/api/v1/admin/registrations').set(auth(cs))
      .send({ customer: { existingId: reg.customer.id }, account: { address: 'Shop 4, Market Street', label: 'Shop' }, meter: { mode: 'existing', meterId: 'SWM-000999' } })
      .expect(201)).body;
    expect(second.account.meterId).toBe('SWM-000999');

    const login = (await api.post('/api/v1/auth/otp/verify').send({ identifier: '0715550101', code: '123456' }).expect(200)).body;
    const accounts = (await api.get('/api/v1/accounts').set(auth(login.accessToken)).expect(200)).body;
    expect(accounts.map((a: any) => a.label).sort()).toEqual(['Home', 'Shop']);
  });

  it('manages staff accounts', async () => {
    const admin = await staffToken('admin@swm.local', 'Admin@123');
    const ops = await staffToken('ops@swm.local', 'Ops@12345');
    await api.get('/api/v1/admin/users').set(auth(ops)).expect(403);
    const u = (await api.post('/api/v1/admin/users').set(auth(admin)).send({ name: 'New Officer', email: 'new@swm.local', password: 'Welcome@123', role: 'BILLING_OFFICER' }).expect(201)).body;
    await staffToken('new@swm.local', 'Welcome@123');
    await api.patch(`/api/v1/admin/users/${u.id}`).set(auth(admin)).send({ role: 'CUSTOMER_SERVICE', name: 'Renamed Officer' }).expect(200);
    await api.patch(`/api/v1/admin/users/${u.id}`).set(auth(admin)).send({ active: false }).expect(200);
    await api.post('/api/v1/admin/auth/login').send({ email: 'new@swm.local', password: 'Welcome@123' }).expect(401);
  });
});
