import type { Config } from './config.js';
import type { Db } from './db/db.js';
import type { EventBus } from './lib/events.js';
import type { Logger } from './lib/logger.js';
import type { LocalTime } from './lib/time.js';

export interface Publisher {
  publish(topic: string, payload: unknown, opts?: { qos?: 0 | 1; retain?: boolean }): Promise<void>;
  readonly connected: boolean;
}

/** Everything a service needs, passed explicitly (no globals) so tests can build their own. */
export interface AppContext {
  config: Config;
  db: Db;
  bus: EventBus;
  log: Logger;
  time: LocalTime;
  mqtt: Publisher;
  /** Overridable clock for tests. */
  now(): Date;
}
