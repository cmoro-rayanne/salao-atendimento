import { describe, expect, it } from 'vitest';
import { ScryptPasswordHasher } from '../src/adapters/crypto/scrypt-hasher.js';
import { SESSION_COOKIE } from '../src/http/admin-routes.js';
import { login } from '../src/modules/auth/login.js';
import { replaceKnowledge } from '../src/modules/knowledge/replace-knowledge.js';
import type { ClientListItem } from '../src/modules/clients/ports.js';
import { fakeAdmin } from './helpers/fake-admin.js';

const hasher = new ScryptPasswordHasher();

describe('login', () => {
  it('cria sessão com e-mail em qualquer caixa e cookie HttpOnly + SameSite=Strict', async () => {
    const { loginAs } = await fakeAdmin();
    const { res } = await loginAs('  Dono@Aurora.com.br ', 'senha-forte-123');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'dono@aurora.com.br', role: 'dono' });
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/admin/api' });
  });

  it('mesma resposta para senha errada e e-mail inexistente', async () => {
    const { loginAs } = await fakeAdmin();
    const wrong = await loginAs('dono@aurora.com.br', 'errada');
    const missing = await loginAs('ninguem@x.com', 'errada');
    expect(wrong.res.statusCode).toBe(401);
    expect(missing.res.statusCode).toBe(401);
    expect(wrong.res.json()).toEqual(missing.res.json());
  });

  it('bloqueia na 6ª tentativa com 429 e Retry-After', async () => {
    const { loginAs } = await fakeAdmin();
    for (let i = 0; i < 5; i++) expect((await loginAs('dono@aurora.com.br', 'errada')).res.statusCode).toBe(401);
    const blocked = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.headers['retry-after']).toBe('900');
  });

  it('use case: e-mail inexistente ainda verifica senha (custo uniforme)', async () => {
    const { deps } = await fakeAdmin();
    let verified = 0;
    const result = await login(
      { ...deps, hasher: { hash: (p) => hasher.hash(p), dummyHash: hasher.dummyHash, verify: async () => (verified++, false) } },
      { email: 'ninguem@x.com', password: 'x', ip: '1.1.1.1' },
    );
    expect(result).toEqual({ kind: 'invalid' });
    expect(verified).toBe(1);
  });
});

