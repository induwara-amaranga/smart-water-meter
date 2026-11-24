# Smart Water: backend

Express API, MQTT broker and ingest, billing engine and background jobs for the smart water meter project. It serves the Flutter customer app (`../mobile_app`) and the water board dashboard. Design: `../PLAN_AND_ARCHITECTURE.md`.

```
ESP32 meter ──MQTT (1883 / 8883 TLS)──► embedded broker (Aedes) ──► ingest ──► PostgreSQL
                                              ▲                                     │
                        valve commands, config│                                     ▼
Flutter app / admin dashboard ──HTTPS /api/v1──► Express API ──Socket.IO──► live flow, valve, alerts
```

## Quick start (no setup needed)

```bash
npm install
npm run dev          # API on :3000, MQTT broker on :1883, demo data loaded on first start
npm run simulate     # in a second terminal: 3 simulated meters
```

With no `DATABASE_URL`, the backend uses **PGlite**, a real PostgreSQL engine that runs inside Node. Its data is stored in `./data/pglite`. Run `npm run reset` to start again from fresh demo data.

Other commands: `npm test` runs the test suite, and `npm run build && npm start` runs the production build.

### Demo logins

| Who | Login |
| --- | --- |
| Customer (app) | phone `0771234567` (or `demo@swm.local`), code `123456` |
| Admin | `admin@swm.local` / `Admin@123` |
| Billing officers (two, for the approval rule) | `billing@swm.local`, `billing2@swm.local` / `Billing@123` |
| Operations | `ops@swm.local` / `Ops@12345` |
| Customer service | `cs@swm.local` / `Support@123` |
| Auditor (read-only) | `auditor@swm.local` / `Audit@123` |

| Meter | MQTT password (device secret) | Claim code | Linked to |
| --- | --- | --- | --- |
| SWM-000123 | `demo-secret-123` | ABCD-1111 | Demo Customer "Home" |
| SWM-000456 | `demo-secret-456` | ABCD-2222 | Demo Customer "Parents" |
| SWM-000555 | `demo-secret-555` | ABCD-5555 | Lakeside Bakery (no app user) |
| SWM-000789 | `demo-secret-789` | ABCD-1234 | not linked: claim it in the app |
| SWM-000999 | `demo-secret-999` | WXYZ-9876 | not linked |

The demo data includes 130 days of hourly readings and three past billing cycles. The cycles ran through the real billing workflow: the older bills are paid and the latest is unpaid.

### Simulator

```bash
npm run simulate -- --interval 5                 # telemetry every 5 s instead of 15 s
npm run simulate -- --leak SWM-000123            # steady slow flow (leak alert demo)
npm run simulate -- --backlog 20                 # upload 20 buffered "SD card" readings on start
npm run simulate -- --meters SWM-000789:demo-secret-789
```

The simulator answers valve commands, streams live flow while the app has the Home screen open, and stores its state in `.sim-state.json` so totals never go backwards.

### Connect the Flutter app

```bash
cd ../mobile_app
flutter run --dart-define=USE_MOCK=false \
            --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1 \
            --dart-define=SOCKET_URL=http://10.0.2.2:3000
```

On a real phone, use your computer's LAN IP instead of `10.0.2.2`.

## Configuration

Copy `.env.example` to `.env`. The settings that matter most:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. Empty = PGlite. If TimescaleDB is installed, readings become a hypertable automatically. |
| `JWT_SECRET`, `MQTT_SERVICE_PASSWORD` | Must be changed for production (startup refuses the dev JWT secret when `NODE_ENV=production`). |
| `SEED_DEMO` | Load demo data into an empty database. |
| `EMBEDDED_BROKER`, `MQTT_URL` | Use the built-in broker, or an external one. |
| `MQTT_TLS_KEY`, `MQTT_TLS_CERT` | Enables the MQTT TLS listener on 8883 (use this for real meters). |
| `DEV_OTP` | Code accepted for any customer outside production. Real codes are logged until an SMS provider is added. |

To use the local PostgreSQL 17 install: `createdb smart_water`, then set `DATABASE_URL=postgresql://postgres:<password>@localhost:5432/smart_water`. Tables are created on start. `docker compose up --build` runs PostgreSQL with TimescaleDB plus the backend.

## Deploying to AWS

Production runs on one EC2 server with Docker Compose (`../deploy/aws/`): PostgreSQL, this backend (API, Socket.IO, MQTT broker on 1883) and Caddy for HTTPS. GitHub Actions (`../.github/workflows/backend.yml`) tests every pull request, builds the Docker image, and on pushes to `main` pushes it to GitHub Container Registry and rolls it out over SSH. Setup steps and the required GitHub secrets are in `../docs/DEPLOYMENT.md`.

The image has a Docker `HEALTHCHECK` on `/health`, so the deploy waits until the API, database and broker are all up.

To drive the hosted server with simulated meters from your PC:

```bash
npm run simulate -- --url mqtt://<elastic-ip>:1883 --api https://<domain>/api/v1 --meters SWM-000789:demo-secret-789
```

## MQTT contract (for the firmware)

Prefix `swm/v1/meters/{meterId}`. Connect with **client ID `meter-{meterId}`**, **username = meter ID**, **password = device secret**. A meter can only publish to its own `up/…` topics and subscribe to its own `down/…` topics.

