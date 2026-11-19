export type Role = 'ADMIN' | 'BILLING_OFFICER' | 'OPERATIONS' | 'CUSTOMER_SERVICE' | 'AUDITOR';

export type Permission =
  | 'dashboard.view'
  | 'customers.view'
  | 'customers.manage'
  | 'meters.view'
  | 'meters.manage'
  | 'usage.view'
  | 'tariffs.manage'
  | 'tariffs.approve'
  | 'billing.view'
  | 'billing.run'
  | 'payments.manage'
  | 'valve.request'
  | 'valve.approve'
  | 'alerts.manage'
  | 'tickets.manage'
  | 'notices.manage'
  | 'users.manage'
  | 'audit.view';

export interface StaffUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  permissions: Permission[];
  createdAt: string;
}

export interface Overview {
  meters: { total: number; online: number; offline: number; onlinePct: number; assigned: number; closed: number };
  consumption: { todayM3: number; monthM3: number };
  alerts: { open: number; critical: number; leaks: number };
  billing: {
    lastPeriod: string | null;
    billsIssued: number;
    issuedCents: number;
    collectedThisMonthCents: number;
    overdueAccounts: number;
    overdueCents: number;
  };
  valveApprovalsPending: number;
  openTickets: number;
}

export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export interface AccountRow {
  id: string;
  accountNo: string;
  holderName: string;
  address: string;
  zoneId: number | null;
  zone: string | null;
  status: AccountStatus;
  meterId: string | null;
  online: boolean | null;
  createdAt: string;
}

export interface AccountDetail extends AccountRow {
  balance: { amountDueCents: number; creditCents: number; lastPaymentCents: number | null; lastPaymentAt: string | null; dueDate: string | null };
  members: { id: string; name: string; phone: string | null; email: string | null; role: string; label: string }[];
  bills: { id: string; period: string; status: string; totalCents: number; currentCents: number; dueDate: string | null; paidAt: string | null; dataBasis: string }[];
  payments: { id: string; amountCents: number; method: string; reference: string; status: string; paidAt: string | null }[];
}

export interface MeterRow {
  id: string;
  accountId: string | null;
  accountNo: string | null;
  holderName: string | null;
  online: boolean;
  lastSeenAt: string | null;
  valve: string;
  fw: string | null;
}

export interface Zone {
  id: number;
  name: string;
  accounts: number;
}

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  accounts: number;
}

export interface ArrearsRow {
  accountId: string;
  accountNo: string;
  holderName: string;
  address: string;
  accountStatus: AccountStatus;
  meterId: string | null;
  valve: string | null;
  meterOnline: boolean | null;
  amountDueCents: number;
  overdueBills: number;
  oldestDueDate: string | null;
  lastPaymentAt: string | null;
  pendingRequest: { id: string; type: string; state: string } | null;
}

export type CommandState = 'AWAITING_APPROVAL' | 'REJECTED' | 'SENT' | 'RECEIVED' | 'CONFIRMED' | 'FAILED' | 'TIMEOUT' | 'PENDING';

export interface ValveRequest {
  id: string;
  meterId: string;
  type: 'VALVE_OPEN' | 'VALVE_CLOSE';
  initiatedBy: { type: string; id: string | null };
  reason: string | null;
  approvedBy: string | null;
  state: CommandState;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  executedAt: string | null;
  requestedByName: string | null;
  approvedByName: string | null;
  accountId: string | null;
  accountNo: string | null;
  holderName: string | null;
}

export interface RegistrationResult {
  customer: { id: string; name: string; phone: string | null; email: string | null };
  account: AccountRow;
  meter: { meterId: string; deviceSecret?: string; claimCode?: string; qr?: string } | null;
}
