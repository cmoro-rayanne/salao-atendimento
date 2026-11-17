/** Cores das anilhas olímpicas (vermelha, azul, amarela, verde): cada profissional ganha a sua. */
const PLATES = ['var(--plate-red)', 'var(--plate-blue)', 'var(--plate-yellow)', 'var(--plate-green)'];

export function plateFor(name: string): string {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PLATES[h % PLATES.length]!;
}
