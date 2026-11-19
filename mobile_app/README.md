# Smart Water: customer app (Flutter)

Customer app for the smart water meter project. Runs on Android, iOS and the web (the web build is the customer web page). See `../PLAN_AND_ARCHITECTURE.md` for the overall system.

## Run it

```bash
flutter pub get
flutter run                 # demo mode: simulated meter and backend
flutter run -d chrome       # customer web page
flutter test
```

**Demo mode** (the default) needs no backend:

| What | Value |
| --- | --- |
| Sign in | any phone number or email, code `123456` |
| Add a meter | `SWM-000789` / `ABCD-1234` (or `SWM-000999` / `WXYZ-9876`) |
| Leak alert | More → Demo tools → Simulate a leak alert |

## Connect to the real backend

```bash
flutter run --dart-define=USE_MOCK=false \
            --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1 \
            --dart-define=SOCKET_URL=http://10.0.2.2:3000
```

`10.0.2.2` is your computer as seen from the Android emulator. On a real phone use your computer's LAN IP. The endpoints the app calls are all in `lib/data/api_repository.dart` and follow section 7 of the plan.

## Structure

```
lib/
  core/        config, theme, formatting, router, tariff calculator
  data/        models, WaterRepository interface, mock + API implementations, Wi-Fi provisioning
  state/       Riverpod providers (auth, accounts, live flow, valve, usage, bills, alerts)
  widgets/     shared cards, pills, account switcher
  features/    auth, onboarding (add meter, Wi-Fi), home, usage, bills (+ pay), alerts, more
```

## Screens

- **Sign in:** phone or email, then a one-time code.
- **Add meter:** scan the QR code (`swm://claim?meter=…&code=…`) or type the meter ID and claim code, then connect the meter to Wi-Fi.
- **Home:** amount due and Pay, live flow in L/min, meter reading, this month's usage and estimated bill, tier progress bar, budget, valve switch with confirmation and "Closing…" state, top alert, quick actions.
- **Usage:** today / week / month charts, comparison with the previous period, budget with 80 % marker and month-end projection.
- **Bills:** live estimate, past bills, "how your bill is calculated" breakdown per tier, pay (sandbox).
- **Alerts:** filters; a leak alert has a "Close water valve" button.
- **More:** profile, meters and accounts, budget and alert settings, Away Mode, complaints, bill calculator, FAQ, sign out.

## Not done yet

- **Wi-Fi provisioning is simulated.** The real version needs the firmware's setup mode (BLE provisioning, with SoftAP as a fallback). Replace `MockProvisioningService` in `lib/data/provisioning.dart`.
- **Push notifications (FCM)** need a Firebase project (`flutterfire configure`).
- **Bill PDFs and a real payment gateway** wait for the backend.
- **Sinhala and Tamil translations** (the app is English only for now).
