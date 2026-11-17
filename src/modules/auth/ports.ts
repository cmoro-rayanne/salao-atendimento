export type AdminRole = 'dono' | 'recepcao';

export interface AdminUser {
  id: number;
  tenantId: number;
  email: string;
  passwordHash: string;
  role: AdminRole;
  mustChangePassword: boolean;
}

/** O que fica guardado na sessão e chega às rotas do painel. */
export interface AdminSession {
  userId: number;
  tenantId: number;
  email: string;
  role: AdminRole;
  /** Entrou com senha provisória: só pode trocar a senha até concluir. */
  mustChangePassword: boolean;
}

export interface AdminUserSummary {
  id: number;
  email: string;
  role: AdminRole;
  mustChangePassword: boolean;
  createdAt: Date;
}

export interface AdminUserRepository {
  findByEmail(email: string): Promise<AdminUser | null>;
  findById(tenantId: number, id: number): Promise<AdminUser | null>;
  listByTenant(tenantId: number): Promise<AdminUserSummary[]>;
  /** `null` se o e-mail já existe (em qualquer academia). */
  create(input: Omit<AdminUser, 'id'>): Promise<AdminUser | null>;
  setPassword(tenantId: number, id: number, passwordHash: string, mustChange: boolean): Promise<boolean>;
  /** Remove só se não for o último dono da academia (checado na mesma transação). */
  remove(tenantId: number, id: number): Promise<'ok' | 'not_found' | 'last_owner'>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
  /** Hash válido de uma senha qualquer, para gastar o mesmo tempo quando o e-mail não existe. */
  readonly dummyHash: string;
}

export interface SessionStore {
  create(session: AdminSession): Promise<string>;
  /** Devolve a sessão e renova a validade; `null` se não existe ou expirou. */
  get(token: string): Promise<AdminSession | null>;
  destroy(token: string): Promise<void>;
  /** Encerra todas as sessões da pessoa, menos `exceptToken` (a atual, ao trocar a própria senha). */
  destroyAllForUser(userId: number, exceptToken?: string): Promise<void>;
}

export interface LoginRateLimiter {
  /** Conta uma tentativa. `allowed: false` quando passou do limite da janela. */
  hit(key: string): Promise<{ allowed: boolean; retryAfterSec: number }>;
  reset(key: string): Promise<void>;
}
