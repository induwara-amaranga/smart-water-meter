import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, Power, PowerOff } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api/client';
import type { AccountDetail, MeterRow, ValveRequest } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AccountStatusBadge, CommandStateBadge, SupplyBadge } from '../components/status';
import { ValveRequestModal } from '../components/ValveRequestModal';
import { Badge, Button, Card, ErrorNote, Input, Modal, PageHeader, Select, Spinner, Td, Table, useToast } from '../components/ui';
import { formatDate, formatDateTime, formatMoney, formatPeriod, timeAgo } from '../lib/format';

const billTone = (s: string) => (s === 'PAID' ? 'good' : s === 'OVERDUE' ? 'critical' : s === 'DRAFT' ? 'neutral' : 'warning');
const billLabel: Record<string, string> = { PAID: 'Paid', OVERDUE: 'Overdue', PUBLISHED: 'Unpaid', DRAFT: 'Draft' };

export function ConsumerDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const [valveAction, setValveAction] = useState<'CLOSE' | 'OPEN' | null>(null);
  const [paying, setPaying] = useState(false);

  const account = useQuery({ queryKey: ['account', id], queryFn: () => api<AccountDetail>(`/accounts/${id}`) });
  const meterId = account.data?.meterId;
  const meter = useQuery({ queryKey: ['meter', meterId], queryFn: () => api<MeterRow & { commands: ValveRequest[] }>(`/meters/${meterId}`), enabled: !!meterId });

  if (account.isLoading) return <Spinner />;
  if (account.error) return <ErrorNote error={account.error} />;
  const a = account.data!;
  const m = meter.data;
  const pending = m?.commands.find((c) => c.initiatedBy.type === 'STAFF' && ['AWAITING_APPROVAL', 'SENT', 'RECEIVED'].includes(c.state));
  const owner = a.members.find((x) => x.role === 'OWNER') ?? a.members[0];

  return (
    <>
      <Link to="/consumers" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft className="size-4" /> Consumers
      </Link>
      <PageHeader
        title={a.holderName}
        description={`Account ${a.accountNo}${a.zone ? ` · ${a.zone}` : ''} · ${a.address || 'no address'}`}
        actions={
          <>
            {can('payments.manage') && (
              <Button variant="secondary" icon={<Banknote className="size-4" />} onClick={() => setPaying(true)}>
                Record payment
              </Button>
            )}
            {can('valve.request') && m && !pending && m.valve !== 'closed' && (
              <Button variant="danger" icon={<PowerOff className="size-4" />} onClick={() => setValveAction('CLOSE')}>
                Cut supply
              </Button>
            )}
            {can('valve.request') && m && !pending && m.valve === 'closed' && (
              <Button icon={<Power className="size-4" />} onClick={() => setValveAction('OPEN')}>
                Restore supply
              </Button>
            )}
          </>
        }
      />

      {pending && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <CommandStateBadge state={pending.state} />
          <span>
            {pending.type === 'VALVE_CLOSE' ? 'Disconnection' : 'Reconnection'} requested {timeAgo(pending.createdAt)}: {pending.reason}
          </span>
          <Link to="/disconnections?tab=approvals" className="ml-auto font-medium underline">
            View request
          </Link>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Balance">
          <p className="text-3xl font-semibold tabular-nums">{formatMoney(a.balance.amountDueCents)}</p>
          <p className="mt-1 text-sm text-slate-500">{a.balance.amountDueCents > 0 ? `Oldest unpaid bill due ${formatDate(a.balance.dueDate)}` : 'Nothing due'}</p>
          {a.balance.creditCents > 0 && <p className="mt-1 text-sm text-slate-600">Credit {formatMoney(a.balance.creditCents)}</p>}
          <dl className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Last payment</dt>
              <dd>{a.balance.lastPaymentCents ? `${formatMoney(a.balance.lastPaymentCents)} · ${formatDate(a.balance.lastPaymentAt)}` : '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Account</dt>
              <dd>
                <AccountStatusBadge status={a.status} />
              </dd>
            </div>
          </dl>
        </Card>

        <Card title="Meter and supply">
          {!a.meterId ? (
            <p className="text-sm text-slate-500">No meter assigned yet.</p>
          ) : !m ? (
            <Spinner />
          ) : (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Meter</dt>
                <dd className="font-mono text-xs">{m.id}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">Supply</dt>
                <dd>
                  <SupplyBadge valve={m.valve} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-slate-500">Connection</dt>
                <dd>{m.online ? <Badge tone="good">Online</Badge> : <Badge tone="neutral">Offline · {timeAgo(m.lastSeenAt)}</Badge>}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Firmware</dt>
                <dd>{m.fw ?? '—'}</dd>
              </div>
            </dl>
          )}
        </Card>

        <Card title="Consumer">
          {owner ? (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Name</dt>
                <dd className="text-right">{owner.name}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Mobile</dt>
                <dd>{owner.phone ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Email</dt>
                <dd className="truncate">{owner.email ?? '—'}</dd>
              </div>
              {a.members.length > 1 && <p className="pt-1 text-xs text-slate-500">+ {a.members.length - 1} family member(s) with app access</p>}
            </dl>
          ) : (
            <p className="text-sm text-slate-500">Nobody is linked in the app yet. They can claim the meter with its claim code.</p>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card title="Bills" padded={false}>
          <Table head={['Month', 'Amount', 'Due', 'Status']} empty={a.bills.length === 0 && <p className="px-5 py-8 text-center text-sm text-slate-500">No bills yet.</p>}>
            {a.bills.map((b) => (
              <tr key={b.id}>
                <Td className="text-slate-900">{formatPeriod(b.period)}</Td>
                <Td className="tabular-nums">{formatMoney(b.totalCents)}</Td>
                <Td>{formatDate(b.dueDate)}</Td>
                <Td>
                  <Badge tone={billTone(b.status)}>{billLabel[b.status] ?? b.status}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Payments" padded={false}>
          <Table head={['Date', 'Amount', 'Method', 'Reference']} empty={a.payments.length === 0 && <p className="px-5 py-8 text-center text-sm text-slate-500">No payments yet.</p>}>
            {a.payments.map((p) => (
              <tr key={p.id}>
                <Td>{formatDateTime(p.paidAt)}</Td>
                <Td className="tabular-nums">{formatMoney(p.amountCents)}</Td>
                <Td>{p.method}</Td>
                <Td className="font-mono text-xs">{p.reference}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <ValveRequestModal
        action={valveAction ?? 'CLOSE'}
        target={valveAction && m ? { meterId: m.id, accountNo: a.accountNo, holderName: a.holderName, amountDueCents: a.balance.amountDueCents, overdueBills: a.bills.filter((b) => b.status === 'OVERDUE').length } : null}
        onClose={() => setValveAction(null)}
      />
      <PaymentModal open={paying} accountId={a.id} suggestedCents={a.balance.amountDueCents} onClose={() => setPaying(false)} />
    </>
  );
}

function PaymentModal({ open, accountId, suggestedCents, onClose }: { open: boolean; accountId: string; suggestedCents: number; onClose(): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const cents = Math.round(Number(amount.replace(/,/g, '')) * 100);

  const save = useMutation({
    mutationFn: () => api('/accounts/' + accountId + '/payments', { method: 'POST', body: { amountCents: cents, method, reference: reference.trim() || undefined } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['account', accountId] });
      void qc.invalidateQueries({ queryKey: ['arrears'] });
      toast('Payment recorded');
      setAmount('');
      setReference('');
      onClose();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record counter payment"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!(cents > 0)} onClick={() => save.mutate()}>
            Record payment
          </Button>
        </>
      }
    >
      <Input
        label="Amount (Rs.)"
        inputMode="decimal"
        placeholder={(suggestedCents / 100).toFixed(2)}
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))}
        hint={suggestedCents > 0 ? `Balance due: ${formatMoney(suggestedCents)}` : undefined}
      />
      <Select label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
        <option value="CASH">Cash</option>
        <option value="CARD">Card</option>
        <option value="BANK">Bank deposit</option>
        <option value="CHEQUE">Cheque</option>
      </Select>
      <Input label="Receipt / reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} hint="Leave empty to generate one." />
      <ErrorNote error={save.error} />
    </Modal>
  );
}
