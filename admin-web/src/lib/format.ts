import type { Role } from '../api/types';

const money = new Intl.NumberFormat('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatMoney = (cents: number) => `Rs. ${money.format(cents / 100)}`;

export const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export const formatDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/** "2026-10" -> "October 2026" */
export const formatPeriod = (p: string) => {
  const [y, m] = p.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};

/** plural(1, 'day') -> "1 day", plural(3, 'supply', 'supplies') -> "3 supplies" */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export const daysSince =(iso: string | null | undefined) =>
  iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)) : 0;

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrator',
  BILLING_OFFICER: 'Billing officer',
  OPERATIONS: 'Operations / technician',
  CUSTOMER_SERVICE: 'Customer service',
  AUDITOR: 'Auditor (read-only)',
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  ADMIN: 'Everything, including staff accounts, tariff approval and approving disconnections.',
  BILLING_OFFICER: 'Billing cycles, payments and arrears. Can request disconnections for unpaid bills.',
  OPERATIONS: 'Meters and field work. Can request and approve disconnections and reconnections.',
  CUSTOMER_SERVICE: 'Registers consumers, handles complaints and notices.',
  AUDITOR: 'Read-only access to reports, billing and the audit log.',
};
