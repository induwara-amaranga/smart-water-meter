import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { AppContext } from '../context.js';
import { adminRouter } from './admin.js';
import { customerRouter } from './customer.js';
import { errorHandler } from './middleware.js';

export function corsOrigins(ctx: AppContext): string[] | true {
  const list = ctx.config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  // In development allow any origin (Flutter web picks a random port).
  return ctx.config.NODE_ENV === 'production' ? list : true;
}

export function createApp(ctx: AppContext) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: corsOrigins(ctx), credentials: true }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', async (_req, res) => {
    let db = false;
    try {
      await ctx.db.one('select 1');
      db = true;
    } catch {
      /* reported below */
    }
    res.status(db && ctx.mqtt.connected ? 200 : 503).json({ status: db && ctx.mqtt.connected ? 'ok' : 'degraded', db, mqtt: ctx.mqtt.connected, time: ctx.now() });
  });

  // Admin first: the customer router requires a customer token for everything after its public routes.
  app.use('/api/v1/admin', adminRouter(ctx));
  app.use('/api/v1', customerRouter(ctx));
  app.use((_req, res) => {
    res.status(404).json({ message: 'Not found' });
  });
  app.use(errorHandler(ctx));
  return app;
}
