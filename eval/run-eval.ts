/**
 * Avaliação do agente contra a API real do LLM.
 * Uso: LLM_API_KEY=... npm run eval
 *   (opcional: LLM_MODEL, EVAL_BASE=eval/base-exemplo.json, EVAL_CASOS=eval/casos.json)
 * Casos com `revisar: true` (vindos do importador, sem critério objetivo) são pulados.
 * Não toca Chatwoot nem banco: as ferramentas são falsas e só registram as chamadas.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AnthropicLlmClient } from '../src/adapters/llm/anthropic-client.js';
import { buildSystemPrompt } from '../src/modules/agent/prompt.js';
import { runAgent } from '../src/modules/agent/run-agent.js';
import { buildTools } from '../src/modules/agent/tools.js';
import { InMemoryAgenda } from '../src/modules/appointments/in-memory.js';

const Base = z.object({
  salao: z.string(),
  versao: z.number(),
  itens: z.array(z.object({ categoria: z.string(), conteudo: z.string() })),
});

const Caso = z.object({
  pergunta: z.string(),
  espera: z.object({
    contem: z.array(z.string()).optional(),
    contem_algum: z.array(z.string()).optional(),
    nao_contem: z.array(z.string()).optional(),
    transfere: z.boolean().optional(),
    ou_transfere: z.boolean().optional(),
    usa_ferramenta: z.string().optional(),
    nao_usa_ferramenta: z.string().optional(),
  }),
  revisar: z.boolean().optional(),
  resposta_referencia: z.string().optional(),
});

const EVAL_NOW = new Date('2026-11-16T14:00:00-03:00'); // segunda, 14h (salão fechado): terça é o próximo dia útil

async function main(): Promise<void> {
  const key = process.env.LLM_API_KEY;
  if (!key) throw new Error('Defina LLM_API_KEY para rodar a avaliação');
  const model = process.env.LLM_MODEL ?? 'claude-haiku-5-5';

  const base = Base.parse(JSON.parse(await readFile(process.env.EVAL_BASE ?? 'eval/base-exemplo.json', 'utf8')));
  const todos = z.array(Caso).parse(JSON.parse(await readFile(process.env.EVAL_CASOS ?? 'eval/casos.json', 'utf8')));
  const casos = todos.filter((c) => !c.revisar);
  if (casos.length < todos.length) {
    console.log(`${todos.length - casos.length} casos marcados "revisar" foram pulados (escreva o "espera" deles).`);
  }
  const llm = new AnthropicLlmClient(key, model);

  // Salão de exemplo (mesmos dados da base): terça a sábado, 9h–12h e 13h–19h.
  const agenda = new InMemoryAgenda();
  const dias = [2, 3, 4, 5, 6].flatMap((weekday) => [
    { weekday, startMin: 9 * 60, endMin: 12 * 60 },
    { weekday, startMin: 13 * 60, endMin: 19 * 60 },
  ]);
  const corte = agenda.addService({ name: 'Corte feminino', durationMin: 60, priceCents: 9000 }).id;
  const escova = agenda.addService({ name: 'Escova', durationMin: 45, priceCents: 6000 }).id;
  const coloracao = agenda.addService({ name: 'Coloração', durationMin: 120, priceCents: null }).id;
  const manicure = agenda.addService({ name: 'Manicure', durationMin: 45, priceCents: 4000 }).id;
  agenda.addProfessional('Ana', [corte, escova, coloracao], dias);
  agenda.addProfessional('Bia', [corte, escova, manicure], dias);
  agenda.addProfessional('Carla', [manicure], dias);

  const tools = buildTools({
    leads: { upsertByPhone: async () => ({ id: 1, created: true }), setOptOut: async () => {} },
    handoff: {
      inbox: { addPrivateNote: async () => {}, assignToTeam: async () => {} },
      handoffs: { record: async () => {} },
    },
    agenda: { catalog: agenda, appointments: agenda, reminders: { schedule: async () => 'job', cancel: async () => {} }, now: () => EVAL_NOW },
  });

  let falhas = 0;
  for (const caso of casos) {
    const system = buildSystemPrompt({
      salonName: base.salao,
      knowledge: { version: base.versao, items: base.itens.map((i) => ({ category: i.categoria, content: i.conteudo })) },
      now: EVAL_NOW,
      timeZone: 'America/Sao_Paulo',
      isFirstReply: false,
    });
    const out = await runAgent(llm, {
      system,
      history: [{ role: 'user', content: caso.pergunta }],
      tools,
      maxSteps: 5,
      ctx: {
        tenantId: 1,
        timeZone: 'America/Sao_Paulo',
        accountId: 1,
        conversationId: 1,
        contact: { chatwootContactId: 1, phone: '+5541900000000', name: null },
      },
    });

    const transferiu = out.kind === 'handoff';
    const texto = out.kind === 'reply' ? out.text.toLowerCase() : '';
    const e = caso.espera;
    const erros: string[] = [];

    if (e.transfere && !transferiu) erros.push('deveria transferir');
    if (!e.transfere && !e.ou_transfere && transferiu) erros.push('transferiu sem necessidade');
    if (!transferiu) {
      for (const t of e.contem ?? []) if (!texto.includes(t.toLowerCase())) erros.push(`faltou "${t}"`);
      if (e.contem_algum && !e.contem_algum.some((t) => texto.includes(t.toLowerCase())))
        erros.push(`faltou um de ${JSON.stringify(e.contem_algum)}`);
      for (const t of e.nao_contem ?? []) if (texto.includes(t.toLowerCase())) erros.push(`não deveria conter "${t}"`);
    }
    if (e.usa_ferramenta && !out.toolsUsed.includes(e.usa_ferramenta)) erros.push(`não usou ${e.usa_ferramenta}`);
    if (e.nao_usa_ferramenta && out.toolsUsed.includes(e.nao_usa_ferramenta)) erros.push(`não deveria usar ${e.nao_usa_ferramenta}`);

    if (erros.length) falhas++;
    console.log(`${erros.length ? 'FALHOU' : 'ok    '} ${caso.pergunta}${erros.length ? `  -> ${erros.join('; ')}` : ''}`);
    if (erros.length && out.kind === 'reply') console.log(`       resposta: ${out.text}`);
  }

  console.log(`\n${casos.length - falhas}/${casos.length} casos passaram (modelo ${model})`);
  if (falhas) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
