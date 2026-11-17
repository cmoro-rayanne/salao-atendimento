import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { PasswordHasher } from '../../modules/auth/ports.js';

const KEY_LEN = 64;
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
// N=2^15, r=8 usa 32 MiB por hash; o padrão do Node (32 MiB) não basta.
const MAX_MEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/**
 * Hash de senha com scrypt (embutido no Node). Formato:
 * `scrypt$N$r$p$<salt base64>$<hash base64>`, para poder mudar parâmetros no futuro.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  readonly dummyHash =
    'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(KEY_LEN).toString('base64');

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, KEY_LEN, { ...PARAMS, maxmem: MAX_MEM });
    return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const [alg, n, r, p, saltB64, hashB64] = stored.split('$');
    if (alg !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAX_MEM,
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
  }
}
