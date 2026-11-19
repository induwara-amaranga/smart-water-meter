import { startServer } from './server.js';

const server = await startServer().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  server.ctx.log.info({ signal }, 'shutting down');
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
