import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import type { Permission } from './api/types';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { ConsumerDetailPage } from './pages/ConsumerDetailPage';
import { ConsumersPage } from './pages/ConsumersPage';
import { DashboardPage } from './pages/DashboardPage';
import { DisconnectionsPage } from './pages/DisconnectionsPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterConsumerPage } from './pages/RegisterConsumerPage';
import { StaffPage } from './pages/StaffPage';

function Guard({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { can } = useAuth();
  return can(perm) ? children : <Navigate to="/" replace />;
}

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Signing in…" />;

  return (
    <BrowserRouter>
      {!user ? (
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      ) : (
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="consumers" element={<Guard perm="customers.view"><ConsumersPage /></Guard>} />
            <Route path="consumers/:id" element={<Guard perm="customers.view"><ConsumerDetailPage /></Guard>} />
            <Route path="register" element={<Guard perm="customers.manage"><RegisterConsumerPage /></Guard>} />
            <Route path="disconnections" element={<Guard perm="meters.view"><DisconnectionsPage /></Guard>} />
            <Route path="staff" element={<Guard perm="users.manage"><StaffPage /></Guard>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      )}
    </BrowserRouter>
  );
}
