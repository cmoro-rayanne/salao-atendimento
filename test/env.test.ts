import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  CHATWOOT_BASE_URL: 'http://localhost:3001',
  CHATWOOT_ACCOUNT_ID: '1',
  CHATWOOT_BOT_TOKEN: 'x',
  WEBHOOK_SECRET: 'x'.repeat(30),
  JWT_SECRET: 'y'.repeat(32),
};

describe('loadEnv', () => {
  it('variáveis opcionais vazias no .env valem como não definidas', () => {
    const env = loadEnv({ ...base, USD_BRL: '', LLM_PRICE_INPUT_USD_PER_MTOK: ' ', CHATWOOT_PUBLIC_URL: '' });
    expect(env.USD_BRL).toBeUndefined();
    expect(env.LLM_PRICE_INPUT_USD_PER_MTOK).toBeUndefined();
    expect(env.CHATWOOT_PUBLIC_URL).toBeUndefined();
  });

  it('lê números e booleanos', () => {
    const env = loadEnv({ ...base, USD_BRL: '5.4', TRUST_PROXY: 'true' });
    expect(env.USD_BRL).toBe(5.4);
    expect(env.TRUST_PROXY).toBe(true);
  });

  it('falha com mensagem clara quando falta obrigatória', () => {
    expect(() => loadEnv({ ...base, WEBHOOK_SECRET: 'curto' })).toThrow(/WEBHOOK_SECRET/);
  });
});
