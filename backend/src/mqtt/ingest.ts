import type { ZodType } from 'zod';
import type { AppContext } from '../context.js';
import { raiseAlert, resolveAlerts } from '../services/alerts.js';
import { handleAck } from '../services/commands.js';
import { insertReadings, repairTimestamps } from '../services/readings.js';
import {
  backlogSchema,
  cmdAckSchema,
  eventSchema,
  heartbeatSchema,
  liveSchema,
  parseTopic,
  type Reading,
  statusSchema,
  telemetrySchema,
} from './contract.js';

/**
 * Handles every message a meter publishes. Messages for the same meter are
 * processed in order; different meters are processed concurrently.
 */
export class Ingest {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly ctx: AppContext) {}

  handle(topic: string, payload: Buffer): Promise<void> {
    const t = parseTopic(topic);
    if (!t || t.dir !== 'up') return Promise.resolve();
    const prev = this.queues.get(t.meterId) ?? Promise.resolve();
    const next = prev
      .then(() => this.process(t.meterId, t.kind, payload))
      .catch((err) => this.ctx.log.error({ err, topic }, 'ingest: failed to process message'));
    this.queues.set(t.meterId, next);
    void next.finally(() => {
      if (this.queues.get(t.meterId) === next) this.queues.delete(t.meterId);
    });
    return next;
  }

  /** Wait until all queued messages are processed (used by tests and shutdown). */
  async drain(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  private parse<T>(schema: ZodType<T>, meterId: string, kind: string, payload: Buffer): T | null {
    let json: unknown;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch {
      this.ctx.log.warn({ meterId, kind }, 'ingest: payload is not JSON');
      return null;
    }
    const res = schema.safeParse(json);
    if (!res.success) {
      this.ctx.log.warn({ meterId, kind, issues: res.error.issues.slice(0, 3) }, 'ingest: invalid payload');
      return null;
    }
    return res.data;
  }

  private async process(meterId: string, kind: string, payload: Buffer): Promise<void> {
    const { db } = this.ctx;
    const meter = await db.one<{ id: string; account_id: string | null; online: boolean; total_l: number; on_battery: boolean }>(
      `select id, account_id, online, total_l, on_battery from meters where id = $1`,
      [meterId],
    );
    if (!meter) return; // the broker only admits registered meters; ignore stale retained messages

    switch (kind) {
      case 'status': {
        const m = this.parse(statusSchema, meterId, kind, payload);
        if (m) await this.onStatus(meter, m.online, m.fw);
        return;
      }
      case 'telemetry': {
        const m = this.parse(telemetrySchema, meterId, kind, payload);
        if (m) await this.onReadings(meter, [m], false);
        return;
      }
      case 'backlog': {
        const m = this.parse(backlogSchema, meterId, kind, payload);
        if (m) await this.onReadings(meter, m.items, true);
        return;
      }
      case 'live': {
        const m = this.parse(liveSchema, meterId, kind, payload);
        if (!m) return;
        await db.query(
          `update meters set flow_lpm = $2, total_l = greatest(total_l, $3), online = true, last_seen_at = now() where id = $1`,
          [meterId, m.flowLpm, m.totalL],
        );
        this.ctx.bus.emit('meter:live', { meterId, flowLpm: m.flowLpm, totalL: Math.max(m.totalL, meter.total_l), ts: m.ts || nowSec(this.ctx) });
        return;
      }
      case 'heartbeat': {
        const m = this.parse(heartbeatSchema, meterId, kind, payload);
        if (m) await this.onHeartbeat(meter, m);
        return;
      }
      case 'event': {
        const m = this.parse(eventSchema, meterId, kind, payload);
        if (m) await this.onEvent(meter, m);
        return;
      }
      case 'cmd-ack': {
        const m = this.parse(cmdAckSchema, meterId, kind, payload);
        if (m) await handleAck(this.ctx, meterId, { ...m, valve: m.valve, err: m.err });
        return;
      }
      default:
        this.ctx.log.debug({ meterId, kind }, 'ingest: unknown topic');
    }
  }

  private async onStatus(meter: { id: string; account_id: string | null; online: boolean }, online: boolean, fw?: string) {
    const { db } = this.ctx;
    const row = await db.one<{ last_seen_at: Date; rssi: number | null }>(
      `update meters set online = $2, fw_version = coalesce($3, fw_version),
              last_seen_at = case when $2 then now() else last_seen_at end
       where id = $1 returning last_seen_at, rssi`,
      [meter.id, online, fw ?? null],
    );
    if (online && !meter.online) await this.onBackOnline(meter);
    this.ctx.bus.emit('meter:status', {
      meterId: meter.id,
      online,
      lastSeenAt: (row?.last_seen_at ?? new Date()).toISOString(),
      rssi: row?.rssi,
    });
  }

  private async onBackOnline(meter: { id: string; account_id: string | null }) {
    const resolved = await resolveAlerts(this.ctx, meter.id, 'DEVICE');
    if (resolved > 0) {
      await raiseAlert(this.ctx, {
        accountId: meter.account_id,
        meterId: meter.id,
        type: 'DEVICE',
        severity: 'INFO',
        title: 'Meter back online',
        message: `${meter.id} reconnected. Any readings stored while offline will be uploaded automatically.`,
        dedupeKey: `online:${meter.id}:${this.ctx.now().toISOString().slice(0, 16)}`,
      });
    }
  }

  private async onReadings(meter: { id: string; account_id: string | null; online: boolean; total_l: number }, items: Reading[], backlog: boolean) {
    const ctx = this.ctx;
    const receivedAt = ctx.now();
    const sorted = [...items].sort((a, b) => a.seq - b.seq);
    const latest = sorted[sorted.length - 1];

    const prev = await ctx.db.one<{ total_l: number }>(
      `select total_l from readings where meter_id = $1 and seq < $2 order by seq desc limit 1`,
      [meter.id, sorted[0].seq],
    );
    const inserted = await insertReadings(ctx.db, meter.id, sorted, { backlog, receivedAt });
    for (const r of sorted) if (r.ts > 0 && r.bootId) await repairTimestamps(ctx.db, meter.id, r);

    const newest = await ctx.db.one<{ seq: number }>(`select max(seq) as seq from readings where meter_id = $1`, [meter.id]);
    const isLatest = newest?.seq === latest.seq;
    if (isLatest) {
      await ctx.db.query(
        `update meters set total_l = $2, flow_lpm = coalesce($3, flow_lpm), valve_state = coalesce($4, valve_state),
                online = true, last_seen_at = now() where id = $1`,
        [meter.id, latest.totalL, backlog ? 0 : (latest.flowLpm ?? null), latest.valve ?? null],
      );
    } else {
      await ctx.db.query(`update meters set online = true, last_seen_at = now() where id = $1`, [meter.id]);
    }
    if (!meter.online) await this.onBackOnline(meter);
    if (backlog) ctx.log.info({ meterId: meter.id, received: items.length, inserted }, 'ingest: backlog uploaded');
    if (inserted === 0) return;

    // Cumulative totals never go down. A drop means a reset, a fault or tampering.
    let last = prev?.total_l ?? null;
    for (const r of sorted) {
      if (last !== null && r.totalL < last - 1) {
        await raiseAlert(ctx, {
          accountId: meter.account_id,
          meterId: meter.id,
          type: 'DEVICE',
          severity: 'CRITICAL',
          title: 'Meter reading went backwards',
          message: `The total on ${meter.id} dropped from ${last.toFixed(1)} L to ${r.totalL.toFixed(1)} L. This needs inspection.`,
          dedupeKey: `tamper:${meter.id}:${r.seq}`,
        });
      }
      last = r.totalL;
    }

    if (backlog || !isLatest) return;
    const flow = latest.flowLpm ?? 0;
    ctx.bus.emit('meter:live', { meterId: meter.id, flowLpm: flow, totalL: latest.totalL, ts: latest.ts || nowSec(ctx) });
    const day = ctx.time.periodOf(receivedAt) + '-' + ctx.time.parts(receivedAt).day;

    if (latest.valve === 'closed' && flow > 0.5) {
      await raiseAlert(ctx, {
        accountId: meter.account_id,
        meterId: meter.id,
        type: 'DEVICE',
        severity: 'WARNING',
        title: 'Water flowing while the valve is closed',
        message: `${meter.id} measured ${flow.toFixed(1)} L/min with the valve closed. The valve may be stuck or bypassed.`,
        dedupeKey: `flow-closed:${meter.id}:${day}`,
      });
    }

    if (flow > 0.5 && meter.account_id) {
      const s = await ctx.db.one<{ away_mode: boolean }>(`select away_mode from account_settings where account_id = $1`, [meter.account_id]);
      if (s?.away_mode) {
        await raiseAlert(ctx, {
          accountId: meter.account_id,
          meterId: meter.id,
          type: 'LEAK',
          severity: 'CRITICAL',
          title: 'Water is flowing while you are away',
          message: `Away Mode is on and ${meter.id} is measuring ${flow.toFixed(1)} L/min. Close the valve if nobody should be using water.`,
          dedupeKey: `away:${meter.id}:${receivedAt.toISOString().slice(0, 13)}`,
        });
      }
    }
  }

  private async onHeartbeat(
    meter: { id: string; account_id: string | null; online: boolean; on_battery: boolean },
    m: { rssi?: number; fw?: string; onBattery?: boolean },
  ) {
    const row = await this.ctx.db.one<{ last_seen_at: Date }>(
      `update meters set rssi = coalesce($2, rssi), fw_version = coalesce($3, fw_version), on_battery = coalesce($4, on_battery),
              online = true, last_seen_at = now() where id = $1 returning last_seen_at`,
      [meter.id, m.rssi ?? null, m.fw ?? null, m.onBattery ?? null],
    );
    if (!meter.online) await this.onBackOnline(meter);
    if (m.onBattery === true && !meter.on_battery) {
      await raiseAlert(this.ctx, {
        accountId: meter.account_id,
        meterId: meter.id,
        type: 'DEVICE',
        severity: 'WARNING',
        title: 'Meter running on battery',
        message: `${meter.id} lost mains power and is running on its backup battery.`,
        dedupeKey: `battery:${meter.id}:${this.ctx.now().toISOString().slice(0, 13)}`,
      });
    }
    this.ctx.bus.emit('meter:status', { meterId: meter.id, online: true, lastSeenAt: row!.last_seen_at.toISOString(), rssi: m.rssi });
  }

  private async onEvent(
    meter: { id: string; account_id: string | null },
    e: { seq?: number; ts?: number; type: string; data?: Record<string, unknown> },
  ) {
    const ts = e.ts ? new Date(e.ts * 1000) : this.ctx.now();
    const rows = await this.ctx.db.query(
      `insert into device_events (meter_id, seq, ts, type, data) values ($1,$2,$3,$4,$5) on conflict do nothing returning id`,
      [meter.id, e.seq ?? null, ts, e.type, JSON.stringify(e.data ?? {})],
    );
    if (rows.length === 0) return; // duplicate
    const base = { accountId: meter.account_id, meterId: meter.id, type: 'DEVICE' as const };
    switch (e.type) {
      case 'POWER_LOSS':
        await raiseAlert(this.ctx, { ...base, severity: 'WARNING', title: 'Power cut at the meter', message: `${meter.id} reported a power loss.`, dedupeKey: `power:${meter.id}:${e.seq ?? ts.toISOString()}` });
        break;
      case 'TAMPER_SUSPECTED':
        await raiseAlert(this.ctx, { ...base, severity: 'CRITICAL', title: 'Possible meter tampering', message: `${meter.id} reported a tamper condition.`, dedupeKey: `tamper-evt:${meter.id}:${e.seq ?? ts.toISOString()}` });
        break;
      case 'VALVE_CHANGED': {
        const v = e.data?.valve;
        if (v === 'open' || v === 'closed') await this.ctx.db.query(`update meters set valve_state = $2 where id = $1`, [meter.id, v]);
        break;
      }
    }
  }
}

const nowSec = (ctx: AppContext) => Math.floor(ctx.now().getTime() / 1000);
