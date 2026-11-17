import type { AdminSession, AdminUserRepository, LoginRateLimiter, PasswordHasher, SessionStore } from './ports.js';

export interface LoginDeps {
  users: AdminUserRepository;
  hasher: PasswordHasher;
  sessions: SessionStore;
  limiter: LoginRateLimiter;
}

export type LoginResult =
  | { kind: 'ok'; token: string; session: AdminSession }
  | { kind: 'invalid' }
  | { kind: 'rate_limited'; retryAfterSec: number };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Command: login do painel. Mesma resposta e mesmo custo para e-mail
 * inexistente e senha errada, para não revelar quais e-mails existem.
 */
export async function login(
  deps: LoginDeps,
  input: { email: string; password: string; ip: string },
): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const limitKey = `${input.ip}:${email}`;

  const limit = await deps.limiter.hit(limitKey);
  if (!limit.allowed) return { kind: 'rate_limited', retryAfterSec: limit.retryAfterSec };

  const user = await deps.users.findByEmail(email);
  const valid = await deps.hasher.verify(input.password, user?.passwordHash ?? deps.hasher.dummyHash);
  if (!user || !valid) return { kind: 'invalid' };

  await deps.limiter.reset(limitKey);
  const session: AdminSession = {
    userId: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
  const token = await deps.sessions.create(session);
  return { kind: 'ok', token, session };
}
