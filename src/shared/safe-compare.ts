import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compara segredos em tempo constante. Os dois lados viram hash SHA-256 antes,
 * para que tamanhos diferentes não vazem informação nem lancem erro.
 */
export function safeCompare(received: string, expected: string): boolean {
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
