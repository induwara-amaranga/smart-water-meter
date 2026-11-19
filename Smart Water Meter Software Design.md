# Smart Water Meter: Software Design

Customer app and web, and water board portal. Design document, no code. Group 35.

## 1. What existing apps do, and what that means for the project

| Reference | What it offers | Take from it |
| --- | --- | --- |
| NWSDB SelfCare (Sri Lanka) | Online bill payment, payment and outstanding details, bill details, a bill calculator, complaint submission and status, multiple accounts, interruption notices | The baseline customer features. The app must match these. |
| Flume (smart water monitor) | Real-time usage, daily/weekly/monthly reports, automatic suggested budgets, leak alerts, and an "Away Mode" that notifies emergency contacts | The advantage over NWSDB: live data, leak alerts and budgets. |
| Online Water Bill (utility software) | Meter-reading routes, automated billing and invoicing, a customer portal, automated due-date and delinquency reminders, work orders for field staff | The structure of the board portal. |
| DIGIT mGramSeva | Bill generation from previous and new reading, arrears and advance entry, payment collection, bill sharing by SMS | The billing screens in the board portal. |
| Northumbrian Water | Bill history and an "Explain My Bill" feature | Worth copying, because tiered tariffs confuse people. |

Photo-based meter reading, such as the Maldives MWSC app, is not needed here because the meter reports by itself. This removes the meter reader.

## 2. System architecture

```
ESP32-S3 meter --Wi-Fi--> Cloud backend <--> Customer web / mobile app
  (flow, valve,           (API + database    Water board web portal
   SD buffer)              + billing engine
                           + notifications)
```

Three design decisions follow from the Wi-Fi-only change:

1. **The meter becomes a client.** The ESP32 used to host its own web page. A home router blocks inbound connections, so a phone outside the house cannot reach it. The meter must push data to the cloud and fetch valve commands from it.
2. **The cloud owns the bill, not the meter.** The ESP32 reports only the cumulative volume (totalLiters) with a timestamp and a sequence number. The server calculates the bill. The OLED can still show an estimate.
3. **Billing uses cumulative readings, not the sum of messages.** If Wi-Fi drops, a lost message loses nothing, because the next message carries the running total. The SD card holds the backlog and the meter uploads it when Wi-Fi returns.

**Data volume (numeric check):** a reading every 15 min is 96 per day, or 35,040 per year per meter. For 10,000 meters that is about 350 million rows per year. So the design needs hourly and daily roll-up tables and a retention rule (for example raw data for 90 days, daily totals forever).

## 3. Missing items needed because of the hardware

| Gap | Why it matters | Design answer |
| --- | --- | --- |
| Wi-Fi setup | Credentials are typed into the code. A customer cannot do that. | First-boot setup mode: the meter opens its own hotspot, or the app sends credentials. The app guides it with a "Connect your meter" wizard. Remove the hardcoded SSID and password from the code too. |
| Device identity and security | Anyone could fake a meter or send a valve command. | Unique meter ID, per-device secret key, encrypted connection, and a claim code printed on the meter that the customer enters to link it to their account. |
| No real-time clock | After a reboot with no Wi-Fi, the ESP32 does not know the time. | Get the time from the internet (NTP) when online. Store sequence numbers with each SD entry and let the server fix timestamps afterwards. A DS3231 clock module on the I2C lines is an easy later upgrade. |
| Online/offline status | The board needs to know which meters are dead. | A heartbeat every few minutes: last-seen time, Wi-Fi signal, firmware version. The server marks the meter offline after about 3 missed beats. |
| Valve command confirmation | The relay state is not the same as the valve state, because nothing senses the valve. | Command lifecycle: sent, received, executed, confirmed or failed. Show "Closing..." in the app until the meter confirms. |
| Valve safety | A remote shut-off can cause harm (a hospital, a fire sprinkler). | The customer can close and reopen their own valve. A board-initiated shut-off needs a second officer's approval, a reason, and an audit log entry. Install a manual bypass valve for emergencies. |
| Billing during offline periods | The meter keeps counting offline, but the cloud has not seen it. | Mark such a bill "based on SD-synced data", or hold the bill until the sync arrives (up to a limit, then estimate). |
| Leak detection | This is the Flume feature people value most. | Rules: continuous flow for more than N hours, or flow during the night window. The YF-S201 is typically specified from about 1 L/min, so slow drips are invisible to it. Check the datasheet and state this in the limitations. |
| Tamper and fault alarms | A meter can be cheated or fail. | Flags for no pulses while the valve is open, a long offline period, a power-loss event, and a calibration mismatch. |
| Firmware updates | The board cannot visit every house. | Over-the-air updates, pushed by the board with a staged rollout. |
| Calibration | Sensor accuracy differs per unit. | Store a calibration factor per meter on the server and let the board adjust it. Show a "±10 %" accuracy note in the app. |
| Power-state reporting | The UPS works silently. | A "running on battery" event, if the supply voltage can be read (a spare ADC pin through a divider). Otherwise skip it. |

## 4. Customer mobile app

**Navigation (bottom bar, 5 tabs):** Home, Usage, Bills, Alerts, More.

**Sign-up flow:** phone or email OTP, then "Add meter" (scan QR or type the meter ID and claim code), then Wi-Fi setup, then a first-reading confirmation.

**Home screen (top to bottom):**

