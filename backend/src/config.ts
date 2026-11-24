import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().optional().default(''),
  /** Connect with TLS without verifying the certificate (Amazon RDS, Heroku Postgres). */
  DATABASE_SSL: bool,
  PGLITE_DIR: z.string().default('./data/pglite'),
  SEED_DEMO: bool,

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  DEV_OTP: z.string().optional().default(''),

  EMBEDDED_BROKER: bool,
  MQTT_PORT: z.coerce.number().default(1883),
  MQTT_URL: z.string().default('mqtt://localhost:1883'),
  MQTT_SERVICE_USER: z.string().default('swm-backend'),
  MQTT_SERVICE_PASSWORD: z.string().min(8),
  MQTT_TLS_PORT: z.coerce.number().default(8883),
  MQTT_TLS_KEY: z.string().optional().default(''),
  MQTT_TLS_CERT: z.string().optional().default(''),

  TIMEZONE_OFFSET_MINUTES: z.coerce.number().default(330),
  OFFLINE_AFTER_MISSED_HEARTBEATS: z.coerce.number().default(3),
  COMMAND_TIMEOUT_SEC: z.coerce.number().default(60),
  LEAK_CONTINUOUS_HOURS: z.coerce.number().default(3),
  NIGHT_START_HOUR: z.coerce.number().default(1),
  NIGHT_END_HOUR: z.coerce.number().default(4),
  NIGHT_FLOW_THRESHOLD_L: z.coerce.number().default(20),
  BILL_DUE_DAYS: z.coerce.number().default(14),

  CORS_ORIGINS: z.string().default(''),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(overrides: Partial<Record<keyof Config, unknown>> = {}): Config {
  const env: Record<string, unknown> = {
    // Safe defaults so `npm run dev` works without a .env file.
    JWT_SECRET: 'dev-only-change-me-dev-only-change-me-dev-only',
    MQTT_SERVICE_PASSWORD: 'dev-service-password-change-me',
    EMBEDDED_BROKER: 'true',
    SEED_DEMO: 'true',
    DEV_OTP: '123456',
    ...process.env,
  };
  for (const [k, v] of Object.entries(overrides)) env[k] = typeof v === 'boolean' ? String(v) : v;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.JWT_SECRET.startsWith('dev-only')) {
    throw new Error('Set a real JWT_SECRET in production');
  }
  return cfg;
}
