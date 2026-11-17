import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { AdminSession, SessionStore } from '../../modules/auth/ports.js';

const ClaimsSchema = z.object({
  sub: z.string(),
  tenantId: z.number().int(),
  email: z.string(),
  role: z.enum(['dono', 'recepcao']),
  mustChangePassword: z.boolean().default(false),
  jti: z.string(),
  iat: z.number().int(),
});

/**
 * Sessão do painel como JWT assinado (HS256). Stateless por padrão; as duas
 * revogações imediatas que o painel precisa (logout, reset/remoção de acesso)
 * usam um registro mínimo no Redis — ver spec 0012.
 */
export class JwtSessionStore implements SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly secret: Uint8Array,
    private readonly ttlSec: number,
  ) {}

  private revokedKey(jti: string): string {
    return `admin:jwt-revoked:${jti}`;
  }

  private notBeforeKey(userId: number): string {
    return `admin:jwt-notbefore:${userId}`;
  }

  private keptKey(jti: string): string {
    return `admin:jwt-kept:${jti}`;
  }

  async create(session: AdminSession): Promise<string> {
    const jti = randomUUID();
    return new SignJWT({
      tenantId: session.tenantId,
      email: session.email,
      role: session.role,
      mustChangePassword: session.mustChangePassword,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(session.userId))
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSec}s`)
      .sign(this.secret);
  }

  async get(token: string): Promise<AdminSession | null> {
    let claims;
    try {
      claims = ClaimsSchema.parse((await jwtVerify(token, this.secret)).payload);
    } catch {
      return null;
    }
    const userId = Number(claims.sub);

    if (await this.redis.exists(this.revokedKey(claims.jti))) return null;

    const notBefore = await this.redis.get(this.notBeforeKey(userId));
    if (notBefore && claims.iat * 1000 < Number(notBefore)) {
      // Só sobrevive se foi poupado exatamente nessa revogação (não numa anterior).
      const kept = await this.redis.get(this.keptKey(claims.jti));
      if (kept !== notBefore) return null;
    }

    return {
      userId,
      tenantId: claims.tenantId,
      email: claims.email,
      role: claims.role,
      mustChangePassword: claims.mustChangePassword,
    };
  }

  async destroy(token: string): Promise<void> {
    let payload;
    try {
      payload = (await jwtVerify(token, this.secret)).payload;
    } catch {
      return;
    }
    const jti = typeof payload.jti === 'string' ? payload.jti : null;
    const exp = typeof payload.exp === 'number' ? payload.exp : null;
    if (!jti || !exp) return;
    await this.redis.set(this.revokedKey(jti), '1', 'EX', Math.max(1, exp - Math.floor(Date.now() / 1000)));
  }

  async destroyAllForUser(userId: number, exceptToken?: string): Promise<void> {
    const now = String(Date.now());
    await this.redis.set(this.notBeforeKey(userId), now, 'EX', this.ttlSec);
    if (!exceptToken) return;

    let payload;
    try {
      payload = (await jwtVerify(exceptToken, this.secret)).payload;
    } catch {
      return;
    }
    const jti = typeof payload.jti === 'string' ? payload.jti : null;
    const exp = typeof payload.exp === 'number' ? payload.exp : null;
    if (!jti || !exp) return;
    // Amarrado ao valor exato desta revogação: uma revogação em massa posterior invalida mesmo assim.
    await this.redis.set(this.keptKey(jti), now, 'EX', Math.max(1, exp - Math.floor(Date.now() / 1000)));
  }
}
