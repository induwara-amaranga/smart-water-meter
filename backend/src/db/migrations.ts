import type { Db } from './db.js';

/**
 * Ordered schema migrations. Volumes are litres (double precision), money is
 * integer cents. Never edit a migration that has shipped; add a new one.
 */
export const migrations: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: /* sql */ `
create table zones (
  id serial primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  phone text unique,
  email text unique,
  fcm_tokens text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table staff_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('ADMIN','BILLING_OFFICER','OPERATIONS','CUSTOMER_SERVICE','AUDITOR')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create sequence account_no_seq start 100001;

create table accounts (
  id uuid primary key default gen_random_uuid(),
  account_no text not null unique,
  holder_name text not null,
  address text not null default '',
  zone_id int references zones(id),
  lat double precision,
  lng double precision,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED','CLOSED')),
  created_at timestamptz not null default now()
);

create table account_members (
  account_id uuid not null references accounts(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  role text not null default 'OWNER' check (role in ('OWNER','MEMBER')),
  label text not null default 'Home',
  created_at timestamptz not null default now(),
  primary key (account_id, customer_id)
);

create table account_settings (
  account_id uuid primary key references accounts(id) on delete cascade,
  budget_m3 double precision,
  leak_alerts boolean not null default true,
  usage_alerts boolean not null default true,
  bill_alerts boolean not null default true,
  away_mode boolean not null default false,
  emergency_contact text
);

create table meters (
  id text primary key,
  account_id uuid unique references accounts(id),
  device_secret_hash text not null,
  claim_code_hash text not null,
  fw_version text,
  cal_factor double precision not null default 7.5,
  telemetry_sec int not null default 900,
  heartbeat_sec int not null default 300,
  config_ver int not null default 1,
  online boolean not null default false,
  last_seen_at timestamptz,
  rssi int,
  valve_state text not null default 'unknown',
  total_l double precision not null default 0,
  flow_lpm double precision not null default 0,
  on_battery boolean not null default false,
  live_until timestamptz,
  installed_at timestamptz not null default now()
);

create table readings (
  meter_id text not null references meters(id) on delete cascade,
  seq bigint not null,
  ts timestamptz not null,
  boot_id text,
  up_ms bigint,
  ts_corrected boolean not null default false,
  ts_estimated boolean not null default false,
  total_l double precision not null,
  flow_lpm double precision,
  valve text,
  backlog boolean not null default false,
  received_at timestamptz not null default now(),
  primary key (meter_id, seq)
);
create index readings_meter_ts on readings (meter_id, ts);

create table device_events (
  id bigserial primary key,
  meter_id text not null references meters(id) on delete cascade,
  seq bigint,
  ts timestamptz not null,
  type text not null,
  data jsonb not null default '{}',
  received_at timestamptz not null default now(),
  unique (meter_id, seq)
);

create table commands (
  id text primary key,
  meter_id text not null references meters(id) on delete cascade,
  type text not null,
  args jsonb not null default '{}',
  initiated_by_type text not null check (initiated_by_type in ('CUSTOMER','STAFF','SYSTEM')),
  initiated_by_id text,
  reason text,
  approved_by uuid references staff_users(id),
  state text not null,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  received_at timestamptz,
  executed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index commands_meter on commands (meter_id, created_at desc);

create table tariff_versions (
  id serial primary key,
  name text not null,
  slabs jsonb not null,
  service_charge_cents int not null,
  effective_from timestamptz not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','RETIRED')),
  created_by uuid references staff_users(id),
  approved_by uuid references staff_users(id),
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create table billing_cycles (
  id serial primary key,
  period text not null unique,
  period_start timestamptz not null,
  period_end timestamptz not null,
  state text not null check (state in ('SNAPSHOT','GENERATED','APPROVED','PUBLISHED')),
  created_by uuid references staff_users(id),
  generated_by uuid references staff_users(id),
  approved_by uuid references staff_users(id),
  published_by uuid references staff_users(id),
  created_at timestamptz not null default now(),
  generated_at timestamptz,
  approved_at timestamptz,
  published_at timestamptz
);

create table billing_cycle_items (
  cycle_id int not null references billing_cycles(id) on delete cascade,
  account_id uuid not null references accounts(id),
  meter_id text not null references meters(id),
  opening_l double precision,
  closing_l double precision,
  last_reading_at timestamptz,
  flags text[] not null default '{}',
  resolution text check (resolution in ('ACCEPT','ESTIMATE','HOLD')),
  note text,
  primary key (cycle_id, account_id)
);

create table bills (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  cycle_id int references billing_cycles(id),
  period text not null,
  opening_l double precision not null,
  closing_l double precision not null,
  status text not null check (status in ('DRAFT','PUBLISHED','PAID','OVERDUE')),
  data_basis text not null default 'LIVE' check (data_basis in ('LIVE','SD_SYNCED','ESTIMATED')),
  current_cents int not null,
  arrears_cents int not null default 0,
  total_cents int not null,
  reading_date timestamptz,
  due_date timestamptz,
  paid_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (account_id, period)
);

create table bill_lines (
  id bigserial primary key,
  bill_id uuid not null references bills(id) on delete cascade,
  position int not null,
  kind text not null check (kind in ('TIER','SERVICE','ARREARS','PENALTY','ADJUSTMENT')),
  description text not null,
  qty_m3 double precision,
  rate_cents int,
  amount_cents int not null,
  tariff_version_id int references tariff_versions(id)
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  amount_cents int not null check (amount_cents > 0),
  method text not null default 'CARD',
  reference text not null unique,
  status text not null check (status in ('PENDING','SUCCESS','FAILED')),
  created_by_staff uuid references staff_users(id),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table adjustments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id),
  amount_cents int not null,
  reason text not null,
  created_by uuid references staff_users(id),
  created_at timestamptz not null default now()
);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references accounts(id) on delete cascade,
  meter_id text references meters(id) on delete cascade,
  type text not null check (type in ('LEAK','HIGH_USAGE','BUDGET','DEVICE','BILLING','NOTICE')),
  severity text not null check (severity in ('INFO','WARNING','CRITICAL')),
  title text not null,
  message text not null default '',
  status text not null default 'OPEN' check (status in ('OPEN','RESOLVED')),
  read boolean not null default false,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index alerts_account on alerts (account_id, created_at desc);

create table notices (
  id serial primary key,
  title text not null,
  body text not null,
  zone_ids int[] not null default '{}',
  created_by uuid references staff_users(id),
  created_at timestamptz not null default now()
);

create sequence ticket_seq start 1001;
create table tickets (
  id text primary key default ('TK-' || nextval('ticket_seq')),
  customer_id uuid references customers(id),
  account_id uuid references accounts(id),
  category text not null,
  subject text not null,
  description text not null default '',
  status text not null default 'OPEN' check (status in ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
  assignee_id uuid references staff_users(id),
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table otp_codes (
  identifier text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);

create table refresh_tokens (
  token_hash text primary key,
  subject_type text not null check (subject_type in ('CUSTOMER','STAFF')),
  subject_id uuid not null,
  expires_at timestamptz not null,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

create table audit_logs (
  id bigserial primary key,
  actor_type text not null,
  actor_id text,
  action text not null,
  entity text,
  entity_id text,
  detail jsonb not null default '{}',
  ip text,
  created_at timestamptz not null default now()
);
create index audit_logs_created on audit_logs (created_at desc);
`,
  },
];

export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query<{ id: string }>('select id from schema_migrations')).map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await db.tx(async (t) => {
      await t.exec(m.sql);
      await t.query('insert into schema_migrations (id) values ($1)', [m.id]);
    });
    applied.push(m.id);
  }
  await tryTimescale(db);
  return applied;
}

/** Use TimescaleDB for readings when the extension is installed (optional). */
async function tryTimescale(db: Db): Promise<void> {
  if (db.kind !== 'postgres') return;
  const ext = await db.one(`select 1 from pg_available_extensions where name = 'timescaledb'`);
  if (!ext) return;
  try {
    await db.exec(`create extension if not exists timescaledb`);
    // Hypertables need the time column in every unique index.
    await db.exec(`
      alter table readings drop constraint if exists readings_pkey;
      create unique index if not exists readings_meter_seq_ts on readings (meter_id, seq, ts);
      select create_hypertable('readings', 'ts', if_not_exists => true, migrate_data => true);
      select add_retention_policy('readings', interval '400 days', if_not_exists => true);
    `);
  } catch {
    // Timescale is an optimisation; plain Postgres works without it.
  }
}
