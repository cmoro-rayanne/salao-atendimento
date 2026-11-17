# Spec 0009 — Importar o documento da base preenchido pela academia

## Objetivo
A academia preenche o documento "Base de conhecimento da IA" (modelo em Docs). Quem implanta exporta em Markdown e carrega tudo de uma vez: base da IA, horário da recepção, grade da aula experimental e casos de avaliação. Sem redigitar nada no painel.

## Design
- **Entrada:** o Markdown exportado do documento (menu Exportar → Markdown). Os títulos `##` e as tabelas do modelo são o contrato; campos ainda com `[preencher…]` são ignorados e listados no relatório.
- **Parser puro** (`modules/knowledge/import-doc.ts`), sem I/O:
  - Cada seção vira um item da base (categoria = título). Tabelas viram linhas `Coluna: valor`; listas `**Rótulo:** valor` viram `Rótulo: valor`. Frases com `[preencher]` dentro de uma célula são cortadas; o resto da célula fica.
  - "Como preencher" é instrução para a academia e não entra na base. "Perguntas que os clientes mais fazem" vira casos de avaliação, não base.
  - **Recepção:** a linha "Horário da recepção" com `7h às 21h` (dias úteis) vira `receptionHours`. Se não der para ler, avisa e não altera.
  - **Grade da experimental:** a tabela da seção "Aula experimental" com dias (`seg`, `segunda a sexta`, `seg/qua/sex`, `sáb`) e horários (`7h`, `19h30`, `07:00`), grupos separados por `;`. Linha que não der para ler vira aviso, nunca chute.
  - **Avaliação:** resposta "passar para a equipe" → `transfere`. Com preço ou horário → `contem`/`contem_algum` com esses valores. Sem âncora objetiva → caso marcado `revisar` (o eval pula até alguém escrever o critério).
- **Script** `npm run kb:import -- --file base.md --tenant 1`:
  - Sem `--apply`: só mostra o relatório (itens, pendências, horários, casos). Não toca o banco.
  - `--apply`: grava a base (mesma validação do painel, lock otimista), o horário da recepção e os horários da experimental das próximas `--weeks` semanas (padrão 4), pulando os que já existem.
  - Se a base atual já tiver itens, `--apply` recusa sem `--replace` (evita apagar o que a academia editou no painel).
  - `--eval-dir <pasta>` grava `base.json` e `casos.json` no formato do eval.
- **Eval:** `EVAL_BASE` e `EVAL_CASOS` escolhem os arquivos; casos com `revisar` são pulados e contados.

## Critérios de aceite
- [x] Documento modelo vazio só traz o que o próprio modelo já escreve (a linha da musculação) e lista as pendências.
- [x] Documento preenchido gera itens, horário da recepção, horários e casos esperados (fixture fictícia, sem dados reais).
- [x] Linhas de grade ilegíveis viram aviso; nada é criado para elas.
- [x] `--apply` respeita `--replace`, não duplica horários e grava no fuso da academia.
- [x] Testes unitários do parser e do serviço de importação.
