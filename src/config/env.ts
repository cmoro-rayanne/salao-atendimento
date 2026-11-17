import { z } from 'zod';

/** Variável vazia no .env (ex.: `USD_BRL=`) vale como não definida. */
const blankAsUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalUrl = z.preprocess(blankAsUndefined, z.url().optional());
const optionalPositive = z.preprocess(blankAsUndefined, z.coerce.number().positive().optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  CHATWOOT_BASE_URL: z.url(),
  /** Endereço do Chatwoot que a equipe abre no navegador (links do painel). */
  CHATWOOT_PUBLIC_URL: optionalUrl,
  CHATWOOT_ACCOUNT_ID: z.coerce.number().int().positive(),
  CHATWOOT_BOT_TOKEN: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(24, 'WEBHOOK_SECRET precisa de pelo menos 24 caracteres'),

  REMINDER_TEMPLATE_NAME: z.string().default('lembrete_aula_experimental'),
  REMINDER_TEMPLATE_LANG: z.string().default('pt_BR'),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_PER_DAY: z.coerce.number().int().positive().default(150),
  /** Webhook para alertas (ex.: https://ntfy.sh/<tópico-secreto>). Vazio = sem alertas. */
  ALERT_WEBHOOK_URL: optionalUrl,
  ALERT_WEBHOOK_FORMAT: z.enum(['text', 'json']).default('text'),

  MESSAGE_DEBOUNCE_MS: z.coerce.number().int().min(0).default(4000),
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(10).default(5),

  WEB_ROOT: z.string().default('web/dist'),
  /** `true` atrás do Caddy: usa X-Forwarded-For para o IP real (rate limit do login). */
  TRUST_PROXY: z.stringbool().default(false),
  ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  /** Assina o JWT da sessão do painel; precisa ser estável entre deploys (invalida sessões se mudar). */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de pelo menos 32 caracteres'),

  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('claude-haiku-5-5'),
  LLM_BASE_URL: z.url().default('https://api.anthropic.com'),
  /** Preço do modelo em dólares por milhão de tokens; sem eles, o custo fica em branco no relatório. */
  LLM_PRICE_INPUT_USD_PER_MTOK: optionalPositive,
  LLM_PRICE_OUTPUT_USD_PER_MTOK: optionalPositive,
  /** Cotação usada para mostrar o custo de IA em reais no relatório. */
  USD_BRL: optionalPositive,
});

export type Env = z.infer<typeof EnvSchema>;

/** Valida as variáveis de ambiente na inicialização; falha cedo com mensagem clara. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Variáveis de ambiente inválidas:\n${issues}`);
  }
  return parsed.data;
}

/** O worker precisa da chave do LLM; a API não. */
export function requireLlmKey(env: Env): string {
  if (!env.LLM_API_KEY) throw new Error('LLM_API_KEY é obrigatória para o worker');
  return env.LLM_API_KEY;
}
