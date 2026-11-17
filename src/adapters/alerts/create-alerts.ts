import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';
import { noopAlerts, type AlertNotifier } from '../../modules/alerts/ports.js';
import { WebhookAlertNotifier } from './webhook-alert.js';

export function createAlerts(env: Env, redis: Redis, log: Pick<Logger, 'warn' | 'error'>): AlertNotifier {
  return env.ALERT_WEBHOOK_URL
    ? new WebhookAlertNotifier(env.ALERT_WEBHOOK_URL, env.ALERT_WEBHOOK_FORMAT, redis, log)
    : noopAlerts;
}
