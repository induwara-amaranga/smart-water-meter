# Water Board Portal (admin dashboard)

React dashboard for water board staff. It talks to the backend in `../backend` (`/api/v1/admin` and Socket.IO).

## Run it

```bash
cd ../backend && npm run dev        # API + MQTT broker on :3000 / :1883
cd ../backend && npm run simulate   # optional: simulated meters, so supply cuts are carried out
npm install && npm run dev          # this dashboard on http://localhost:5173
```

In development, Vite forwards `/api` and `/socket.io` to `http://localhost:3000`. Set `BACKEND_URL` to use another backend. For production, run `npm run build` and serve `dist/` from the same domain as the API, or put both behind one reverse proxy.

Sign in with a demo account from the backend README, for example `admin@swm.local` / `Admin@123`.

## What it does

| Page | Who sees it | What it's for |
| --- | --- | --- |
| **Dashboard** | everyone | Meters online, overdue balances, money collected this month, supply cuts awaiting approval, and lists of approvals and overdue accounts |
| **Consumers** | all roles | Search accounts. An account page shows balance, meter and supply state, contact details, bills and payments. Staff can record counter payments and request to cut or restore the supply. |
| **Register consumer** | admin, customer service | One form: new or existing consumer, then service connection (address, zone, name shown in the app), then meter (register a new one, use one in stock, or assign later). Ends with a printable slip showing the account number, the meter's secret and the claim code. The consumer can sign in to the app with the same mobile number. |
| **Disconnections** | everyone (actions depend on role) | **Unpaid accounts:** overdue accounts with supply still on, filtered by days overdue (default 30+), with "Cut supply" and "Send reminders". It also lists supplies already cut, with "Restore supply". **Awaiting approval:** a second officer approves or rejects. **History:** every request with its status. |
| **Staff** | admin | Add staff with a role and a temporary password, change name or role, reset password, disable or re-enable. Disabling signs the person out everywhere. |

### How a supply cut for unpaid bills works

1. **Request:** a billing officer (or admin or operations) picks an overdue account and asks to cut its supply, with a reason. The reason is stored in the audit log.
2. **Approval:** a **different** officer with approval rights (admin or operations) approves it. The requester can't approve their own request, and the backend enforces this too.
3. **The meter acts:** the backend sends the close command to the meter over MQTT. The request moves from *Sent to meter* to *Meter acting…* to *Done*, live on screen. If the meter doesn't confirm within 60 s, it shows *No response*.
4. **Account suspended:** once the meter confirms, the account shows *Disconnected* and the consumer gets a notice in the app. The consumer can't reopen the valve from the app.
5. **Reconnection:** after payment, "Restore supply" goes through the same request and approval steps, and the account becomes *Active* again.

A request is refused if the meter is offline, if the supply is already in the requested state, or if another request for that meter is already pending.

## Code layout

```
src/
  api/          fetch client (in-memory access token, refresh token in sessionStorage), types
  auth/         sign-in state and permission checks (hides menu items and buttons the role can't use)
  components/   UI kit (buttons, inputs, badges, modal, toasts), layout, cut/restore request dialog
  lib/          formatting, live updates over Socket.IO
  pages/        dashboard, consumers, consumer detail, register, disconnections, staff
```

The rest of the backend's admin API is ready for further pages: tariffs, billing cycles, meters, alerts, tickets, notices, reports and the audit log.
