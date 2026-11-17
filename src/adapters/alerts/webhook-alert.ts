import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Alert, AlertNotifier } from '../../modules/alerts/ports.js';

export type AlertFormat = 'text' | 'json';

/**
 * Alertas por webhook. `text`: corpo em texto puro (ex.: https://ntfy.sh/<tópico>, que vira
 * notificação no celular). `json`: `{"text": …}` (Slack, Discord, Google Chat).
 * O mesmo alerta não se repete por `throttleSec`; falhas viram log, nunca exceção.
 */
export class WebhookAlertNotifier implements AlertNotifier {
  constructor(
    private readonly url: string,
    private readonly format: AlertFormat,
    private readonly redis: Redis,
    private readonly log: Pick<Logger, 'warn' | 'error'>,
    private readonly prefix = '[Atendimento IA]',
    private readonly throttleSec = 600,
  ) {}

  async notify(alert: Alert): Promise<void> {
    try {
      const fresh = await this.redis.set(`alert:${alert.key}`, '1', 'EX', this.throttleSec, 'NX');
      if (fresh !== 'OK') return;

      const text = `${this.prefix} ${alert.text}`;
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': this.format === 'json' ? 'application/json' : 'text/plain; charset=utf-8' },
        body: this.format === 'json' ? JSON.stringify({ text }) : text,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) this.log.warn({ status: res.status, key: alert.key }, 'webhook de alerta recusou');
    } catch (err) {
      this.log.error({ err, key: alert.key }, 'falha ao enviar alerta');
    }
  }
}
