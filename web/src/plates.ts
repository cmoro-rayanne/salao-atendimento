/** Cores das anilhas olímpicas (vermelha, azul, amarela, verde): cada modalidade ganha a sua. */
const PLATES = ['var(--plate-red)', 'var(--plate-blue)', 'var(--plate-yellow)', 'var(--plate-green)'];

export function plateFor(modality: string): string {
  let h = 0;
  for (const ch of modality.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PLATES[h % PLATES.length]!;
}
