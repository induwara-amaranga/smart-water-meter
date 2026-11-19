# Meter firmware (ESP32-S3)

Arduino sketch for the meter: YF-S201 flow sensor, valve relay, SH1106 OLED, SD card and two buttons. It reports to the backend over MQTT.

## Set up

1. Install the **esp32** board package (Espressif) in the Arduino IDE and pick your ESP32-S3 board.
2. Install these libraries from the Library Manager:
   - PubSubClient (Nick O'Leary)
   - ArduinoJson 7 (Benoit Blanchon)
   - Adafruit SH110X
   - Adafruit GFX
3. Edit `smart_water_meter/config.h`, or copy `config.example.h` to `config.h` for a new meter. It holds:
   - the Wi-Fi name and password;
   - `METER_ID` and `DEVICE_SECRET`, from the registration slip the water board prints;
   - the broker address.
4. Upload the sketch.

Every meter has its own ID and secret. `config.h` is ignored by git because it holds secrets.

## Test with the local backend

1. Run `npm run dev` in `backend/`. The MQTT broker listens on port 1883.
2. Set `MQTT_HOST` to your PC's LAN IP (`ipconfig` → IPv4 address), `MQTT_PORT 1883` and `MQTT_USE_TLS 0`. The ESP32 and the PC must be on the same Wi-Fi.
3. If the meter never connects, allow inbound TCP 1883 in Windows Firewall.
4. `config.h` is set to the demo meter **SWM-000789** (secret `demo-secret-789`). It has no account yet. In the app, add a meter with claim code **ABCD-1234** to see it there.
5. On the meter, the OLED's top-right corner shows ONLINE. The serial monitor (115200 baud) prints connection and command logs.

Use a meter with no earlier readings, such as SWM-000789 or a newly registered one. The demo meters SWM-000123 / 456 / 555 already have large totals in the database. A real device starting from 0 L would raise a "reading went backwards" alert on them.

## Production

- Set `MQTT_HOST` to your broker's hostname, port 8883 and `MQTT_USE_TLS 1`.
- Paste the CA certificate that signed the broker's certificate into `MQTT_CA_CERT`. For Let's Encrypt this is ISRG Root X1.

## What it sends

| Topic `swm/v1/meters/{id}/…` | When |
| --- | --- |
| `up/status` (retained) | `online: true` on connect. The Last Will sets `online: false` if the connection dies. |
| `up/telemetry` | Every `telemetrySec` (15 min by default, set by the backend), after every valve change, and on connect |
| `up/heartbeat` | Every `heartbeatSec` (5 min): Wi-Fi signal, firmware version, free memory |
| `up/event` | `BOOT`, `VALVE_CHANGED` |
| `up/live` | Every second while someone has the app's live view open (`LIVE_ON`) |
| `up/backlog` | After reconnecting: readings stored on the SD card while offline, 20 per message |
| `up/cmd-ack` | `RECEIVED`, then `EXECUTED` or `FAILED`, for each command |

**Commands it handles** (on `down/cmd`): `VALVE_OPEN`, `VALVE_CLOSE`, `LIVE_ON`, `LIVE_OFF`, `REBOOT`, `SYNC_CONFIG`.

**Config** (on `down/config`, retained): calibration factor, telemetry interval and heartbeat interval.

## Offline behaviour

- **Measuring continues without Wi-Fi.** Each reading is appended to `/backlog.txt` on the SD card and uploaded after reconnecting. The file is deleted only after the whole upload succeeds. Sending a reading twice is harmless, because each reading carries a sequence number (`seq`) and the server ignores repeats.
- **Readings taken before the clock is set** are sent with `ts: 0` plus the boot ID and uptime. The server works out the time from those.
- **Wi-Fi and the broker are retried in the background.** Broker retries back off from 2 s up to 1 min.
- **Saved on the SD card:** the total (`/volume.txt`), the sequence counter (`/seq.txt`) and the valve state (`/valve.txt`). After a power cut the valve returns to its last state.
