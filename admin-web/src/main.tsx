import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import { ToastProvider } from './components/ui';
import './index.css';

/** Every REST-backed metric re-polls this often; socket-driven updates arrive on their own. */
const METRICS_REFRESH_MS = 5_000;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 0, refetchInterval: METRICS_REFRESH_MS, refetchIntervalInBackground: false, retry: (count, err: any) => count < 2 && (err?.status ?? 500) >= 500, refetchOnWindowFocus: true },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
