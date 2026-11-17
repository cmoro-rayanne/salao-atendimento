import { z } from 'zod';

/**
 * Payload do evento `message_created` enviado pelo Agent Bot do Chatwoot.
 * Validamos só o que usamos; o resto passa adiante sem quebrar se o Chatwoot
 * adicionar campos novos.
 */
export const MessageCreatedSchema = z.looseObject({
  event: z.literal('message_created'),
  id: z.number().int(),
  content: z.string().nullable().optional(),
  message_type: z.enum(['incoming', 'outgoing', 'activity', 'template']),
  private: z.boolean().optional(),
  account: z.looseObject({ id: z.number().int() }),
  conversation: z.looseObject({
    id: z.number().int(),
    status: z.enum(['open', 'pending', 'resolved', 'snoozed']),
  }),
  sender: z
    .looseObject({
      id: z.number().int(),
      phone_number: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
    })
    .optional(),
});

export type MessageCreated = z.infer<typeof MessageCreatedSchema>;

/** Qualquer evento: usamos para descartar rápido o que não é `message_created`. */
export const AnyEventSchema = z.looseObject({ event: z.string() });