describe('rotas protegidas', () => {
  it('sem sessão devolvem 401', async () => {
    const { app } = await fakeAdmin();
    for (const [method, url] of [
      ['GET', '/admin/api/knowledge'],
      ['PUT', '/admin/api/knowledge'],
      ['GET', '/admin/api/clients'],
      ['GET', '/admin/api/auth/me'],
    ] as const) {
      const res = await app.inject(method === 'GET' ? { method, url } : { method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('logout invalida a sessão', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    await app.inject({ method: 'POST', url: '/admin/api/auth/logout', headers: { cookie } });
    const me = await app.inject({ method: 'GET', url: '/admin/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });
});

describe('base de conhecimento', () => {
  it('cado salão só vê a própria base', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    const res = await app.inject({ method: 'GET', url: '/admin/api/knowledge', headers: { cookie } });
    expect(JSON.stringify(res.json())).not.toContain('da outra academia');
    expect(res.json().items).toHaveLength(1);
  });

  it('salvar incrementa a versão; versão antiga devolve 409 sem alterar', async () => {
    const { app, kb, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    const items = [{ category: 'Planos', content: 'Mensal R$ 130', active: true }];

    const ok = await app.inject({ method: 'PUT', url: '/admin/api/knowledge', headers: { cookie }, payload: { expectedVersion: 1, items } });
    expect(ok.json()).toEqual({ ok: true, version: 2 });

    const stale = await app.inject({
      method: 'PUT',
      url: '/admin/api/knowledge',
      headers: { cookie },
      payload: { expectedVersion: 1, items: [{ category: 'Planos', content: 'R$ 999', active: true }] },
    });
    expect(stale.statusCode).toBe(409);
    expect(kb.get(1)!.items[0]!.content).toBe('Mensal R$ 130');
  });

  it('valida itens: categoria e conteúdo obrigatórios, linhas vazias ignoradas', async () => {
    const repo = {
      getForEdit: async () => ({ version: 1, items: [] }),
      replaceAll: async () => ({ ok: true as const, version: 2 }),
      listVersions: async () => [],
      getVersion: async () => null,
    };
    expect(await replaceKnowledge(repo, 1, 1, [{ category: 'Planos', content: '  ', active: true }])).toMatchObject({ ok: false, error: expect.stringContaining('conteúdo') });
    expect(await replaceKnowledge(repo, 1, 1, [{ category: ' ', content: ' ', active: true }])).toEqual({ ok: true, version: 2 });
    const huge = Array.from({ length: 10 }, (_, i) => ({ category: `C${i}`, content: 'x'.repeat(3500), active: true }));
    expect(await replaceKnowledge(repo, 1, 1, huge)).toMatchObject({ ok: false, error: expect.stringContaining('30000') });
    const inactive = huge.map((i) => ({ ...i, active: false }));
    expect(await replaceKnowledge(repo, 1, 1, inactive)).toEqual({ ok: true, version: 2 });
  });
});

describe('ScryptPasswordHasher', () => {
  it('verifica a senha certa, recusa a errada e o hash de mentira nunca confere', async () => {
    const h = await hasher.hash('minha-senha-123');
    expect(h.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await hasher.verify('minha-senha-123', h)).toBe(true);
    expect(await hasher.verify('outra', h)).toBe(false);
    expect(await hasher.verify('', hasher.dummyHash)).toBe(false);
    expect(await hasher.verify('x', 'lixo')).toBe(false);
  });
});

describe('clientes', () => {
  it('lista só as do salão logado', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    const res = await app.inject({ method: 'GET', url: '/admin/api/clients', headers: { cookie } });
    expect(res.json().clients.map((c: ClientListItem) => c.name)).toEqual(['Carla']);
  });

  it('busca por nome', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    const res = await app.inject({ method: 'GET', url: '/admin/api/clients?q=zzz', headers: { cookie } });
    expect(res.json().clients).toEqual([]);
  });
});

describe('sessão', () => {
  it('/auth/me traz o fuso e o link da conta no Chatwoot', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    const me = await app.inject({ method: 'GET', url: '/admin/api/auth/me', headers: { cookie } });
    expect(me.json()).toEqual({
      email: 'dono@aurora.com.br',
      role: 'dono',
      mustChangePassword: false,
      timeZone: 'America/Sao_Paulo',
      chatwootAccountUrl: 'https://chat.exemplo.com.br/app/accounts/3',
    });
  });
});

describe('relatório', () => {
  it('usa o mês atual no fuso do salão e devolve os números calculados', async () => {
    const { app, reportCalls, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    const res = await app.inject({ method: 'GET', url: '/admin/api/report', headers: { cookie } });
    const r = res.json();
    expect(r.month).toBe('2026-11');
    expect(r.partial).toBe(true);
    expect(reportCalls[0]!.from.toISOString()).toBe('2026-11-01T03:00:00.000Z');
    expect(reportCalls[0]!.to.toISOString()).toBe('2026-11-16T15:00:00.000Z');
    expect(r.resolvedByAiShare).toBeCloseTo(0.7);
    expect(r.handoffs.byCategory).toEqual([
      { label: 'Matrícula ou pagamento', count: 2 },
      { label: 'Dúvida fora da base', count: 1 },
    ]);
    expect(r.outsideReceptionShare).toBeCloseTo(0.4);
    expect(r.aiCostBrl).toBe(10);
    expect(r.aiCostPerConversationBrl).toBe(1);
  });

  it('mês inválido: 400', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    expect((await app.inject({ method: 'GET', url: '/admin/api/report?month=2026-13', headers: { cookie } })).statusCode).toBe(400);
  });
});

describe('configurações e equipe (só dono)', () => {
  it('recepção recebe 403 em configurações e equipe', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('recepcao@aurora.com.br', 'recepcao-123456');
    for (const [method, url] of [
      ['GET', '/admin/api/settings'],
      ['PUT', '/admin/api/settings'],
      ['GET', '/admin/api/users'],
      ['POST', '/admin/api/users'],
      ['DELETE', '/admin/api/users/1'],
    ] as const) {
      const res = await app.inject(method === 'GET' ? { method, url, headers: { cookie } } : { method, url, headers: { cookie }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('salva configurações válidas e recusa as inválidas', async () => {
    const { app, loginAs, getSettings } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    const ok = await app.inject({
      method: 'PUT',
      url: '/admin/api/settings',
      headers: { cookie },
      payload: { name: ' Studio Aurora ', timeZone: 'America/Sao_Paulo', receptionHours: { open: 7, close: 21 }, privacyUrl: 'https://aurora.com.br/privacidade' },
    });
    expect(ok.json()).toEqual({ ok: true });
    expect(getSettings()).toMatchObject({ name: 'Studio Aurora', receptionHours: { open: 7, close: 21 } });

    for (const bad of [
      { receptionHours: { open: 21, close: 7 } },
      { privacyUrl: 'http://inseguro.com' },
      { timeZone: 'Europe/Lisbon' },
      { name: 'x' },
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/api/settings',
        headers: { cookie },
        payload: { name: 'Studio Aurora', timeZone: 'America/Sao_Paulo', receptionHours: null, privacyUrl: null, ...bad },
      });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('cria acesso com senha provisória, que exige troca antes de usar o painel', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    const created = await app.inject({ method: 'POST', url: '/admin/api/users', headers: { cookie }, payload: { email: 'Nova@Aurora.com.br', role: 'recepcao' } });
    expect(created.statusCode).toBe(201);
    const { tempPassword, email } = created.json();
    expect(email).toBe('nova@aurora.com.br');
    expect(tempPassword).toMatch(/^[a-zA-Z2-9]{12}$/);

    const dup = await app.inject({ method: 'POST', url: '/admin/api/users', headers: { cookie }, payload: { email, role: 'recepcao' } });
    expect(dup.statusCode).toBe(400);

    const nova = await loginAs(email, tempPassword);
    expect((await app.inject({ method: 'GET', url: '/admin/api/auth/me', headers: { cookie: nova.cookie } })).json().mustChangePassword).toBe(true);
    const blocked = await app.inject({ method: 'GET', url: '/admin/api/clients', headers: { cookie: nova.cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('must_change_password');

    const changed = await app.inject({ method: 'POST', url: '/admin/api/auth/password', headers: { cookie: nova.cookie }, payload: { current: tempPassword, next: 'minha-senha-nova' } });
    expect(changed.json()).toEqual({ ok: true });
    const newCookie = changed.cookies.find((c) => c.name === SESSION_COOKIE)!;
    const fresh = `${SESSION_COOKIE}=${newCookie.value}`;
    expect((await app.inject({ method: 'GET', url: '/admin/api/clients', headers: { cookie: fresh } })).statusCode).toBe(200);
    // A sessão antiga, com a senha provisória, foi encerrada.
    expect((await app.inject({ method: 'GET', url: '/admin/api/auth/me', headers: { cookie: nova.cookie } })).statusCode).toBe(401);
  });

  it('troca de senha: atual errada, curta ou igual são recusadas', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    const post = (payload: object) => app.inject({ method: 'POST', url: '/admin/api/auth/password', headers: { cookie }, payload });
    expect((await post({ current: 'errada', next: 'outra-senha-longa' })).statusCode).toBe(403);
    expect((await post({ current: 'senha-forte-123', next: 'curta' })).statusCode).toBe(400);
    expect((await post({ current: 'senha-forte-123', next: 'senha-forte-123' })).statusCode).toBe(400);
  });

  it('redefinir senha e remover derrubam as sessões da pessoa', async () => {
    const { app, loginAs } = await fakeAdmin();
    const dono = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    const rec = await loginAs('recepcao@aurora.com.br', 'recepcao-123456');

    const reset = await app.inject({ method: 'POST', url: '/admin/api/users/3/reset-password', headers: { cookie: dono.cookie } });
    expect(reset.json().tempPassword).toHaveLength(12);
    expect((await app.inject({ method: 'GET', url: '/admin/api/auth/me', headers: { cookie: rec.cookie } })).statusCode).toBe(401);

    const again = await loginAs('recepcao@aurora.com.br', reset.json().tempPassword);
    const removed = await app.inject({ method: 'DELETE', url: '/admin/api/users/3', headers: { cookie: dono.cookie } });
    expect(removed.json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: '/admin/api/auth/me', headers: { cookie: again.cookie } })).statusCode).toBe(401);
  });

  it('não remove a si mesmo, nem usuário de outra academia', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    expect((await app.inject({ method: 'DELETE', url: '/admin/api/users/1', headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/admin/api/users/2', headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('perguntas que a IA não soube responder', () => {
  const range = 'from=2026-11-01T03:00:00Z&to=2026-12-01T03:00:00Z';

  it('lista só as do salão e marca como resolvida', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('recepcao@aurora.com.br', 'recepcao-123456');
    const list = await app.inject({ method: 'GET', url: `/admin/api/unanswered?${range}`, headers: { cookie } });
    expect(list.json().items.map((q: { question: string }) => q.question)).toEqual(['Tem natação?']);

    const ok = await app.inject({ method: 'PATCH', url: '/admin/api/unanswered/1', headers: { cookie }, payload: { resolved: true } });
    expect(ok.json()).toEqual({ ok: true });
    const after = await app.inject({ method: 'GET', url: `/admin/api/unanswered?${range}`, headers: { cookie } });
    expect(after.json().items[0].resolvedAt).not.toBeNull();

    const other = await app.inject({ method: 'PATCH', url: '/admin/api/unanswered/2', headers: { cookie }, payload: { resolved: true } });
    expect(other.statusCode).toBe(404);
  });

  it('valida período e corpo', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('dono@aurora.com.br', 'senha-forte-123');
    expect((await app.inject({ method: 'GET', url: '/admin/api/unanswered', headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/admin/api/unanswered/1', headers: { cookie }, payload: { resolved: 'sim' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/admin/api/unanswered?${range}` })).statusCode).toBe(401);
  });
});

describe('histórico da base', () => {
  it('salvar registra autor; versões só do salão; 404 em versão de outra', async () => {
    const { app, loginAs } = await fakeAdmin();
    const { cookie } = await loginAs('recepcao@aurora.com.br', 'recepcao-123456');
    const kb = (await app.inject({ method: 'GET', url: '/admin/api/knowledge', headers: { cookie } })).json();
    await app.inject({
      method: 'PUT',
      url: '/admin/api/knowledge',
      headers: { cookie },
      payload: { expectedVersion: kb.version, items: [{ category: 'Planos', content: 'Mensal R$ 100', active: true }] },
    });
    const list = (await app.inject({ method: 'GET', url: '/admin/api/knowledge/versions', headers: { cookie } })).json();
    expect(list.versions).toEqual([expect.objectContaining({ version: kb.version + 1, author: 'recepcao@aurora.com.br', itemCount: 1 })]);
    const one = await app.inject({ method: 'GET', url: `/admin/api/knowledge/versions/${kb.version + 1}`, headers: { cookie } });
    expect(one.json().items).toEqual([{ category: 'Planos', content: 'Mensal R$ 100', active: true }]);

    const other = await loginAs('dono@outra.com.br', 'outra-senha-123');
    const denied = await app.inject({ method: 'GET', url: `/admin/api/knowledge/versions/${kb.version + 1}`, headers: { cookie: other.cookie } });
    expect(denied.statusCode).toBe(404);
  });
});