| Topic | Dir | Payload |
| --- | --- | --- |
| `up/status` (retained, also the Last Will with `online:false`) | ↑ | `{online, fw?, bootId?}` |
| `up/telemetry` (every 15 min and on valve change) | ↑ | `{seq, ts, bootId?, upMs?, totalL, flowLpm?, valve?}` |
| `up/backlog` (after reconnect, ≤200 items) | ↑ | `{items: [reading…]}` |
| `up/live` (only while live mode is on) | ↑ | `{ts?, flowLpm, totalL}` |
| `up/heartbeat` (every 5 min) | ↑ | `{rssi?, fw?, heap?, vin?, onBattery?}` |
| `up/event` | ↑ | `{seq?, ts?, type: POWER_LOSS \| POWER_RESTORED \| VALVE_CHANGED \| BOOT \| TAMPER_SUSPECTED, data?}` |
| `up/cmd-ack` | ↑ | `{cmdId, state: RECEIVED \| EXECUTED \| FAILED, valve?, err?}` |
| `down/cmd` | ↓ | `{cmdId, type: VALVE_OPEN \| VALVE_CLOSE \| LIVE_ON \| LIVE_OFF \| …, args, expiresAt}` |
| `down/config` (retained) | ↓ | `{ver, calFactor, telemetrySec, heartbeatSec, tariff: {slabs:[{upTo, rate}], service}}` |

Rules the backend relies on:
- **`seq` never decreases** (keep it on the SD card). Duplicates are ignored.
- **`totalL` is cumulative.** A drop raises a tamper alert.
- **`ts = 0` means the clock isn't set yet.** The server repairs the time from `bootId` + `upMs` once a reading from the same boot has a real time.
- **Ignore commands whose `expiresAt` has passed, and acknowledge each stage.** The server marks unconfirmed valve commands as TIMEOUT after 60 s.

**Using EMQX or Mosquitto instead:** set `EMBEDDED_BROKER=false` and `MQTT_URL`, create the service user, and configure the same authentication and topic rules in that broker.

## API overview

All routes are under `/api/v1`. Errors come back as `{ message }` with a fitting HTTP status.

**Customer** (Bearer token from `/auth/otp/verify`):
- **Auth:** `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/refresh` (rotating), `POST /auth/logout`
- **Profile:** `GET|PATCH /me`, `POST /me/fcm-token`
- **Meters:** `GET /accounts`, `POST /meters/claim`, `GET /meters/:id/summary`, `GET /meters/:id/usage?range=day|week|month`, `POST /meters/:id/live`, `POST /meters/:id/valve`
- **Billing:** `GET /accounts/:id/balance`, `GET /accounts/:id/bills`, `GET /bills/estimate?accountId=`, `GET /bills/:id`, `GET /bills/:id/pdf`, `POST /payments/checkout` (sandbox), `GET /accounts/:id/payments`
- **Other:** `GET /alerts`, `PATCH /alerts/:id`, `GET|PUT /accounts/:id/settings`, `GET|POST /tickets`, `GET /tariffs/active`, `POST /tariffs/calculate`

**Water board** (`/admin`, staff token from `/admin/auth/login`; every route checks role permissions and every change is audit-logged):
- **Dashboard:** `stats/overview`, `stats/consumption`, `map/meters`, `zones`
- **Customers and meters:** `customers`, `accounts` (create, update, assign meter, counter payments, adjustments), `meters` (register returns the one-time secret and claim code QR; calibration and intervals publish to the meter; rotate secret; usage views are audit-logged)
- **Analytics:** `analytics/top-consumers`, `analytics/zones`, `analytics/anomalies`
- **Tariffs:** draft, then preview, then approval by a second person. Approval sends a notice to all customers and pushes the new prices to the meters.
- **Billing cycles:** create (snapshot plus validation flags), then `items` (exceptions queue), then `generate`, then `approve` (must be a different officer), then `publish`. Also `bills/:id(/pdf)`.
- **Payments:** `payments`, `arrears`, `arrears/reminders`
- **Valve requests:** a request with a reason, approved by a second officer. A customer can't reopen a supply the board closed.
- **Support:** `alerts` (resolve, or turn into a work order), `tickets`, `notices` (by zone)
- **Admin:** `users`, `audit-logs`, `reports/monthly?format=csv`

**Realtime:** connect Socket.IO with `auth: { token }` and emit `subscribe {meterId}`. Events: `meter:live`, `meter:valve` (SENT → RECEIVED → CONFIRMED / FAILED / TIMEOUT), `meter:status`, `alert:new`, `bill:published`.

## Background jobs

| Job | Every | Does |
| --- | --- | --- |
| Offline sweep | 1 min | Marks a meter offline after 3 missed heartbeats, and alerts the customer after 30 min offline |
| Command timeout | 10 s | Unconfirmed valve commands become TIMEOUT, with an alert |
| Leak rules | 5 min | Continuous flow for 3 h, or more than 20 L used between 01:00 and 04:00 |
| Usage rules | 15 min | Budget alerts at 80% and 100%, and days with more than 3× normal use |
| Bill reminders | 1 h | Due-in-3-days reminders and overdue flags |

Instant checks run during ingest: readings going backwards, flow while the valve is closed, any flow in Away Mode, and running on battery.

## Not done yet

- **SMS, email and push** (FCM) are logged instead of sent. They plug in at `notify()` in `src/services/alerts.ts` and `requestOtp()` in `src/services/auth.ts`.
- **Payments** use a sandbox that succeeds immediately. A real gateway (e.g. PayHere) needs a checkout URL and a webhook.
- **Firmware updates over the air** (OTA): the `down/ota` topic is in the contract, but there is no upload or rollout endpoint yet.
- **Limits:** no rate limiting beyond the 30-second gap between code requests. Add rate limits on login and claim attempts before going public.
