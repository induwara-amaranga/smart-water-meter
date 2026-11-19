import type { AccountStatus, CommandState } from '../api/types';
import { Badge } from './ui';

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  if (status === 'ACTIVE') return <Badge tone="good">Active</Badge>;
  if (status === 'SUSPENDED') return <Badge tone="critical">Disconnected</Badge>;
  return <Badge tone="neutral">Closed</Badge>;
}

export function SupplyBadge({ valve, online }: { valve: string | null; online?: boolean | null }) {
  if (!valve) return <Badge tone="neutral">No meter</Badge>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {valve === 'open' ? <Badge tone="good">Supply on</Badge> : valve === 'closed' ? <Badge tone="critical">Supply cut</Badge> : <Badge tone="neutral">Unknown</Badge>}
      {online === false && <Badge tone="neutral">Meter offline</Badge>}
    </span>
  );
}

export function CommandStateBadge({ state }: { state: CommandState }) {
  switch (state) {
    case 'AWAITING_APPROVAL':
      return <Badge tone="warning">Awaiting approval</Badge>;
    case 'SENT':
    case 'RECEIVED':
    case 'PENDING':
      return <Badge tone="progress">{state === 'RECEIVED' ? 'Meter acting…' : 'Sent to meter'}</Badge>;
    case 'CONFIRMED':
      return <Badge tone="good">Done</Badge>;
    case 'REJECTED':
      return <Badge tone="neutral">Rejected</Badge>;
    case 'TIMEOUT':
      return <Badge tone="critical">No response</Badge>;
    default:
      return <Badge tone="critical">Failed</Badge>;
  }
}
