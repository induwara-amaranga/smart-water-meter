import type { AppContext } from '../context.js';
import { randomId } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { type CommandMessage, type CommandType, downTopic } from '../mqtt/contract.js';
import { raiseAlert } from './alerts.js';
import { getMeter } from './meters.js';

export interface CommandRow {
  id: string;
  meter_id: string;
  type: CommandType;
  args: Record<string, unknown>;
  initiated_by_type: 'CUSTOMER' | 'STAFF' | 'SYSTEM';
  initiated_by_id: string | null;
  reason: string | null;
  approved_by: string | null;
  state: string;
  error: string | null;
  created_at: Date;
  sent_at: Date | null;
  received_at: Date | null;
  executed_at: Date | null;
}

export const commandJson = (c: CommandRow) => ({
  id: c.id,
  meterId: c.meter_id,
  type: c.type,
  initiatedBy: { type: c.initiated_by_type, id: c.initiated_by_id },
  reason: c.reason,
  approvedBy: c.approved_by,
  state: c.state,
  error: c.error,
  createdAt: c.created_at,
  sentAt: c.sent_at,
  receivedAt: c.received_at,
  executedAt: c.executed_at,
});

async function publishCommand(ctx: AppContext, meterId: string, cmdId: string, type: CommandType, args: Record<string, unknown> = {}) {
  const msg: CommandMessage = {
    cmdId,
    type,
    args,
    expiresAt: Math.floor(ctx.now().getTime() / 1000) + ctx.config.COMMAND_TIMEOUT_SEC,
  };
  await ctx.mqtt.publish(downTopic(meterId, 'cmd'), msg, { qos: 1 });
}

async function assertCanSend(ctx: AppContext, meterId: string) {
  const meter = await getMeter(ctx.db, meterId);
  if (!meter.online) throw conflict('The meter is offline. Try again when it reconnects.');
  const busy = await ctx.db.one(
    `select 1 from commands where meter_id = $1 and type in ('VALVE_OPEN','VALVE_CLOSE') and state in ('SENT','RECEIVED')`,
    [meterId],
  );
  if (busy) throw conflict('A valve command is already in progress for this meter.');
  return meter;
}

async function dispatch(ctx: AppContext, cmd: CommandRow) {
  await ctx.db.query(`update commands set state = 'SENT', sent_at = now(), updated_at = now() where id = $1`, [cmd.id]);
  await publishCommand(ctx, cmd.meter_id, cmd.id, cmd.type, cmd.args);
  ctx.bus.emit('meter:valve', { meterId: cmd.meter_id, cmdId: cmd.id, state: 'SENT' });
}

/** Customer opens or closes their own valve (no approval needed). */
export async function customerValve(ctx: AppContext, meterId: string, customerId: string, open: boolean) {
  await assertCanSend(ctx, meterId);
  if (open) {
    // A supply closed by the water board can only be reopened by the board.
    const last = await ctx.db.one<{ type: string; initiated_by_type: string }>(
      `select type, initiated_by_type from commands where meter_id = $1 and type in ('VALVE_OPEN','VALVE_CLOSE') and state = 'CONFIRMED'
       order by executed_at desc limit 1`,
      [meterId],
    );
    if (last?.type === 'VALVE_CLOSE' && last.initiated_by_type === 'STAFF') {
      throw forbidden('Your supply was closed by the water board. Please contact customer service.');
    }
  }
  const id = randomId('cmd');
  const cmd = await ctx.db.one<CommandRow>(
    `insert into commands (id, meter_id, type, initiated_by_type, initiated_by_id, state)
     values ($1,$2,$3,'CUSTOMER',$4,'PENDING') returning *`,
    [id, meterId, open ? 'VALVE_OPEN' : 'VALVE_CLOSE', customerId],
  );
  await dispatch(ctx, cmd!);
  return { cmdId: id, state: 'SENT' };
}

/** Water board staff request: needs a reason and a second officer's approval. */
export async function requestStaffValve(ctx: AppContext, meterId: string, staffId: string, open: boolean, reason: string) {
  if (reason.trim().length < 5) throw badRequest('Give a reason for this valve command');
  const meter = await getMeter(ctx.db, meterId);
  if (!meter.account_id) throw badRequest('This meter is not assigned to an account');
  const pending = await ctx.db.one(
    `select 1 from commands where meter_id = $1 and initiated_by_type = 'STAFF' and state in ('AWAITING_APPROVAL','SENT','RECEIVED')`,
    [meterId],
  );
  if (pending) throw conflict('There is already a pending disconnection/reconnection request for this meter');
  if (!open && meter.valve_state === 'closed') throw conflict('The supply is already closed');
  if (open && meter.valve_state === 'open') throw conflict('The supply is already open');
  const cmd = await ctx.db.one<CommandRow>(
    `insert into commands (id, meter_id, type, initiated_by_type, initiated_by_id, reason, state)
     values ($1,$2,$3,'STAFF',$4,$5,'AWAITING_APPROVAL') returning *`,
    [randomId('cmd'), meterId, open ? 'VALVE_OPEN' : 'VALVE_CLOSE', staffId, reason.trim()],
  );
  return cmd!;
}

