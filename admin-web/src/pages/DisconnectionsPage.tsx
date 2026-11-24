import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, PowerOff, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api/client';
import type { ArrearsRow, ValveRequest } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AccountStatusBadge, CommandStateBadge, SupplyBadge } from '../components/status';
import { ValveRequestModal, type ValveTarget } from '../components/ValveRequestModal';
import { Badge, Button, Card, EmptyState, ErrorNote, Modal, PageHeader, Select, Spinner, Td, Table, Textarea, useToast } from '../components/ui';
import { daysSince, formatDate, formatDateTime, formatMoney, plural, timeAgo } from '../lib/format';

type Tab = 'overdue' | 'approvals' | 'history';

export function DisconnectionsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const defaultTab: Tab = can('billing.view') ? 'overdue' : 'approvals';
  const tab = (params.get('tab') as Tab) || defaultTab;

  const requests = useQuery({ queryKey: ['valve-requests', 'all'], queryFn: () => api<ValveRequest[]>('/valve-requests') });
  const awaiting = (requests.data ?? []).filter((r) => r.state === 'AWAITING_APPROVAL');

  const tabs: { id: Tab; label: string; count?: number; show: boolean }[] = [
    { id: 'overdue', label: 'Unpaid accounts', show: can('billing.view') },
    { id: 'approvals', label: 'Awaiting approval', count: awaiting.length, show: true },
    { id: 'history', label: 'History', show: true },
  ];

  return (
    <>
      <PageHeader
        title="Disconnections"
        description="Cut the supply of accounts with unpaid bills, and restore it once they pay. Every request needs a reason and a second officer's approval before the meter's valve moves."
      />
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              onClick={() => setParams({ tab: t.id })}
              className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium ${tab === t.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
            >
              {t.label}
              {!!t.count && <span className="rounded-full bg-amber-100 px-2 text-xs font-semibold text-amber-900">{t.count}</span>}
            </button>
          ))}
      </div>
      {tab === 'overdue' && can('billing.view') && <UnpaidTab />}
      {tab === 'approvals' && <ApprovalsTab requests={awaiting} loading={requests.isLoading} error={requests.error} />}
      {tab === 'history' && <HistoryTab requests={requests.data ?? []} loading={requests.isLoading} />}
    </>
  );
}

// ------------------------------------------------------------- unpaid accounts

