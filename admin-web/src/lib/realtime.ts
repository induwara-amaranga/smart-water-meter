import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { getAccessToken } from '../api/client';
import { useToast } from '../components/ui';

interface ValveEvent {
  meterId: string;
  cmdId: string;
  state: string;
  valve?: string | null;
  error?: string | null;
}

/**
 * Staff sockets join the "admin" room and receive every valve command update,
 * so disconnection requests move from "Sent" to "Done" without reloading.
 */
export function useRealtime(enabled: boolean) {
  const qc = useQueryClient();
  const toast = useToast();

  useEffect(() => {
    if (!enabled) return;
    const socket = io({ auth: (cb) => cb({ token: getAccessToken() }), transports: ['websocket'] });

    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ['valve-requests'] });
      void qc.invalidateQueries({ queryKey: ['arrears'] });
      void qc.invalidateQueries({ queryKey: ['account'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    };

    socket.on('meter:valve', (e: ValveEvent) => {
      refresh();
      if (e.state === 'CONFIRMED') toast(`${e.meterId}: supply ${e.valve === 'closed' ? 'cut' : 'restored'} (confirmed by the meter)`, e.valve === 'closed' ? 'warning' : 'good');
      if (e.state === 'FAILED' || e.state === 'TIMEOUT') toast(`${e.meterId}: ${e.error ?? 'the meter did not confirm the command'}`, 'critical');
    });
    socket.on('meter:status', () => void qc.invalidateQueries({ queryKey: ['arrears'] }));
    // Access tokens are short-lived; reconnect with a fresh one after a refresh.
    socket.on('connect_error', () => setTimeout(() => socket.connect(), 5000));

    return () => {
      socket.close();
    };
  }, [enabled, qc, toast]);
}
