import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Config, loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { openDb } from './db/db.js';
import { migrate } from './db/migrations.js';
import { seedDemo } from './db/seed.js';
import { createApp, corsOrigins } from './http/app.js';
import { EventBus } from './lib/events.js';
import { createLogger } from './lib/logger.js';
import { LocalTime } from './lib/time.js';
import { type RunningBroker, startBroker } from './mqtt/broker.js';
import { MqttService } from './mqtt/client.js';
import { Ingest } from './mqtt/ingest.js';
import { attachRealtime } from './realtime/socket.js';
import { JobRunner } from './services/jobs.js';
import { publishAllConfigs } from './services/meters.js';

export interface StartOptions {
  config?: Partial<Record<keyof Config, unknown>>;
  /** Override ports (0 = random, used by tests). */
  httpPort?: number;
  mqttPort?: number;
  jobs?: boolean;
  now?: () => Date;
}

export interface RunningServer {
  ctx: AppContext;
  ingest: Ingest;
  jobs: JobRunner;
  httpPort: number;
  mqttPort: number | null;
  close(): Promise<void>;
}

/** Start database, MQTT broker + ingest, HTTP API, Socket.IO and jobs. */
export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const config = loadConfig(opts.config);
  const log = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development');
  if (config.NODE_ENV === 'production' && config.ALLOW_DEV_OTP_IN_PRODUCTION && config.DEV_OTP) {
    log.warn('auth: DEV_OTP is accepted for every customer login (ALLOW_DEV_OTP_IN_PRODUCTION=true). Demo use only.');
  }

  const db = await openDb(config.DATABASE_URL, config.PGLITE_DIR, config.DATABASE_SSL);
  log.info({ db: db.kind }, 'db: connected');
  const applied = await migrate(db);
  if (applied.length) log.info({ applied }, 'db: migrations applied');

  const mqtt = new MqttService(log);
  const ctx: AppContext = {
    config,
    db,
    bus: new EventBus(),
    log,
    time: new LocalTime(config.TIMEZONE_OFFSET_MINUTES),
    mqtt,
    now: opts.now ?? (() => new Date()),
  };

  if (config.SEED_DEMO) {
    const seeded = await seedDemo(ctx);
    if (seeded) log.info('db: demo data loaded (see README for logins)');
  }

  let broker: RunningBroker | null = null;
  let mqttUrl = config.MQTT_URL;
  if (config.EMBEDDED_BROKER) {
    broker = await startBroker(config, db, log, opts.mqttPort ?? config.MQTT_PORT);
    mqttUrl = `mqtt://127.0.0.1:${broker.port}`;
  }

  const ingest = new Ingest(ctx);
  await mqtt.connect(mqttUrl, config.MQTT_SERVICE_USER, config.MQTT_SERVICE_PASSWORD, (topic, payload) => {
    void ingest.handle(topic, payload);
  });
  await publishAllConfigs(ctx).catch((err) => log.warn({ err }, 'mqtt: could not publish meter configs'));

  const app = createApp(ctx);
  const http = createServer(app);
  const io = attachRealtime(ctx, http, corsOrigins(ctx));
  const httpPort = await new Promise<number>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.httpPort ?? config.PORT, () => resolve((http.address() as AddressInfo).port));
  });
  log.info({ port: httpPort }, 'http: API listening on /api/v1');

  const jobs = new JobRunner(ctx);
  if (opts.jobs ?? true) jobs.start();

  return {
    ctx,
    ingest,
    jobs,
    httpPort,
    mqttPort: broker?.port ?? null,
    close: async () => {
      jobs.stop();
      await new Promise<void>((r) => io.close(() => r()));
      await new Promise<void>((r) => (http.listening ? http.close(() => r()) : r()));
      await mqtt.close();
      await ingest.drain();
      await broker?.close();
      await db.close();
    },
  };
}