function UnpaidTab() {
  const { can } = useAuth();
  const toast = useToast();
  const [minDays, setMinDays] = useState('30');
  const [target, setTarget] = useState<{ t: ValveTarget; action: 'CLOSE' | 'OPEN' } | null>(null);
  const arrears = useQuery({ queryKey: ['arrears'], queryFn: () => api<ArrearsRow[]>('/arrears') });

  const remind = useMutation({
    mutationFn: () => api<{ sent: number }>('/arrears/reminders', { method: 'POST' }),
    onSuccess: (r) => toast(r.sent ? `Reminder sent to ${r.sent} account(s)` : 'Everyone overdue was already reminded today', 'info'),
  });

  if (arrears.isLoading) return <Spinner />;
  if (arrears.error) return <ErrorNote error={arrears.error} />;

  const rows = arrears.data!;
  const cut = rows.filter((r) => r.valve === 'closed');
  const candidates = rows.filter((r) => r.valve !== 'closed' && r.amountDueCents > 0 && daysSince(r.oldestDueDate) >= Number(minDays) && (minDays === '0' || r.overdueBills > 0));

  const targetOf = (r: ArrearsRow): ValveTarget => ({ meterId: r.meterId!, accountNo: r.accountNo, holderName: r.holderName, amountDueCents: r.amountDueCents, overdueBills: r.overdueBills });

  return (
    <div className="space-y-6">
      <Card
        title={`Overdue with supply on (${candidates.length})`}
        padded={false}
        actions={
          <div className="flex items-center gap-2">
            <Select aria-label="Minimum days overdue" value={minDays} onChange={(e) => setMinDays(e.target.value)} className="h-9 w-48 py-0">
              <option value="0">Any unpaid balance</option>
              <option value="1">Past due date</option>
              <option value="14">14+ days overdue</option>
              <option value="30">30+ days overdue</option>
              <option value="60">60+ days overdue</option>
            </Select>
            {can('payments.manage') && (
              <Button size="sm" variant="secondary" icon={<Bell className="size-4" />} loading={remind.isPending} onClick={() => remind.mutate()}>
                Send reminders
              </Button>
            )}
          </div>
        }
      >
        <Table
          head={['Account', 'Balance due', 'Overdue', 'Last payment', 'Supply', '']}
          empty={candidates.length === 0 && <EmptyState icon={<Check className="size-10" />} title="No accounts match" message="Try a shorter overdue period." />}
        >
          {candidates.map((r) => {
            const days = daysSince(r.oldestDueDate);
            return (
              <tr key={r.accountId}>
                <Td>
                  <Link to={`/consumers/${r.accountId}`} className="font-medium text-slate-900 hover:underline">
                    {r.holderName}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {r.accountNo} · {r.address}
                  </p>
                </Td>
                <Td className="font-medium tabular-nums text-slate-900">{formatMoney(r.amountDueCents)}</Td>
                <Td>
                  {r.overdueBills > 0 ? (
                    <span className="tabular-nums">
                      {plural(days, 'day')} · {plural(r.overdueBills, 'bill')}
                    </span>
                  ) : (
                    <span className="text-slate-500">Not yet due</span>
                  )}
                </Td>
                <Td className="text-slate-500">{formatDate(r.lastPaymentAt)}</Td>
                <Td>
                  <SupplyBadge valve={r.valve} online={r.meterOnline} />
                </Td>
                <Td className="text-right">
                  {r.pendingRequest ? (
                    <CommandStateBadge state={r.pendingRequest.state as ValveRequest['state']} />
                  ) : !r.meterId ? (
                    <Badge tone="neutral">No meter</Badge>
                  ) : (
                    can('valve.request') && (
                      <Button size="sm" variant="danger" icon={<PowerOff className="size-4" />} onClick={() => setTarget({ t: targetOf(r), action: 'CLOSE' })}>
                        Cut supply
                      </Button>
                    )
                  )}
                </Td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <Card title={`Supply currently cut (${cut.length})`} padded={false}>
        <Table
          head={['Account', 'Balance due', 'Account status', '']}
          empty={cut.length === 0 && <p className="px-5 py-8 text-center text-sm text-slate-500">No supplies are cut at the moment.</p>}
        >
          {cut.map((r) => (
            <tr key={r.accountId}>
              <Td>
                <Link to={`/consumers/${r.accountId}`} className="font-medium text-slate-900 hover:underline">
                  {r.holderName}
                </Link>
                <p className="text-xs text-slate-500">{r.accountNo}</p>
              </Td>
              <Td className="tabular-nums">{r.amountDueCents > 0 ? formatMoney(r.amountDueCents) : <Badge tone="good">Paid up</Badge>}</Td>
              <Td>
                <AccountStatusBadge status={r.accountStatus} />
              </Td>
              <Td className="text-right">
                {r.pendingRequest ? (
                  <CommandStateBadge state={r.pendingRequest.state as ValveRequest['state']} />
                ) : (
                  can('valve.request') && (
                    <Button size="sm" variant={r.amountDueCents > 0 ? 'secondary' : 'primary'} onClick={() => setTarget({ t: targetOf(r), action: 'OPEN' })}>
                      Restore supply
                    </Button>
                  )
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      <ValveRequestModal target={target?.t ?? null} action={target?.action ?? 'CLOSE'} onClose={() => setTarget(null)} />
    </div>
  );
}

// ------------------------------------------------------------------ approvals

function ApprovalsTab({ requests, loading, error }: { requests: ValveRequest[]; loading: boolean; error: unknown }) {
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [rejecting, setRejecting] = useState<ValveRequest | null>(null);
  const [note, setNote] = useState('');

  const decide = useMutation({
    mutationFn: ({ id, approve, note }: { id: string; approve: boolean; note?: string }) =>
      api<ValveRequest>(`/valve-requests/${id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: approve ? undefined : { note } }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['valve-requests'] });
      void qc.invalidateQueries({ queryKey: ['arrears'] });
      toast(v.approve ? 'Approved. Command sent to the meter.' : 'Request rejected', v.approve ? 'info' : 'neutral');
      setRejecting(null);
      setNote('');
    },
    onError: (e) => toast(e instanceof Error ? e.message : 'Could not complete the action', 'critical'),
  });

  if (loading) return <Spinner />;
  if (error) return <ErrorNote error={error} />;
  if (requests.length === 0)
    return (
      <Card>
        <EmptyState icon={<Check className="size-10" />} title="Nothing to approve" message="Requests to cut or restore supply appear here for a second officer to approve." />
      </Card>
    );

  return (
    <div className="space-y-4">
      {!can('valve.approve') && (
        <p className="rounded-lg bg-slate-100 px-4 py-2.5 text-sm text-slate-700">You can see these requests, but approving needs an administrator or operations officer.</p>
      )}
      {requests.map((r) => {
        const own = r.initiatedBy.id === user?.id;
        const cut = r.type === 'VALVE_CLOSE';
        return (
          <Card key={r.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  {cut ? <Badge tone="critical">Cut supply</Badge> : <Badge tone="good">Restore supply</Badge>}
                  <span className="font-medium text-slate-900">{r.holderName ?? 'Unassigned meter'}</span>
                  <span className="text-sm text-slate-500">
                    {r.accountNo} · {r.meterId}
                  </span>
                </div>
                <p className="text-sm text-slate-700">{r.reason}</p>
                <p className="text-xs text-slate-500">
                  Requested by {own ? 'you' : r.requestedByName} · {timeAgo(r.createdAt)}
                </p>
              </div>
              {can('valve.approve') && (
                <div className="flex shrink-0 gap-2">
                  <Button variant="secondary" icon={<X className="size-4" />} disabled={own || decide.isPending} onClick={() => setRejecting(r)}>
                    Reject
                  </Button>
                  <Button
                    variant={cut ? 'danger' : 'primary'}
                    icon={<Check className="size-4" />}
                    disabled={own}
                    loading={decide.isPending && decide.variables?.id === r.id && decide.variables.approve}
                    title={own ? 'A different officer must approve your request' : undefined}
                    onClick={() => decide.mutate({ id: r.id, approve: true })}
                  >
                    {cut ? 'Approve and cut' : 'Approve and restore'}
                  </Button>
                </div>
              )}
            </div>
            {own && can('valve.approve') && <p className="mt-3 text-xs text-slate-500">You made this request, so a different officer has to approve it.</p>}
          </Card>
        );
      })}

      <Modal
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title="Reject request"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button loading={decide.isPending} onClick={() => rejecting && decide.mutate({ id: rejecting.id, approve: false, note: note.trim() || undefined })}>
              Reject request
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          {rejecting?.holderName} · {rejecting?.accountNo}
        </p>
        <Textarea label="Reason for rejecting (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </Modal>
    </div>
  );
}

// -------------------------------------------------------------------- history

function HistoryTab({ requests, loading }: { requests: ValveRequest[]; loading: boolean }) {
  if (loading) return <Spinner />;
  return (
    <Card padded={false}>
      <Table
        head={['When', 'Account', 'Action', 'Reason', 'Requested / approved by', 'Status']}
        empty={requests.length === 0 && <p className="px-5 py-8 text-center text-sm text-slate-500">No requests yet.</p>}
      >
        {requests.map((r) => (
          <tr key={r.id}>
            <Td className="whitespace-nowrap">{formatDateTime(r.createdAt)}</Td>
            <Td>
              {r.accountId ? (
                <Link to={`/consumers/${r.accountId}`} className="font-medium text-slate-900 hover:underline">
                  {r.holderName}
                </Link>
              ) : (
                r.meterId
              )}
              <p className="text-xs text-slate-500">{r.accountNo}</p>
            </Td>
            <Td>{r.type === 'VALVE_CLOSE' ? 'Cut supply' : 'Restore supply'}</Td>
            <Td className="max-w-72">
              <p className="line-clamp-2">{r.reason}</p>
              {r.error && <p className="text-xs text-red-700">{r.error}</p>}
            </Td>
            <Td className="text-slate-600">
              {r.requestedByName}
              {r.approvedByName && <span className="block text-xs text-slate-500">{r.state === 'REJECTED' ? 'rejected' : 'approved'} by {r.approvedByName}</span>}
            </Td>
            <Td>
              <CommandStateBadge state={r.state} />
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
