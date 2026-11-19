import { useQuery } from '@tanstack/react-query';
import { Search, UserPlus, UsersRound } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import type { AccountRow } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AccountStatusBadge } from '../components/status';
import { Badge, Button, Card, EmptyState, ErrorNote, Input, PageHeader, Select, Spinner, Td, Table } from '../components/ui';
import { formatDate } from '../lib/format';

export function ConsumersPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const query = useDeferredValue(q);

  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (status) params.set('status', status);
  const accounts = useQuery({ queryKey: ['accounts', query, status], queryFn: () => api<AccountRow[]>(`/accounts?${params}`) });

  return (
    <>
      <PageHeader
        title="Consumers"
        description="Service accounts and their meters. Open an account to see bills and payments, record a counter payment or cut the supply."
        actions={
          can('customers.manage') && (
            <Link to="/register">
              <Button icon={<UserPlus className="size-4" />}>Register consumer</Button>
            </Link>
          )
        }
      />
      <Card padded={false}>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
          <div className="relative min-w-60 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input aria-label="Search" placeholder="Search by name, account number or meter ID" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Disconnected</option>
            <option value="CLOSED">Closed</option>
          </Select>
        </div>
        {accounts.isLoading ? (
          <Spinner />
        ) : accounts.error ? (
          <div className="p-4">
            <ErrorNote error={accounts.error} />
          </div>
        ) : (
          <Table
            head={['Account', 'Name', 'Address', 'Zone', 'Meter', 'Status', 'Since']}
            empty={
              accounts.data!.length === 0 && (
                <EmptyState icon={<UsersRound className="size-10" />} title="No consumers found" message={q ? 'Try a different search.' : 'Register the first consumer to get started.'} />
              )
            }
          >
            {accounts.data!.map((a) => (
              <tr key={a.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/consumers/${a.id}`)}>
                <Td className="font-medium text-slate-900">
                  <Link to={`/consumers/${a.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                    {a.accountNo}
                  </Link>
                </Td>
                <Td className="text-slate-900">{a.holderName}</Td>
                <Td className="max-w-64 truncate">{a.address || '—'}</Td>
                <Td>{a.zone ?? '—'}</Td>
                <Td>
                  {a.meterId ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="font-mono text-xs">{a.meterId}</span>
                      {a.online === false && <Badge tone="neutral">Offline</Badge>}
                    </span>
                  ) : (
                    <Badge tone="warning">No meter</Badge>
                  )}
                </Td>
                <Td>
                  <AccountStatusBadge status={a.status} />
                </Td>
                <Td className="whitespace-nowrap text-slate-500">{formatDate(a.createdAt)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
