import type { AppContext } from '../context.js';
import type { Db } from '../db/db.js';
import { claimCode, hashSecret, randomToken } from '../lib/crypto.js';
import { conflict, notFound } from '../lib/errors.js';
import { type ConfigMessage, downTopic } from '../mqtt/contract.js';
import { alertJson } from './alerts.js';
import { priceUsage, sumCents } from './pricing.js';
import { monthUsageLiters } from './readings.js';
import { tariffAt, tariffJson } from './tariffs.js';

export interface MeterRow {
  id: string;
  account_id: string | null;
  fw_version: string | null;
  cal_factor: number;
  telemetry_sec: number;
  heartbeat_sec: number;
  config_ver: number;
  online: boolean;
  last_seen_at: Date | null;
  rssi: number | null;
  valve_state: string;
  total_l: number;
  flow_lpm: number;
  on_battery: boolean;
  installed_at: Date;
}

export async function getMeter(db: Db, meterId: string): Promise<MeterRow> {
  const m = await db.one<MeterRow>(`select * from meters where id = $1`, [meterId]);
  if (!m) throw notFound('Meter');
  return m;
}

/** Next free ID in the SWM-000001 series. */
export async function nextMeterId(db: Db): Promise<string> {
  const row = await db.one<{ n: number | null }>(
    `select max(substring(id from 5)::int) as n from meters where id ~ '^SWM-[0-9]{6}$'`,
  );
  return `SWM-${String((row?.n ?? 0) + 1).padStart(6, '0')}`;
}

/** Register a new meter. The secret and claim code are returned once and only stored hashed. */
export async function registerMeter(db: Db, meterId: string, opts: { secret?: string; claimCode?: string } = {}) {
  if (await db.one(`select 1 from meters where id = $1`, [meterId])) throw conflict(`Meter ${meterId} already exists`);
  const secret = opts.secret ?? randomToken(24);
  const code = opts.claimCode ?? claimCode();
  await db.query(`insert into meters (id, device_secret_hash, claim_code_hash) values ($1, $2, $3)`, [
    meterId,
    await hashSecret(secret),
    await hashSecret(code.toUpperCase()),
  ]);
  return { meterId, deviceSecret: secret, claimCode: code, qr: `swm://claim?meter=${meterId}&code=${code}` };
}

/** Customer home screen summary (the Flutter app's MeterSummary.fromJson). */
export async function meterSummary(ctx: AppContext, meterId: string, accountId: string) {
  const m = await getMeter(ctx.db, meterId);
  const tariff = await tariffAt(ctx.db, ctx.now());
  const monthM3 = (await monthUsageLiters(ctx, meterId)) / 1000;
  const settings = await ctx.db.one<{ budget_m3: number | null }>(`select budget_m3 from account_settings where account_id = $1`, [accountId]);
  const pending = await ctx.db.one<{ type: string }>(
    `select type from commands where meter_id = $1 and type in ('VALVE_OPEN','VALVE_CLOSE') and state in ('SENT','RECEIVED')
     order by created_at desc limit 1`,
    [meterId],
  );
  const top = await ctx.db.one(
    `select * from alerts where account_id = $1 and status = 'OPEN' and not read
     order by case severity when 'CRITICAL' then 0 when 'WARNING' then 1 else 2 end, created_at desc limit 1`,
    [accountId],
  );
  const valve = pending ? (pending.type === 'VALVE_CLOSE' ? 'closing' : 'opening') : m.valve_state;

  return {
    meterId,
    online: m.online,
    lastSeenAt: (m.last_seen_at ?? m.installed_at).toISOString(),
    flowLpm: m.online ? m.flow_lpm : 0,
    totalL: m.total_l,
    monthUsageM3: Math.round(monthM3 * 1000) / 1000,
    estimatedBillCents: sumCents(priceUsage(monthM3, tariff)),
    valve,
    rssi: m.rssi ?? 0,
    fw: m.fw_version ?? '',
    budgetM3: settings?.budget_m3 ?? null,
    tariff: tariffJson(tariff),
    topAlert: top ? alertJson(top) : null,
  };
}

/** Retained per-meter config: calibration, intervals and the tariff for the OLED estimate. */
export async function configMessage(ctx: AppContext, m: MeterRow): Promise<ConfigMessage> {
  let tariff: ConfigMessage['tariff'] = null;
  try {
    const t = await tariffAt(ctx.db, ctx.now());
    tariff = {
      slabs: t.slabs.map((s) => ({ upTo: s.upToM3, rate: s.rateCents / 100 })),
      service: t.serviceChargeCents / 100,
    };
  } catch {
    // No tariff yet: the meter just won't show a bill estimate.
  }
  return {
    ver: m.config_ver,
    calFactor: m.cal_factor,
    telemetrySec: m.telemetry_sec,
    heartbeatSec: m.heartbeat_sec,
    tariff,
  };
}

export async function publishConfig(ctx: AppContext, meterId: string): Promise<void> {
  const m = await getMeter(ctx.db, meterId);
  await ctx.mqtt.publish(downTopic(meterId, 'config'), await configMessage(ctx, m), { qos: 1, retain: true });
}

/** Re-send retained config to every meter (on startup and when the tariff changes). */
export async function publishAllConfigs(ctx: AppContext): Promise<number> {
  const meters = await ctx.db.query<MeterRow>(`select * from meters`);
  for (const m of meters) {
    await ctx.mqtt.publish(downTopic(m.id, 'config'), await configMessage(ctx, m), { qos: 1, retain: true });
  }
  return meters.length;
}

export const adminMeterJson = (m: MeterRow & { account_no?: string | null; holder_name?: string | null }) => ({
  id: m.id,
  accountId: m.account_id,
  accountNo: m.account_no ?? null,
  holderName: m.holder_name ?? null,
  online: m.online,
  lastSeenAt: m.last_seen_at,
  rssi: m.rssi,
  fw: m.fw_version,
  valve: m.valve_state,
  totalL: m.total_l,
  flowLpm: m.flow_lpm,
  onBattery: m.on_battery,
  calFactor: m.cal_factor,
  telemetrySec: m.telemetry_sec,
  heartbeatSec: m.heartbeat_sec,
  installedAt: m.installed_at,
});
