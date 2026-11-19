import type { AppContext } from '../context.js';
import { recomputeAccount } from './accounts.js';
import { raiseAlert } from './alerts.js';
import { timeoutCommands } from './commands.js';
import { monthUsageLiters, usageBetween } from './readings.js';

/** Mark meters offline after N missed heartbeats; alert the customer after 30 minutes offline. */
export async function offlineSweep(ctx: AppContext): Promise<number> {
  const now = ctx.now();
  const went = await ctx.db.query<{ id: string; last_seen_at: Date }>(
    `update meters set online = false, flow_lpm = 0
     where online and (last_seen_at is null or last_seen_at < $1::timestamptz - make_interval(secs => heartbeat_sec * $2))
     returning id, last_seen_at`,
    [now, ctx.config.OFFLINE_AFTER_MISSED_HEARTBEATS],
  );
  for (const m of went) {
    ctx.bus.emit('meter:status', { meterId: m.id, online: false, lastSeenAt: (m.last_seen_at ?? now).toISOString() });
  }
  const longOffline = await ctx.db.query<{ id: string; account_id: string; last_seen_at: Date }>(
    `select id, account_id, last_seen_at from meters
     where not online and account_id is not null and last_seen_at < $1::timestamptz - interval '30 minutes'`,
    [now],
  );
  for (const m of longOffline) {
    await raiseAlert(ctx, {
      accountId: m.account_id,
      meterId: m.id,
      type: 'DEVICE',
      severity: 'WARNING',
      title: 'Meter offline',
      message: `${m.id} has not reported since ${new Date(m.last_seen_at).toISOString().slice(0, 16).replace('T', ' ')} UTC. It keeps measuring and will upload its readings when Wi-Fi returns.`,
      dedupeKey: `offline:${m.id}:${new Date(m.last_seen_at).toISOString()}`,
    });
  }
  return went.length;
}

/** Leak rules: continuous flow for hours, or flow in the night window. */
export async function leakRules(ctx: AppContext): Promise<number> {
  const now = ctx.now();
  const t = ctx.time;
  const p = t.parts(now);
  const hours = ctx.config.LEAK_CONTINUOUS_HOURS;
  const date = `${p.year}-${p.month}-${p.day}`;
  let raised = 0;

  const meters = await ctx.db.query<{ id: string; account_id: string; telemetry_sec: number }>(
    `select id, account_id, telemetry_sec from meters where account_id is not null and valve_state <> 'closed'`,
  );
  for (const m of meters) {
    // Continuous flow: every interval between readings in the window used water.
    const stats = await ctx.db.one<{ n: number; all_flow: boolean; first_ts: Date | null; last_ts: Date | null }>(
      `select count(*)::int as n, bool_and(delta > 0.5) as all_flow, min(ts) as first_ts, max(ts) as last_ts from (
         select ts, total_l - lag(total_l) over (order by ts, seq) as delta from readings
         where meter_id = $1 and ts >= $2::timestamptz - make_interval(secs => $3 * 3600 + 900) and ts <= $2
       ) s where delta is not null`,
      [m.id, now, hours],
    );
    const expected = Math.max(3, Math.floor(((hours * 3600) / m.telemetry_sec) * 0.75));
    const span = stats?.first_ts && stats.last_ts ? (new Date(stats.last_ts).getTime() - new Date(stats.first_ts).getTime()) / 1000 : 0;
    if (stats && stats.n >= expected && stats.all_flow && span >= hours * 3600 * 0.9) {
      const id = await raiseAlert(ctx, {
        accountId: m.account_id,
        meterId: m.id,
        type: 'LEAK',
        severity: 'CRITICAL',
        title: 'Possible leak detected',
        message: `Water has been flowing continuously for over ${hours} hours. Check taps, toilets and tanks, or close the valve from the app.`,
        dedupeKey: `leak:${m.id}:${date}`,
      });
      if (id) raised++;
    }

    // Night flow: usage between NIGHT_START and NIGHT_END (local), checked once the window has ended.
    if (p.hour >= ctx.config.NIGHT_END_HOUR) {
      const used = await usageBetween(
        ctx.db,
        m.id,
        t.at(p.year, p.month, p.day, ctx.config.NIGHT_START_HOUR),
        t.at(p.year, p.month, p.day, ctx.config.NIGHT_END_HOUR),
      );
      if (used > ctx.config.NIGHT_FLOW_THRESHOLD_L) {
        const id = await raiseAlert(ctx, {
          accountId: m.account_id,
          meterId: m.id,
          type: 'LEAK',
          severity: 'WARNING',
          title: 'Water used during the night',
          message: `${used.toFixed(0)} L was used between ${ctx.config.NIGHT_START_HOUR}:00 and ${ctx.config.NIGHT_END_HOUR}:00. If nobody was using water, there may be a leak.`,
          dedupeKey: `night:${m.id}:${date}`,
        });
        if (id) raised++;
      }
    }
  }
  return raised;
}

