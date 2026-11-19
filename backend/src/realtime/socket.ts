import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { AppContext } from '../context.js';
import { assertMeterAccess, customerAccounts } from '../services/accounts.js';
import { type AccessClaims, verifyAccess } from '../services/auth.js';

/**
 * Socket.IO gateway. Clients authenticate with their access token
 * (`io(url, { auth: { token } })`). Rooms:
 *   meter:{id}    live flow, valve lifecycle, status (customer must own the meter)
 *   account:{id}  new alerts and bills for that account (joined automatically)
 *   admin         fleet status and alerts for staff
 */
export function attachRealtime(ctx: AppContext, http: HttpServer, corsOrigins: string[] | true): Server {
  const io = new Server(http, { cors: { origin: corsOrigins, credentials: true } });

  io.use((socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: string })?.token ?? '';
      socket.data.auth = verifyAccess(ctx, token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const auth = socket.data.auth as AccessClaims;
    if (auth.typ === 'staff') {
      await socket.join('admin');
    } else {
      const accounts = await customerAccounts(ctx.db, auth.sub);
      await socket.join(accounts.map((a) => `account:${a.id}`));
    }

    socket.on('subscribe', async (msg: { meterId?: string }) => {
      const meterId = String(msg?.meterId ?? '');
      try {
        if (auth.typ !== 'staff') await assertMeterAccess(ctx.db, auth.sub, meterId);
        await socket.join(`meter:${meterId}`);
      } catch {
        socket.emit('error:subscribe', { meterId, message: 'Not allowed' });
      }
    });
    socket.on('unsubscribe', (msg: { meterId?: string }) => {
      void socket.leave(`meter:${String(msg?.meterId ?? '')}`);
    });
  });

  ctx.bus.on('meter:live', (p) => io.to(`meter:${p.meterId}`).emit('meter:live', p));
  ctx.bus.on('meter:valve', (p) => io.to(`meter:${p.meterId}`).to('admin').emit('meter:valve', p));
  ctx.bus.on('meter:status', (p) => io.to(`meter:${p.meterId}`).to('admin').emit('meter:status', p));
  ctx.bus.on('alert:new', (p) => {
    const target = p.accountId ? io.to(`account:${p.accountId}`).to('admin') : io.to('admin');
    if (p.type === 'NOTICE') {
      if (p.accountId) io.to(`account:${p.accountId}`).emit('alert:new', p);
      return;
    }
    target.emit('alert:new', p);
  });
  ctx.bus.on('bill:published', (p) => io.to(`account:${p.accountId}`).emit('bill:published', p));

  return io;
}
