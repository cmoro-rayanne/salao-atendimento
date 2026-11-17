# Spec 0010 — Perguntas que a IA não soube responder

## Objetivo
Mostrar à academia, no relatório do mês, as perguntas que a IA passou para a equipe porque a resposta não estava na base. É a lista do que falta ensinar em **O que a IA sabe**.

## Design
- **Captura:** a ferramenta `transferir_para_humano` ganha `pergunta_sem_resposta` (opcional): a pergunta da pessoa em uma frase, só quando o motivo é falta de informação na base, sem nome nem telefone.
- **Higiene no servidor** (`sanitizeQuestion`, puro): espaços colapsados, até 300 caracteres, sequências de 8+ dígitos (telefone, CPF) e e-mails trocados por `[removido]`. A pergunta nunca vai para log.
- **Banco:** `handoffs.question` e `handoffs.question_resolved_at` (migration 008), índice parcial por academia e data.
- **Painel:** `GET /admin/api/unanswered?from&to` lista as do período (mais recentes primeiro, até 200) com link para a conversa no Chatwoot; `PATCH /admin/api/unanswered/:id` marca ou desmarca como resolvida ("já ensinei à IA"). Dono e recepção podem usar; sempre filtrado pela academia da sessão.
- **Relatório:** seção "Perguntas que a IA não soube responder" com as pendentes primeiro; as resolvidas ficam riscadas e fora do PDF.

## Critérios de aceite
- [x] A ferramenta grava a pergunta higienizada junto da transferência; sem o campo, nada muda.
- [x] Telefone, CPF e e-mail não chegam ao banco.
- [x] Lista e marcação respeitam a academia da sessão (outra academia → 404).
- [x] Seção aparece no relatório, no celular e no PDF (sem botões).
- [x] Testes unitários e de integração.
