import { EventEmitter } from 'node:events';

/** Events published inside the backend and forwarded to Socket.IO clients. */
export interface BusEvents {
  'meter:live': { meterId: string; flowLpm: number; totalL: number; ts: number };
  'meter:status': { meterId: string; online: boolean; lastSeenAt: string; rssi?: number | null };
  'meter:valve': {
    meterId: string;
    cmdId: string;
    state: string;
    valve?: string | null;
    error?: string | null;
  };
  'alert:new': { accountId: string | null; meterId: string | null; alertId: string; type: string; severity: string; title: string };
  'bill:published': { accountId: string; billId: string; period: string };
}

export class EventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(100);

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof BusEvents>(event: K, listener: (payload: BusEvents[K]) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }
}