export async function decideStaffValve(ctx: AppContext, cmdId: string, approverId: string, approve: boolean, note?: string) {
  const cmd = await ctx.db.one<CommandRow>(`select * from commands where id = $1`, [cmdId]);
  if (!cmd) throw notFound('Valve request');
  if (cmd.state !== 'AWAITING_APPROVAL') throw conflict(`This request is already ${cmd.state.toLowerCase()}`);
  if (cmd.initiated_by_id === approverId) throw forbidden('A different officer must approve this request');
  if (!approve) {
    await ctx.db.query(`update commands set state = 'REJECTED', approved_by = $2, error = $3, updated_at = now() where id = $1`, [
      cmdId,
      approverId,
      note ?? null,
    ]);
    return { ...cmd, state: 'REJECTED' };
  }
  await assertCanSend(ctx, cmd.meter_id);
  await ctx.db.query(`update commands set approved_by = $2, updated_at = now() where id = $1`, [cmdId, approverId]);
  await dispatch(ctx, cmd);
  return { ...cmd, approved_by: approverId, state: 'SENT' };
}

/** Ask the meter to stream fast flow samples for ttlSec (renewed while the app is open). */
export async function startLive(ctx: AppContext, meterId: string, ttlSec = 120) {
  const meter = await getMeter(ctx.db, meterId);
  if (!meter.online) return { live: false };
  await ctx.db.query(`update meters set live_until = now() + make_interval(secs => $2) where id = $1`, [meterId, ttlSec]);
  await publishCommand(ctx, meterId, randomId('live'), 'LIVE_ON', { ttlSec });
  return { live: true, ttlSec };
}

/** Process a command acknowledgement from a meter. */
export async function handleAck(
  ctx: AppContext,
  meterId: string,
  ack: { cmdId: string; state: 'RECEIVED' | 'EXECUTED' | 'FAILED'; valve?: string; err?: string | null },
) {
  const cmd = await ctx.db.one<CommandRow>(`select * from commands where id = $1 and meter_id = $2`, [ack.cmdId, meterId]);
  if (!cmd || !['SENT', 'RECEIVED'].includes(cmd.state)) return; // live-mode acks, duplicates, late acks

  if (ack.state === 'RECEIVED') {
    await ctx.db.query(`update commands set state = 'RECEIVED', received_at = now(), updated_at = now() where id = $1`, [cmd.id]);
    ctx.bus.emit('meter:valve', { meterId, cmdId: cmd.id, state: 'RECEIVED' });
    return;
  }
  if (ack.state === 'FAILED') {
    await ctx.db.query(`update commands set state = 'FAILED', error = $2, updated_at = now() where id = $1`, [cmd.id, ack.err ?? 'Meter reported a failure']);
    ctx.bus.emit('meter:valve', { meterId, cmdId: cmd.id, state: 'FAILED', error: ack.err ?? 'The meter could not move the valve.' });
    return;
  }
  const valve = ack.valve ?? (cmd.type === 'VALVE_CLOSE' ? 'closed' : 'open');
  await ctx.db.tx(async (t) => {
    await t.query(`update commands set state = 'CONFIRMED', executed_at = now(), updated_at = now() where id = $1`, [cmd.id]);
    await t.query(`update meters set valve_state = $2 where id = $1`, [meterId, valve]);
  });
  ctx.bus.emit('meter:valve', { meterId, cmdId: cmd.id, state: 'CONFIRMED', valve });

  // Board disconnection / reconnection: suspend or reactivate the account and tell the consumer.
  if (cmd.initiated_by_type === 'STAFF') {
    const acct = await ctx.db.one<{ account_id: string | null }>(`select account_id from meters where id = $1`, [meterId]);
    if (!acct?.account_id) return;
    const closed = cmd.type === 'VALVE_CLOSE';
    await ctx.db.query(`update accounts set status = $2 where id = $1 and status <> 'CLOSED'`, [acct.account_id, closed ? 'SUSPENDED' : 'ACTIVE']);
    await raiseAlert(ctx, {
      accountId: acct.account_id,
      meterId,
      type: 'BILLING',
      severity: closed ? 'CRITICAL' : 'INFO',
      title: closed ? 'Water supply disconnected' : 'Water supply restored',
      message: closed
        ? `Your water supply was disconnected by the water board. Reason: ${cmd.reason ?? 'not given'}. Pay the outstanding balance and contact customer service to reconnect.`
        : 'Your water supply has been reconnected. Thank you.',
      dedupeKey: `board-valve:${cmd.id}`,
    });
  }
}

/** Mark commands the meter never confirmed as TIMEOUT. */
export async function timeoutCommands(ctx: AppContext): Promise<number> {
  const rows = await ctx.db.query<CommandRow>(
    `update commands set state = 'TIMEOUT', error = 'No confirmation from the meter', updated_at = now()
     where state in ('SENT','RECEIVED') and sent_at < $1 returning *`,
    [new Date(ctx.now().getTime() - ctx.config.COMMAND_TIMEOUT_SEC * 1000)],
  );
  for (const c of rows) {
    ctx.bus.emit('meter:valve', { meterId: c.meter_id, cmdId: c.id, state: 'TIMEOUT', error: 'The meter did not confirm the command.' });
    const acct = await ctx.db.one<{ account_id: string | null }>(`select account_id from meters where id = $1`, [c.meter_id]);
    await raiseAlert(ctx, {
      accountId: acct?.account_id ?? null,
      meterId: c.meter_id,
      type: 'DEVICE',
      severity: 'WARNING',
      title: 'Valve command not confirmed',
      message: `The meter did not confirm the ${c.type === 'VALVE_CLOSE' ? 'close' : 'open'} command. The valve state may be unknown.`,
      dedupeKey: `cmd-timeout:${c.id}`,
    });
  }
  return rows.length;
}
