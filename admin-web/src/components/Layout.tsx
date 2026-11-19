import { useQuery } from '@tanstack/react-query';
import { Droplet, LayoutDashboard, LogOut, Menu, PowerOff, UserPlus, Users, UsersRound, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { api } from '../api/client';
import type { Permission, ValveRequest } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ROLE_LABEL } from '../lib/format';
import { useRealtime } from '../lib/realtime';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  perm: Permission;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: <LayoutDashboard className="size-4" />, perm: 'dashboard.view' },
  { to: '/consumers', label: 'Consumers', icon: <UsersRound className="size-4" />, perm: 'customers.view' },
  { to: '/register', label: 'Register consumer', icon: <UserPlus className="size-4" />, perm: 'customers.manage' },
  { to: '/disconnections', label: 'Disconnections', icon: <PowerOff className="size-4" />, perm: 'meters.view' },
  { to: '/staff', label: 'Staff', icon: <Users className="size-4" />, perm: 'users.manage' },
];

export function Layout() {
  const { user, logout, can } = useAuth();
  const [open, setOpen] = useState(false);
  useRealtime(!!user);

  const pending = useQuery({
    queryKey: ['valve-requests', 'AWAITING_APPROVAL'],
    queryFn: () => api<ValveRequest[]>('/valve-requests?state=AWAITING_APPROVAL'),
    enabled: can('meters.view'),
    refetchInterval: 30_000,
  });

  const nav = (
    <nav className="space-y-1">
      {NAV.filter((n) => can(n.perm)).map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === '/'}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-100'}`
          }
        >
          {n.icon}
          <span className="flex-1">{n.label}</span>
          {n.to === '/disconnections' && (pending.data?.length ?? 0) > 0 && (
            <span className="rounded-full bg-amber-100 px-2 text-xs font-semibold text-amber-900" title="Requests awaiting approval">
              {pending.data!.length}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center gap-2 px-2">
        <Droplet className="size-6 fill-blue-600 text-blue-600" />
        <div>
          <p className="text-sm font-semibold leading-tight text-slate-900">Water Board</p>
          <p className="text-xs text-slate-500">Smart meter portal</p>
        </div>
      </div>
      {nav}
      <div className="mt-auto border-t border-slate-200 pt-4">
        <p className="px-2 text-sm font-medium text-slate-900">{user?.name}</p>
        <p className="px-2 text-xs text-slate-500">{user ? ROLE_LABEL[user.role] : ''}</p>
        <button onClick={() => void logout()} className="mt-3 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-100">
          <LogOut className="size-4" /> Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-slate-200 bg-white lg:block">{sidebar}</aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">
            <button className="absolute right-3 top-3 rounded-md p-1 text-slate-500" onClick={() => setOpen(false)} aria-label="Close menu">
              <X className="size-5" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <button onClick={() => setOpen(true)} className="rounded-md p-1 text-slate-700" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <Droplet className="size-5 fill-blue-600 text-blue-600" />
          <span className="text-sm font-semibold">Water Board</span>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
