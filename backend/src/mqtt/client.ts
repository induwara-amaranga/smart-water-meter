import { randomBytes } from 'node:crypto';
import mqtt, { type MqttClient } from 'mqtt';
import type { Publisher } from '../context.js';
import { HttpError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { TOPIC_PREFIX } from './contract.js';

/** The backend's own MQTT connection: receives meter messages and publishes commands/config. */
export class MqttService implements Publisher {
  private client: MqttClient | null = null;

  constructor(private readonly log: Logger) {}

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  async connect(url: string, username: string, password: string, onMessage: (topic: string, payload: Buffer) => void) {
    const client = await mqtt.connectAsync(url, {
      username,
      password,
      clientId: `swm-backend-${randomBytes(4).toString('hex')}`,
      clean: true,
      reconnectPeriod: 2000,
    });
    client.on('message', (topic, payload) => onMessage(topic, payload));
    client.on('reconnect', () => this.log.warn('mqtt: backend reconnecting to broker'));
    client.on('error', (err) => this.log.error({ err: err.message }, 'mqtt: backend client error'));
    await client.subscribeAsync(`${TOPIC_PREFIX}/+/up/#`, { qos: 1 });
    this.client = client;
    this.log.info({ url }, 'mqtt: backend connected and subscribed');
  }

  async publish(topic: string, payload: unknown, opts: { qos?: 0 | 1; retain?: boolean } = {}): Promise<void> {
    if (!this.client?.connected) throw new HttpError(503, 'Messaging service is not connected. Try again shortly.');
    await this.client.publishAsync(topic, JSON.stringify(payload), { qos: opts.qos ?? 1, retain: opts.retain ?? false });
  }

  async close(): Promise<void> {
    await this.client?.endAsync();
    this.client = null;
  }
}
