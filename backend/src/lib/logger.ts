import { pino } from 'pino';

export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    transport: pretty ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