1. **Header card:** account name and meter status (green Online, grey Offline).
2. **Live flow:** a big number in L/min, which goes to zero when idle.
3. **This month:** units used (m³) and the estimated bill so far.
4. **Tier progress bar:** for example "7.2 of 10 units used. The next unit costs more." Customers see the tariff steps in real time.
5. **Valve control:** one large OPEN/CLOSED switch, with a confirmation popup ("Close water supply?") and the "Closing..." state.
6. **Alert strip:** the most important active alert (leak, offline, bill due).

**Other tabs:**

- **Usage:** live graph, day/week/month toggle, "this month vs last month", a budget line with a warning at 80 %.
- **Bills:** current estimate, past bills, a bill breakdown screen (usage per tier, service charge, arrears), PDF download, and the Pay button.
- **Alerts:** list with filters (leak, high usage, device, billing, board notices).
- **More:** profile, multiple meters/accounts, budget and alert settings, language (Sinhala, Tamil, English), Away Mode, family members, complaints and support tickets, FAQ, bill calculator.

**Worked example for the breakdown screen** (using the tariff in the current code, which the board will be able to change): 12 m³ gives 10 × Rs.10 + 2 × Rs.15 = Rs.130 usage charge, plus Rs.400 service charge, so Rs.530.

## 5. Customer web page

Same features and the same data as the app. The differences:

- **Layout:** left sidebar (Dashboard, Usage, Bills, Alerts, Support, Settings) with wider charts.
- **Extras:** CSV export of usage, printable bills, side-by-side month comparison, and account/profile management.
- **Responsive:** it works on a phone browser too, so it doubles as a fallback.

## 6. Water board web portal

**Roles:** Admin, Billing Officer, Operations/Technician, Customer Service, Auditor (read-only). Each role sees only its own menu items.

| Module | Content |
| --- | --- |
| Dashboard | Active meters, online %, consumption today and this month, open alerts, bills issued, collected, and overdue. |
| Map / zones | Meters on a map grouped by zone. Red for offline or leak. |
| Customers and connections | Registration, new-connection requests, meter assignment (links claim code to account), status (active, suspended, closed). |
| Meters and devices | Fleet table with last seen, firmware, Wi-Fi signal, calibration, tamper flags. Actions: OTA update, recalibrate, replace meter. |
| Consumption analytics | Per-zone usage, night-flow leaks, top consumers, anomaly list. |
| Tariff management | See below. |
| Billing | See the monthly cycle below. |
| Payments and arrears | Payment list and reconciliation, overdue accounts, reminder sending, and the disconnection workflow (with approval). |
| Valve commands | Remote close/open with reason, approval and history. |
| Tickets and work orders | Customer complaints, leak and offline alerts turned into a job assigned to a technician. |
| Notices | Broadcasts such as planned interruptions or tariff changes, by zone. |
| Reports | Monthly revenue, consumption, collection rate, PDF/CSV export. |
| Users and audit log | Staff accounts, roles, and a record of every change. |

### Tariff management

- A tariff is a **versioned table** (slabs with unit ranges, rate per unit, service charge) with an **effective date**.
- Workflow: Draft, Preview (a calculator showing sample bills), Approve, Scheduled, Active. Old versions stay in history.
- If a tariff changes mid-month, the engine splits the month: usage before the effective date is billed at the old rate, usage after at the new rate. This works because readings are cumulative.
- A tariff change automatically creates a notice to customers.

### Monthly billing cycle (after month end)

```
Last day 23:59  -> Snapshot: the closing reading of every meter
Day 1           -> Validation: flag missing data, negative usage, sudden spikes, offline meters
Day 1-2         -> Exceptions queue: officer fixes, estimates, or holds each flagged bill
Day 2           -> Generate: price every account using the tariff version(s) in force
Day 2           -> Review and approval (totals, sample bills)
Day 3           -> Publish: bills appear in app/web, push + email/SMS notification
Due date        -> Reminder 3 days before, overdue flag after, penalty rule if the board has one
```

Support **adjustments and credit notes** (disputed bill, meter fault), and keep each bill locked after publishing, so changes are corrections, not edits.

## 7. Main data objects

Customer, Account, Meter, Reading, Event (valve change, leak, tamper, offline), Command, Tariff and TariffSlab, BillingCycle, Bill and BillLine, Payment, Alert, Ticket, Notice, User and Role, AuditLog.

## 8. Practical choices for a semester project

- **Payments:** build a mock payment page, or use a sandbox of a Sri Lankan gateway. Real money handling is out of scope. NWSDB already has payment partners such as Pay&Go (kiosks, POS terminals and a mobile payment app), so show the system integrating with them in future.
- **One codebase:** a responsive web app that is also installable on a phone (a PWA) covers the customer web page and the "mobile app" with the least work. A native app is a later upgrade.
- **Demo order:** run the meter, show live flow in the app, close the valve from the phone, trigger a leak alert, then run a billing cycle in the portal and open the bill on the customer side.
- **Privacy:** usage data reveals when people are home, so keep it private per customer and keep the board's access logged.

## Sources

NWSDB SelfCare (App Store listing), Flume product and help pages, Online Water Bill (GetApp listing), DIGIT mGramSeva user manual, Northumbrian Water app listing, MWSC Mobile App case study, Pay&Go and NWSDB (Ada Derana Business).
