import type { MessageCreated } from '../../adapters/chatwoot/webhook-schema.js';
import type { AlertNotifier } from '../alerts/ports.js';
import type { ConversationQueue, ConversationRateLimiter, ProcessedEventStore } from './ports.js';

export type IncomingEventResult =
  | { kind: 'ignored'; reason: 'not_incoming' | 'private_note' | 'with_human' | 'resolved' }
  | { kind: 'duplicate' }
  | { kind: 'rate_limited' }
  | { kind: 'scheduled'; conversationId: number };

export interface HandleIncomingEventDeps {
  events: ProcessedEventStore;
  queue: ConversationQueue;
  debounceMs: number;
  /** Opcional: sem ele, não há limite por conversa. */
  rateLimiter?: ConversationRateLimiter | undefined;
  alerts?: AlertNotifier | undefined;
}

/**
 * Decide o que fazer com uma mensagem recebida do Chatwoot.
 * Só conversas `pending` (com o bot) geram resposta; `open` está com a equipe.
 */
export async function handleIncomingEvent(
  event: MessageCreated,
  deps: HandleIncomingEventDeps,
): Promise<IncomingEventResult> {
  if (event.message_type !== 'incoming') return { kind: 'ignored', reason: 'not_incoming' };
  if (event.private) return { kind: 'ignored', reason: 'private_note' };
  if (event.conversation.status === 'open') return { kind: 'ignored', reason: 'with_human' };
  if (event.conversation.status !== 'pending') return { kind: 'ignored', reason: 'resolved' };

  const isNew = await deps.events.markIfNew(`chatwoot:message:${event.id}`);
  if (!isNew) return { kind: 'duplicate' };

  if (deps.rateLimiter) {
    const limit = await deps.rateLimiter.hit(event.conversation.id);
    if (!limit.allowed) {
      if (limit.firstExceeded) {
        await deps.alerts?.notify({
          key: `rate-limit:${event.conversation.id}`,
          text: `A conversa ${event.conversation.id} passou do limite de mensagens; a IA parou de responder nela. Veja no Chatwoot se é spam.`,
        });
      }
      return { kind: 'rate_limited' };
    }
  }

  await deps.queue.scheduleReply(
    { accountId: event.account.id, conversationId: event.conversation.id },
    deps.debounceMs,
  );
  return { kind: 'scheduled', conversationId: event.conversation.id };
}
