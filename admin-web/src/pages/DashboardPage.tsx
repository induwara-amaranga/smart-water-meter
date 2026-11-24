import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Banknote, Bell, Clock, Gauge, Receipt } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { ArrearsRow, Overview, ValveRequest } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { SupplyBadge } from '../components/status';
import { Badge, Card, ErrorNote, PageHeader, Spinner, Td, Table } from '../components/ui';
import { daysSince, formatMoney, formatPeriod, plural, timeAgo } from '../lib/format';

/** A headline number: value in ink, label muted, optional status line with icon + words. */
function StatTile({ icon, label, value, detail, status }: { icon: ReactNode; label: string; value: string; detail?: string; status?: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2 text-sm text-slate-600">
        <span className="text-slate-400">{icon}</span>
        {label}
      </div>
      <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-slate-900">{value}</p>
      {detail && <p className="mt-1 text-sm text-slate-500">{detail}</p>}
      {status && <div className="mt-3">{status}</div>}
    </div>
  );
}

export function DashboardPage() {
  const { user, can } = useAuth();
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/stats/overview') });
  const pending = useQuery({
    queryKey: ['valve-requests', 'AWAITING_APPROVAL'],
    queryFn: () => api<ValveRequest[]>('/valve-requests?state=AWAITING_APPROVAL'),
    enabled: can('meters.view'),
  });
  const arrears = useQuery({ queryKey: ['arrears'], queryFn: () => api<ArrearsRow[]>('/arrears'), enabled: can('billing.view') });

  if (overview.isLoading) return <Spinner />;
  if (overview.error) return <ErrorNote error={overview.error} />;
  const o = overview.data!;
  const overdue = (arrears.data ?? []).filter((a) => a.overdueBills > 0 && a.valve !== 'closed');

  return (
    <>
      <PageHeader title={`Good ${new Date().getHours() < 12 ? 'morning' : 'afternoon'}, ${user?.name.split(' ')[0]}`} description="Network status and work waiting for you." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={<Gauge className="size-4" />}
          label="Meters online"
          value={`${o.meters.online} / ${o.meters.total}`}
          detail={`${o.meters.onlinePct}% reporting · ${o.consumption.todayM3.toLocaleString()} m³ used today`}
          status={o.meters.offline > 0 ? <Badge tone="warning">{o.meters.offline} offline</Badge> : <Badge tone="good">All reporting</Badge>}
        />
        <StatTile
          icon={<Receipt className="size-4" />}
          label="Overdue balances"
          value={formatMoney(o.billing.overdueCents)}
          detail={`${plural(o.billing.overdueAccounts, 'account')} past the due date`}
          status={o.billing.overdueAccounts > 0 ? <Badge tone="critical">Action needed</Badge> : <Badge tone="good">None overdue</Badge>}
        />
        <StatTile
          icon={<Banknote className="size-4" />}
          label="Collected this month"
          value={formatMoney(o.billing.collectedThisMonthCents)}
          detail={o.billing.lastPeriod ? `Last bills: ${formatPeriod(o.billing.lastPeriod)}, ${formatMoney(o.billing.issuedCents)} issued` : 'No bills published yet'}
        />
        <StatTile
          icon={<Clock className="size-4" />}
          label="Supply cuts awaiting approval"
          value={String(o.valveApprovalsPending)}
          detail={`${plural(o.meters.closed, 'supply', 'supplies')} cut now · ${plural(o.alerts.open, 'open alert')}`}
          status={o.alerts.critical > 0 ? <Badge tone="critical">{plural(o.alerts.critical, 'critical alert')}</Badge> : <Badge tone="good">No critical alerts</Badge>}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        {can('meters.view') && (
          <Card
            title="Waiting for approval"
            padded={false}
            actions={<Link to="/disconnections?tab=approvals" className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline">Open <ArrowRight className="size-4" /></Link>}
          >
            {pending.isLoading ? (
              <Spinner />
            ) : (pending.data ?? []).length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-slate-500">Nothing waiting. Requests to cut or restore supply appear here.</p>
            ) : (
              <Table head={['Account', 'Action', 'Requested']}>
                {pending.data!.slice(0, 6).map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <p className="font-medium text-slate-900">{r.holderName ?? r.meterId}</p>
                      <p className="text-xs text-slate-500">{r.accountNo} · {r.meterId}</p>
                    </Td>
                    <Td>{r.type === 'VALVE_CLOSE' ? <Badge tone="critical">Cut supply</Badge> : <Badge tone="good">Restore supply</Badge>}</Td>
                    <Td className="text-slate-500">{r.requestedByName} · {timeAgo(r.createdAt)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {can('billing.view') && (
          <Card
            title="Overdue accounts with supply on"
            padded={false}
            actions={<Link to="/disconnections" className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline">All overdue <ArrowRight className="size-4" /></Link>}
          >
            {arrears.isLoading ? (
              <Spinner />
            ) : overdue.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-slate-500">No overdue accounts with water still on.</p>
            ) : (
              <Table head={['Account', 'Due', 'Overdue', 'Supply']}>
                {overdue.slice(0, 6).map((a) => (
                  <tr key={a.accountId}>
                    <Td>
                      <Link to={`/consumers/${a.accountId}`} className="font-medium text-slate-900 hover:underline">{a.holderName}</Link>
                      <p className="text-xs text-slate-500">{a.accountNo}</p>
                    </Td>
                    <Td className="tabular-nums">{formatMoney(a.amountDueCents)}</Td>
                    <Td className="whitespace-nowrap tabular-nums">{plural(daysSince(a.oldestDueDate), 'day')}</Td>
                    <Td><SupplyBadge valve={a.valve} online={a.meterOnline} /></Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}
      </div>

      {o.alerts.leaks > 0 && (
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <Bell className="size-4" /> {o.alerts.leaks} possible leak{o.alerts.leaks === 1 ? '' : 's'} reported by meters.
        </div>
      )}
    </>
  );
}