/** Monthly budget (80 % and 100 %) and unusually high daily use. */
export async function usageRules(ctx: AppContext): Promise<number> {
  const now = ctx.now();
  const t = ctx.time;
  const period = t.periodOf(now);
  const today = t.startOfDay(now);
  let raised = 0;

  const rows = await ctx.db.query<{ meter_id: string; account_id: string; budget_m3: number | null }>(
    `select m.id as meter_id, m.account_id, s.budget_m3 from meters m
     left join account_settings s on s.account_id = m.account_id where m.account_id is not null`,
  );
  for (const r of rows) {
    if (r.budget_m3) {
      const usedM3 = (await monthUsageLiters(ctx, r.meter_id)) / 1000;
      for (const level of [100, 80]) {
        if (usedM3 >= (r.budget_m3 * level) / 100) {
          const id = await raiseAlert(ctx, {
            accountId: r.account_id,
            meterId: r.meter_id,
            type: 'BUDGET',
            severity: level === 100 ? 'WARNING' : 'INFO',
            title: level === 100 ? 'Monthly budget reached' : '80% of monthly budget used',
            message: `You have used ${usedM3.toFixed(1)} m³ of your ${r.budget_m3} m³ budget this month.`,
            dedupeKey: `budget${level}:${r.account_id}:${period}`,
          });
          if (id) raised++;
          break;
        }
      }
    }

    const todayL = await usageBetween(ctx.db, r.meter_id, today, now);
    const last30 = await usageBetween(ctx.db, r.meter_id, new Date(today.getTime() - 30 * 86400_000), today);
    const avgDaily = last30 / 30;
    if (avgDaily > 0 && todayL > Math.max(3 * avgDaily, 500)) {
      const id = await raiseAlert(ctx, {
        accountId: r.account_id,
        meterId: r.meter_id,
        type: 'HIGH_USAGE',
        severity: 'WARNING',
        title: 'Unusually high water use today',
        message: `${todayL.toFixed(0)} L used today, compared with about ${avgDaily.toFixed(0)} L on a normal day.`,
        dedupeKey: `high:${r.meter_id}:${t.periodOf(now)}-${t.parts(now).day}`,
      });
      if (id) raised++;
    }
  }
  return raised;
}

/** Due-date reminders (3 days before) and overdue flags. */
export async function billReminders(ctx: AppContext): Promise<number> {
  const now = ctx.now();
  const accounts = await ctx.db.query<{ account_id: string }>(
    `select distinct account_id from bills where status in ('PUBLISHED','OVERDUE')`,
  );
  for (const a of accounts) await recomputeAccount(ctx, a.account_id);

  let raised = 0;
  const soon = await ctx.db.query<{ id: string; account_id: string; total_cents: number; due_date: Date }>(
    `select id, account_id, total_cents, due_date from bills where status = 'PUBLISHED'
     and due_date between $1::timestamptz and $1::timestamptz + interval '3 days'`,
    [now],
  );
  for (const b of soon) {
    if (await raiseAlert(ctx, {
      accountId: b.account_id,
      type: 'BILLING',
      severity: 'WARNING',
      title: 'Bill due soon',
      message: `Rs. ${(b.total_cents / 100).toFixed(2)} is due on ${new Date(b.due_date).toDateString()}.`,
      dedupeKey: `due-soon:${b.id}`,
    })) raised++;
  }
  const overdue = await ctx.db.query<{ id: string; account_id: string }>(`select id, account_id from bills where status = 'OVERDUE'`);
  for (const b of overdue) {
    if (await raiseAlert(ctx, {
      accountId: b.account_id,
      type: 'BILLING',
      severity: 'CRITICAL',
      title: 'Bill overdue',
      message: 'Your bill is past its due date. Please pay to avoid further action.',
      dedupeKey: `overdue:${b.id}`,
    })) raised++;
  }
  return raised;
}

export class JobRunner {
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly ctx: AppContext) {}

  private every(name: string, ms: number, fn: (ctx: AppContext) => Promise<unknown>) {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await fn(this.ctx);
      } catch (err) {
        this.ctx.log.error({ err, job: name }, 'job failed');
      } finally {
        running = false;
      }
    };
    this.timers.push(setInterval(run, ms));
  }

  start() {
    this.every('offline-sweep', 60_000, offlineSweep);
    this.every('command-timeout', 10_000, timeoutCommands);
    this.every('leak-rules', 5 * 60_000, leakRules);
    this.every('usage-rules', 15 * 60_000, usageRules);
    this.every('bill-reminders', 60 * 60_000, billReminders);
    this.ctx.log.info('jobs: scheduled');
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }
}
