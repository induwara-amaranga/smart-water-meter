import { z } from 'zod';

/**
 * Meter ↔ cloud MQTT contract (PLAN_AND_ARCHITECTURE.md §4).
 *
 *   swm/v1/meters/{meterId}/up/{status|telemetry|live|backlog|heartbeat|event|cmd-ack}   meter → cloud
 *   swm/v1/meters/{meterId}/down/{cmd|config|ota}                                         cloud → meter
 */
export const TOPIC_PREFIX = 'swm/v1/meters';

export const upTopics = ['status', 'telemetry', 'live', 'backlog', 'heartbeat', 'event', 'cmd-ack'] as const;
export type UpTopic = (typeof upTopics)[number];
export type DownTopic = 'cmd' | 'config' | 'ota';

export const downTopic = (meterId: string, t: DownTopic) => `${TOPIC_PREFIX}/${meterId}/down/${t}`;
export const upTopic = (meterId: string, t: UpTopic) => `${TOPIC_PREFIX}/${meterId}/up/${t}`;

/** Parse "swm/v1/meters/SWM-000123/up/telemetry" → { meterId, dir, kind }. */
export function parseTopic(topic: string): { meterId: string; dir: 'up' | 'down'; kind: string } | null {
  const parts = topic.split('/');
  if (parts.length !== 6 || `${parts[0]}/${parts[1]}/${parts[2]}` !== TOPIC_PREFIX) return null;
  const [, , , meterId, dir, kind] = parts;
  if (dir !== 'up' && dir !== 'down') return null;
  return { meterId, dir, kind };
}

export const METER_ID_RE = /^[A-Z0-9-]{3,32}$/;

const valve = z.enum(['open', 'closed', 'unknown']);
/** Unix seconds; 0 means the meter's clock is not set yet. */
const unixTs = z.number().int().min(0);

export const statusSchema = z.object({
  online: z.boolean(),
  fw: z.string().max(32).optional(),
  bootId: z.string().max(32).optional(),
});

export const readingSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: unixTs,
  bootId: z.string().max(32).optional(),
  upMs: z.number().int().nonnegative().optional(),
  totalL: z.number().nonnegative(),
  flowLpm: z.number().nonnegative().optional(),
  valve: valve.optional(),
});

export const telemetrySchema = readingSchema;

export const liveSchema = z.object({
  ts: unixTs.optional(),
  flowLpm: z.number().nonnegative(),
  totalL: z.number().nonnegative(),
});

export const backlogSchema = z.object({ items: z.array(readingSchema).min(1).max(200) });

export const heartbeatSchema = z.object({
  ts: unixTs.optional(),
  rssi: z.number().int().optional(),
  fw: z.string().max(32).optional(),
  heap: z.number().optional(),
  vin: z.number().optional(),
  onBattery: z.boolean().optional(),
});

export const eventSchema = z.object({
  seq: z.number().int().nonnegative().optional(),
  ts: unixTs.optional(),
  type: z.enum(['POWER_LOSS', 'POWER_RESTORED', 'VALVE_CHANGED', 'BOOT', 'TAMPER_SUSPECTED']),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const cmdAckSchema = z.object({
  cmdId: z.string().max(64),
  state: z.enum(['RECEIVED', 'EXECUTED', 'FAILED']),
  valve: valve.optional(),
  err: z.string().max(200).nullable().optional(),
});

export type Reading = z.infer<typeof readingSchema>;

export type CommandType = 'VALVE_OPEN' | 'VALVE_CLOSE' | 'LIVE_ON' | 'LIVE_OFF' | 'REBOOT' | 'SYNC_CONFIG';

export interface CommandMessage {
  cmdId: string;
  type: CommandType;
  args: Record<string, unknown>;
  expiresAt: number;
}

export interface ConfigMessage {
  ver: number;
  calFactor: number;
  telemetrySec: number;
  heartbeatSec: number;
  tariff: { slabs: { upTo: number | null; rate: number }[]; service: number } | null;
}
