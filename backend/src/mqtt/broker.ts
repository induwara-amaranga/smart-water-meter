import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { Aedes, type Client } from 'aedes';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { safeEqual, verifySecret } from '../lib/crypto.js';
import type { Logger } from '../lib/logger.js';
import { METER_ID_RE, TOPIC_PREFIX } from './contract.js';

type Identity = { role: 'service' } | { role: 'meter'; meterId: string };

/** MQTT CONNACK return codes (v3.1.1). */
const BAD_CREDENTIALS = 4;
const NOT_AUTHORIZED = 5;

const authError = (code: number, msg: string) => Object.assign(new Error(msg), { returnCode: code });

export interface RunningBroker {
  port: number;
  tlsPort: number | null;
  close(): Promise<void>;
}

/**
 * Embedded MQTT broker (Aedes) with per-device authentication and topic ACLs:
 * - meters log in with username = meter ID, password = device secret, and
 *   client ID "meter-{meterId}";
 * - a meter may publish only to swm/v1/meters/{own}/up/... and subscribe only
 *   to swm/v1/meters/{own}/down/...;
 * - the backend's service account has full access.
 *
 * To use EMQX or Mosquitto instead, set EMBEDDED_BROKER=false and configure the
 * same rules there (see README).
 */
export async function startBroker(config: Config, db: Db, log: Logger, port = config.MQTT_PORT): Promise<RunningBroker> {
  const identities = new WeakMap<Client, Identity>();

  const broker = await Aedes.createBroker({
    authenticate: (client, username, password, done) => {
      const pass = password?.toString() ?? '';
      if (!username) return done(authError(BAD_CREDENTIALS, 'Username required'), false);

      if (username === config.MQTT_SERVICE_USER) {
        if (safeEqual(pass, config.MQTT_SERVICE_PASSWORD)) {
          identities.set(client, { role: 'service' });
          return done(null, true);
        }
        log.warn({ clientId: client.id }, 'mqtt: bad service password');
        return done(authError(BAD_CREDENTIALS, 'Bad credentials'), false);
      }

      if (!METER_ID_RE.test(username) || client.id !== `meter-${username}`) {
        log.warn({ clientId: client.id, username }, 'mqtt: rejected client id');
        return done(authError(NOT_AUTHORIZED, 'Client ID must be meter-{meterId}'), false);
      }
      db.one<{ device_secret_hash: string }>(`select device_secret_hash from meters where id = $1`, [username])
        .then(async (row) => {
          if (row && (await verifySecret(pass, row.device_secret_hash))) {
            identities.set(client, { role: 'meter', meterId: username });
            done(null, true);
          } else {
            log.warn({ meterId: username }, 'mqtt: meter authentication failed');
            done(authError(BAD_CREDENTIALS, 'Bad credentials'), false);
          }
        })
        .catch((err) => {
          log.error({ err }, 'mqtt: auth lookup failed');
          done(authError(NOT_AUTHORIZED, 'Server error'), false);
        });
    },

    authorizePublish: (client, packet, cb) => {
      if (!client) return cb(null); // broker-internal messages
      const id = identities.get(client);
      if (id?.role === 'service') return cb(null);
      if (id?.role === 'meter' && packet.topic.startsWith(`${TOPIC_PREFIX}/${id.meterId}/up/`)) {
        // Only the online/offline status may be retained.
        if (packet.retain && !packet.topic.endsWith('/up/status')) packet.retain = false;
        return cb(null);
      }
      log.warn({ clientId: client.id, topic: packet.topic }, 'mqtt: publish denied');
      cb(new Error('Not authorized'));
    },

    authorizeSubscribe: (client, sub, cb) => {
      const id = identities.get(client);
      if (id?.role === 'service') return cb(null, sub);
      if (id?.role === 'meter' && sub.topic.startsWith(`${TOPIC_PREFIX}/${id.meterId}/down/`)) return cb(null, sub);
      log.warn({ clientId: client.id, topic: sub.topic }, 'mqtt: subscribe denied');
      // null = refuse this topic (SUBACK 128) but keep the connection.
      cb(null, null);
    },
  });

  broker.on('clientError', (client, err) => log.debug({ clientId: client.id, err: err.message }, 'mqtt: client error'));

  const servers: net.Server[] = [];
  const listen = (server: net.Server, p: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, () => resolve((server.address() as net.AddressInfo).port));
    });

  const plain = net.createServer(broker.handle as unknown as (s: net.Socket) => void);
  servers.push(plain);
  const actualPort = await listen(plain, port);
  log.info({ port: actualPort }, 'mqtt: broker listening');

  let tlsPort: number | null = null;
  if (config.MQTT_TLS_KEY && config.MQTT_TLS_CERT) {
    const secure = tls.createServer(
      { key: readFileSync(config.MQTT_TLS_KEY), cert: readFileSync(config.MQTT_TLS_CERT) },
      broker.handle as unknown as (s: tls.TLSSocket) => void,
    );
    servers.push(secure);
    tlsPort = await listen(secure, config.MQTT_TLS_PORT);
    log.info({ port: tlsPort }, 'mqtt: TLS listener ready');
  }

  return {
    port: actualPort,
    tlsPort,
    close: async () => {
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await new Promise<void>((r) => broker.close(() => r()));
    },
  };
}
