import type { AgentMessage } from '../../modules/agent/ports.js';
import type { ConversationGateway, ConversationSnapshot } from '../../modules/conversation/ports.js';
import type { TeamInbox } from '../../modules/handoff/ports.js';
import type { ReminderSender as AppointmentReminderSender } from '../../modules/appointments/ports.js';
import type { ReminderSender } from '../../modules/trial-classes/ports.js';
import type { ChatwootClient, ChatwootMessage } from './chatwoot-client.js';

const INCOMING = 0;
const OUTGOING = 1;
const TEMPLATE = 3;
const HISTORY_LIMIT = 20;

export interface ReminderTemplate {
  name: string;
  language: string;
  /** Texto do template com {{1}}, {{2}}, {{3}}, igual ao aprovado na Meta. */
  body: string;
}

export const DEFAULT_APPOINTMENT_REMINDER_BODY =
  'Oi, {{1}}! Passando para lembrar do seu horário: {{2}} com {{3}}, {{4}}. Se precisar remarcar ou cancelar, é só responder por aqui.';

export const DEFAULT_REMINDER_BODY =
  'Olá, {{1}}! Lembrete da sua aula experimental de {{2}}: {{3}}. Se precisar remarcar, é só responder aqui.';

/** Implementa as portas de conversa, equipe e lembrete sobre a API do Chatwoot. */
export class ChatwootGateway implements ConversationGateway, TeamInbox, ReminderSender, AppointmentReminderSender {
  constructor(
    private readonly client: ChatwootClient,
    private readonly reminderTemplate: ReminderTemplate = {
      name: 'lembrete_aula_experimental',
      language: 'pt_BR',
      body: DEFAULT_REMINDER_BODY,
    },
    private readonly appointmentTemplate: ReminderTemplate = {
      name: 'lembrete_agendamento',
      language: 'pt_BR',
      body: DEFAULT_APPOINTMENT_REMINDER_BODY,
    },
  ) {}

  async sendAppointmentReminder(
    accountId: number,
    conversationId: number,
    p: { name: string; service: string; professional: string; when: string },
  ): Promise<void> {
    const params = [p.name, p.service, p.professional, p.when];
    const content = params.reduce((text, value, i) => text.replaceAll(`{{${i + 1}}}`, value), this.appointmentTemplate.body);
    await this.client.sendTemplate(accountId, conversationId, {
      name: this.appointmentTemplate.name,
      language: this.appointmentTemplate.language,
      category: 'UTILITY',
      params,
      content,
    });
  }

  async sendTrialReminder(
    accountId: number,
    conversationId: number,
    p: { name: string; modality: string; when: string },
  ): Promise<void> {
    const params = [p.name, p.modality, p.when];
    const content = params.reduce((text, value, i) => text.replaceAll(`{{${i + 1}}}`, value), this.reminderTemplate.body);
    await this.client.sendTemplate(accountId, conversationId, {
      name: this.reminderTemplate.name,
      language: this.reminderTemplate.language,
      category: 'UTILITY',
      params,
      content,
    });
  }

  async load(accountId: number, conversationId: number): Promise<ConversationSnapshot> {
    const [conversation, messages] = await Promise.all([
      this.client.getConversation(accountId, conversationId),
      this.client.listMessages(accountId, conversationId),
    ]);
    const sender = conversation.meta.sender;
    return {
      contact: { chatwootContactId: sender.id, phone: sender.phone_number ?? null, name: sender.name ?? null },
      history: toAgentHistory(messages),
      hasReplies: messages.some((m) => isReply(m)),
    };
  }

  async sendReply(accountId: number, conversationId: number, text: string): Promise<void> {
    await this.client.sendMessage(accountId, conversationId, text);
  }

  async addPrivateNote(accountId: number, conversationId: number, note: string): Promise<void> {
    await this.client.sendPrivateNote(accountId, conversationId, note);
  }

  async assignToTeam(accountId: number, conversationId: number): Promise<void> {
    await this.client.setStatus(accountId, conversationId, 'open');
  }
}

function isReply(m: ChatwootMessage): boolean {
  return (m.message_type === OUTGOING || m.message_type === TEMPLATE) && !m.private;
}

/**
 * Converte mensagens do Chatwoot no histórico do agente: só mensagens públicas
 * com texto, em ordem, começando pelo cliente e limitadas às últimas 20.
 */
export function toAgentHistory(messages: ChatwootMessage[]): AgentMessage[] {
  const relevant = [...messages]
    .sort((a, b) => a.created_at - b.created_at || a.id - b.id)
    .filter((m) => !m.private && m.content?.trim())
    .flatMap((m): AgentMessage[] => {
      if (m.message_type === INCOMING) return [{ role: 'user', content: m.content!.trim() }];
      if (isReply(m)) return [{ role: 'assistant', content: m.content!.trim() }];
      return [];
    })
    .slice(-HISTORY_LIMIT);

  const firstUser = relevant.findIndex((m) => m.role === 'user');
  return firstUser === -1 ? [] : relevant.slice(firstUser);
}
