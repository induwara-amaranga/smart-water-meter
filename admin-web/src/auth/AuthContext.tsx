import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, hasStoredSession, refreshSession, setSignedOutHandler, signIn, signOut } from '../api/client';
import type { Permission, StaffUser } from '../api/types';

interface AuthState {
  user: StaffUser | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  can(p: Permission): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StaffUser | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    setSignedOutHandler(() => {
      setUser(null);
      qc.clear();
    });
    // Restore a session after a page reload.
    (async () => {
      if (hasStoredSession() && (await refreshSession())) {
        try {
          setUser(await api<StaffUser>('/me'));
        } catch {
          /* signed out below */
        }
      }
      setLoading(false);
    })();
  }, [qc]);

  const login = useCallback(async (email: string, password: string) => {
    await signIn(email, password);
    setUser(await api<StaffUser>('/me'));
  }, []);

  const logout = useCallback(async () => {
    await signOut();
    setUser(null);
    qc.clear();
  }, [qc]);

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, logout, can: (p) => !!user?.permissions.includes(p) }),
    [user, loading, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
