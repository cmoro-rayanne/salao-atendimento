import { randomInt } from 'node:crypto';
import { normalizeEmail } from './login.js';
import type { AdminRole, AdminSession, AdminUserRepository, PasswordHasher, SessionStore } from './ports.js';

export const MIN_PASSWORD_LENGTH = 10;
// Sem caracteres que se confundem (0/O, 1/l/I), para ditar ou copiar sem erro.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateTempPassword(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export interface UserAdminDeps {
  users: AdminUserRepository;
  hasher: PasswordHasher;
  sessions: SessionStore;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Command: o dono cria um acesso; a senha provisória volta uma única vez. */
export async function createTeamMember(
  deps: UserAdminDeps,
  actor: AdminSession,
  input: { email: string; role: AdminRole },
): Promise<{ ok: true; id: number; email: string; tempPassword: string } | { ok: false; error: string }> {
  const email = normalizeEmail(input.email);
  if (!EMAIL.test(email)) return { ok: false, error: 'E-mail inválido.' };
  const tempPassword = generateTempPassword();
  const user = await deps.users.create({
    tenantId: actor.tenantId,
    email,
    role: input.role,
    passwordHash: await deps.hasher.hash(tempPassword),
    mustChangePassword: true,
  });
  if (!user) return { ok: false, error: 'Esse e-mail já tem acesso ao painel.' };
  return { ok: true, id: user.id, email: user.email, tempPassword };
}

/** Command: nova senha provisória para alguém da equipe; derruba as sessões dela. */
export async function resetTeamMemberPassword(
  deps: UserAdminDeps,
  actor: AdminSession,
  userId: number,
): Promise<{ ok: true; tempPassword: string } | { ok: false; error: 'not_found' | 'self' }> {
  if (userId === actor.userId) return { ok: false, error: 'self' };
  const tempPassword = generateTempPassword();
  const changed = await deps.users.setPassword(actor.tenantId, userId, await deps.hasher.hash(tempPassword), true);
  if (!changed) return { ok: false, error: 'not_found' };
  await deps.sessions.destroyAllForUser(userId);
  return { ok: true, tempPassword };
}

/** Command: remove um acesso; nunca o próprio nem o último dono. */
export async function removeTeamMember(
  deps: UserAdminDeps,
  actor: AdminSession,
  userId: number,
): Promise<'ok' | 'not_found' | 'self' | 'last_owner'> {
  if (userId === actor.userId) return 'self';
  const result = await deps.users.remove(actor.tenantId, userId);
  if (result === 'ok') await deps.sessions.destroyAllForUser(userId);
  return result;
}

export type ChangePasswordResult =
  | { ok: true; session: AdminSession }
  | { ok: false; error: 'wrong_current' | 'weak' | 'same' };

/**
 * Command: a pessoa troca a própria senha. Quem chama gira a sessão
 * (nova sessão sem a marca de senha provisória, as antigas encerradas).
 */
export async function changeOwnPassword(
  deps: Pick<UserAdminDeps, 'users' | 'hasher'>,
  session: AdminSession,
  input: { current: string; next: string },
): Promise<ChangePasswordResult> {
  if (input.next.length < MIN_PASSWORD_LENGTH) return { ok: false, error: 'weak' };
  if (input.next === input.current) return { ok: false, error: 'same' };
  const user = await deps.users.findById(session.tenantId, session.userId);
  if (!user || !(await deps.hasher.verify(input.current, user.passwordHash))) return { ok: false, error: 'wrong_current' };

  await deps.users.setPassword(session.tenantId, session.userId, await deps.hasher.hash(input.next), false);
  return { ok: true, session: { ...session, mustChangePassword: false } };
}
