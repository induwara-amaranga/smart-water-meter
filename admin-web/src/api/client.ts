/**
 * Calls the backend's /api/v1/admin routes. The access token is kept in memory
 * only; the refresh token is kept in sessionStorage so a page reload in the same
 * tab stays signed in, and is rotated on every refresh.
 */
const BASE = '/api/v1/admin';
const REFRESH_KEY = 'swm_admin_refresh';

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSignedOut: () => void = () => {};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const setSignedOutHandler = (fn: () => void) => {
  onSignedOut = fn;
};
export const getAccessToken = () => accessToken;
export const hasStoredSession = () => !!safeStorage.get();

const safeStorage = {
  get: () => {
    try {
      return sessionStorage.getItem(REFRESH_KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) sessionStorage.setItem(REFRESH_KEY, v);
      else sessionStorage.removeItem(REFRESH_KEY);
    } catch {
      /* storage unavailable: session lasts until reload */
    }
  },
};

function saveTokens(t: { accessToken: string; refreshToken: string }) {
  accessToken = t.accessToken;
  safeStorage.set(t.refreshToken);
}

/** Exchange the refresh token for a new pair. Concurrent callers share one request. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    const token = safeStorage.get();
    if (!token) return false;
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!res.ok) throw new Error();
      saveTokens(await res.json());
      return true;
    } catch {
      accessToken = null;
      safeStorage.set(null);
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const send = () =>
    fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && !path.startsWith('/auth/') && (await refreshSession())) res = await send();
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check that the backend is running.');
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    if (res.status === 401 && !path.startsWith('/auth/')) onSignedOut();
    throw new ApiError(res.status, body.message ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function signIn(email: string, password: string) {
  const res = await api<{ accessToken: string; refreshToken: string }>('/auth/login', { method: 'POST', body: { email, password } });
  saveTokens(res);
}

export async function signOut() {
  const token = safeStorage.get();
  accessToken = null;
  safeStorage.set(null);
  if (token) await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: token }) }).catch(() => {});
}
