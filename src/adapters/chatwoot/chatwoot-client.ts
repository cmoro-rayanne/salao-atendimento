import { z } from 'zod';

const TIMEOUT_MS = 10_000;

const MessagesResponseSchema = z.object({
  payload: z.array(
    z.looseObject({
      id: z.number().int(),
      content: z.string().nullable(),
      message_type: z.number().int(), // 0 = incoming, 1 = outgoing, 2 = activity
      private: z.boolean().optional(),
      created_at: z.number(),
    }),
  ),
});

export type ChatwootMessage = z.infer<typeof MessagesResponseSchema>['payload'][number];

const ConversationResponseSchema = z.looseObject({
  id: z.number().int(),
  meta: z.looseObject({
    sender: z.looseObject({
      id: z.number().int(),
      name: z.string().nullable().optional(),
      phone_number: z.string().nullable().optional(),
    }),
  }),
});

export type ChatwootConversation = z.infer<typeof ConversationResponseSchema>;

export class ChatwootError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ChatwootError';
  }
}

/** Cliente HTTP mínimo da API do Chatwoot, autenticado como Agent Bot. */
export class ChatwootClient {
  constructor(
    private readonly baseUrl: string,
    private readonly botToken: string,
  ) {}

  sendMessage(accountId: number, conversationId: number, content: string): Promise<unknown> {
    return this.request('POST', `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
      content,
      message_type: 'outgoing',
    });
  }

  sendPrivateNote(accountId: number, conversationId: number, content: string): Promise<unknown> {
    return this.request('POST', `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
      content,
      message_type: 'outgoing',
      private: true,
    });
  }

  /**
   * Mensagem de template do WhatsApp (obrigatória fora da janela de 24 h).
   * `content` é o texto já preenchido, para aparecer legível no Chatwoot.
   */
  sendTemplate(
    accountId: number,
    conversationId: number,
    template: { name: string; language: string; category: string; params: string[]; content: string },
  ): Promise<unknown> {
    return this.request('POST', `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`, {
      content: template.content,
      message_type: 'outgoing',
      template_params: {
        name: template.name,
        category: template.category,
        language: template.language,
        processed_params: Object.fromEntries(template.params.map((p, i) => [String(i + 1), p])),
      },
    });
  }

  /** `open` passa a conversa para a equipe; o bot só atende conversas `pending`. */
  setStatus(accountId: number, conversationId: number, status: 'open' | 'pending' | 'resolved'): Promise<unknown> {
    return this.request('POST', `/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`, {
      status,
    });
  }

  async getConversation(accountId: number, conversationId: number): Promise<ChatwootConversation> {
    const body = await this.request('GET', `/api/v1/accounts/${accountId}/conversations/${conversationId}`);
    return ConversationResponseSchema.parse(body);
  }

  async listMessages(accountId: number, conversationId: number): Promise<ChatwootMessage[]> {
    const body = await this.request('GET', `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`);
    return MessagesResponseSchema.parse(body).payload;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json', api_access_token: this.botToken },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(new URL(path, this.baseUrl), init);
    if (!res.ok) {
      throw new ChatwootError(`Chatwoot ${method} ${path} respondeu ${res.status}`, res.status);
    }
    return res.status === 204 ? undefined : res.json();
  }
}
