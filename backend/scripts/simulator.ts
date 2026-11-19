/**
 * Smart meter simulator: behaves like the ESP32 firmware over MQTT.
 *
 *   npm run simulate                         # the three demo meters, telemetry every 15 s
 *   npm run simulate -- --leak SWM-000123    # constant slow flow on one meter (leak demo)
 *   npm run simulate -- --backlog 20         # upload 20 "SD card" readings on start (offline sync demo)
 *   npm run simulate -- --meters SWM-000789:demo-secret-789 --interval 5
 *
 * Options: --url mqtt://localhost:1883  --api http://localhost:3000/api/v1  --interval <sec>
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import mqtt from 'mqtt';

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const URL = opt('url', 'mqtt://localhost:1883')!;
const API = opt('api', 'http://localhost:3000/api/v1')!;
const INTERVAL = Number(opt('interval', '15'));
const LEAK = new Set((opt('leak', '') ?? '').split(',').filter(Boolean));
const BACKLOG = Number(opt('backlog', '0'));
const METERS = (opt('meters', 'SWM-000123:demo-secret-123,SWM-000456:demo-secret-456,SWM-000555:demo-secret-555') ?? '')
  .split(',')
  .filter(Boolean)
  .map((s) => {
    const [id, secret] = s.split(':');
    return { id, secret };
  });
const STATE_FILE = '.sim-state.json';
const P = 'swm/v1/meters';

type State = Record<string, { seq: number; totalL: number; valve: 'open' | 'closed' }>;
const state: State = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

/** Continue from the meter's real total so readings never go backwards (asks the API as the demo admin). */
async function startingTotals(): Promise<Record<string, { totalL: number; valve: string }>> {
  try {
    const login = await fetch(`${API}/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@swm.local', password: 'Admin@123' }),
    });
    if (!login.ok) throw new Error(`login ${login.status}`);
    const { accessToken } = (await login.json()) as { accessToken: string };
    const res = await fetch(`${API}/admin/meters`, { headers: { authorization: `Bearer ${accessToken}` } });
    const list = (await res.json()) as { id: string; totalL: number; valve: string }[];
    return Object.fromEntries(list.map((m) => [m.id, { totalL: m.totalL, valve: m.valve }]));
  } catch (e) {
    console.warn(`(could not read meter totals from the API: ${(e as Error).message}; using local state)`);
    return {};
  }
}

const now = () => Math.floor(Date.now() / 1000);
const log = (id: string, msg: string) => console.log(`${new Date().toLocaleTimeString()}  ${id}  ${msg}`);

function runMeter(id: string, secret: string, start: { totalL: number; valve: string } | undefined) {
  const s = (state[id] ??= { seq: now() * 10, totalL: 0, valve: 'open' });
  if (start && start.totalL > s.totalL) s.totalL = start.totalL;
  if (start && (start.valve === 'open' || start.valve === 'closed')) s.valve = start.valve;
  s.seq = Math.max(s.seq, now() * 10);

  const bootId = randomBytes(2).toString('hex');
  const bootAt = Date.now();
  const upMs = () => Date.now() - bootAt;
  let flow = 0;
  let burst = 0;
  let liveUntil = 0;
  const leak = LEAK.has(id);

  const client = mqtt.connect(URL, {
    clientId: `meter-${id}`,
    username: id,
    password: secret,
    clean: false,
    reconnectPeriod: 3000,
    will: { topic: `${P}/${id}/up/status`, payload: Buffer.from(JSON.stringify({ online: false })), qos: 1, retain: true },
  });
  const pub = (kind: string, payload: object, retain = false) =>
    client.publish(`${P}/${id}/up/${kind}`, JSON.stringify(payload), { qos: kind === 'live' || kind === 'heartbeat' ? 0 : 1, retain });

  const telemetry = () => {
    s.seq++;
    pub('telemetry', { seq: s.seq, ts: now(), bootId, upMs: upMs(), totalL: round(s.totalL), flowLpm: round(flow), valve: s.valve });
    saveState();
  };

  client.on('connect', () => {
    log(id, `connected${leak ? ' (leak mode)' : ''}  total=${(s.totalL / 1000).toFixed(3)} m³  valve=${s.valve}`);
    pub('status', { online: true, fw: '1.2.0-sim', bootId }, true);
    client.subscribe(`${P}/${id}/down/#`, { qos: 1 });
    pub('event', { seq: ++s.seq, ts: now(), type: 'BOOT', data: { bootId } });

    if (BACKLOG > 0) {
      // Readings buffered on the SD card while Wi-Fi was down. The first half were taken
      // before NTP sync (ts = 0) and get their time fixed by the server from bootId + upMs.
      const items = [];
      const oldBoot = `${bootId}b`;
      for (let i = 0; i < BACKLOG; i++) {
        s.seq++;
        s.totalL += 2 + Math.random() * 4;
        const ageSec = (BACKLOG - i) * INTERVAL;
        const valid = i >= BACKLOG / 2;
        items.push({ seq: s.seq, ts: valid ? now() - ageSec : 0, bootId: oldBoot, upMs: 600_000 + i * INTERVAL * 1000, totalL: round(s.totalL), flowLpm: 0, valve: s.valve });
      }
      pub('backlog', { items });
      log(id, `uploaded ${BACKLOG} buffered readings`);
    }
    telemetry();
  });

  client.on('message', (topic, buf) => {
    const kind = topic.split('/').pop();
    const msg = JSON.parse(buf.toString());
    if (kind === 'config') {
      log(id, `config v${msg.ver}: calFactor=${msg.calFactor}, telemetry every ${msg.telemetrySec}s`);
      return;
    }
    if (kind !== 'cmd') return;
    if (msg.expiresAt && msg.expiresAt < now()) return log(id, `ignored expired command ${msg.type}`);
    pub('cmd-ack', { cmdId: msg.cmdId, state: 'RECEIVED' });
    switch (msg.type) {
      case 'LIVE_ON':
        liveUntil = Date.now() + (msg.args?.ttlSec ?? 120) * 1000;
        log(id, `live mode for ${msg.args?.ttlSec ?? 120}s`);
        break;
      case 'LIVE_OFF':
        liveUntil = 0;
        break;
      case 'VALVE_CLOSE':
      case 'VALVE_OPEN': {
        const target = msg.type === 'VALVE_CLOSE' ? 'closed' : 'open';
        log(id, `valve → ${target}…`);
        setTimeout(() => {
          s.valve = target;
          if (target === 'closed') flow = 0;
          pub('cmd-ack', { cmdId: msg.cmdId, state: 'EXECUTED', valve: target });
          pub('event', { seq: ++s.seq, ts: now(), type: 'VALVE_CHANGED', data: { valve: target } });
          log(id, `valve ${target}`);
          telemetry();
        }, 1500);
        break;
      }
      default:
        pub('cmd-ack', { cmdId: msg.cmdId, state: 'EXECUTED' });
    }
  });

  client.on('error', (e) => log(id, `error: ${e.message}`));
  client.on('offline', () => log(id, 'offline, retrying…'));

  // Flow model: random bursts of use (taps, showers), or a constant drip in leak mode.
  setInterval(() => {
    if (s.valve === 'closed') flow = 0;
    else if (leak) flow = 1.4 + Math.random() * 0.3;
    else if (burst > 0) {
      burst--;
      flow = Math.min(12, Math.max(2, flow + (Math.random() - 0.5)));
      if (burst === 0) flow = 0;
    } else if (Math.random() < 0.06) {
      burst = 5 + Math.floor(Math.random() * 25);
      flow = 3 + Math.random() * 6;
    }
    s.totalL += flow / 60;
    if (Date.now() < liveUntil && client.connected) pub('live', { ts: now(), flowLpm: round(flow), totalL: round(s.totalL) });
  }, 1000);

  setInterval(() => client.connected && telemetry(), INTERVAL * 1000);
  setInterval(() => client.connected && pub('heartbeat', { ts: now(), rssi: -55 - Math.floor(Math.random() * 15), fw: '1.2.0-sim', heap: 180000, vin: 5.0, onBattery: false }), 30_000);
}

const round = (v: number) => Math.round(v * 1000) / 1000;

const totals = await startingTotals();
console.log(`Simulating ${METERS.length} meter(s) on ${URL}, telemetry every ${INTERVAL}s. Ctrl+C to stop.`);
for (const m of METERS) runMeter(m.id, m.secret, totals[m.id]);
process.on('SIGINT', () => {
  saveState();
  process.exit(0);
});
