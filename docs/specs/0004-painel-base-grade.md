# Spec 0004 — Painel: login, base de conhecimento e grade da experimental

## Objetivo
A academia edita sozinha a base que a IA usa e a grade da aula experimental, sem SQL. Leads, aulas agendadas e relatório ficam para depois do go-live.

## Design
- **Frontend:** React + Vite + TypeScript em `web/`. O build vai para `web/dist` e é servido pelo próprio `agent-api` em `/`.
- **API:** rotas em `/admin/api/*` no `agent-api`. O Caddy expõe o painel e bloqueia `/webhooks/*` de fora.
- **Login:** e-mail e senha. Hash com `scrypt` do Node (sem dependência nativa), comparação em tempo constante e custo uniforme quando o e-mail não existe. Sessão aleatória de 32 bytes guardada no Redis (12 h, renovada a cada uso), em cookie `HttpOnly`, `SameSite=Strict` e `Secure` fora do desenvolvimento. Limite de 5 tentativas por IP + e-mail a cada 15 min (429).
- **Papéis:** `dono` e `recepcao` (os dois editam base e grade nesta spec). Toda consulta filtra pelo `tenant_id` da sessão.
- **Base de conhecimento:** a tela edita a base inteira e salva de uma vez. `PUT` com `expectedVersion` substitui os itens numa transação e incrementa `tenants.knowledge_version`; se a versão mudou no meio, devolve 409 (lock otimista).
- **Grade:** criar horário (modalidade, início, vagas), mudar vagas e excluir. Excluir só sem reservas; vagas nunca abaixo das reservas ativas.
- **Usuários:** criados por script (`npm run admin:create`) até existir tela de usuários.

## Critérios de aceite
- [x] Login certo cria sessão; errado devolve 401 com mensagem genérica; 6ª tentativa em 15 min devolve 429.
- [x] Rotas da base e da grade sem sessão devolvem 401.
- [x] Usuário de uma academia não vê nem altera dados de outra.
- [x] Salvar a base incrementa a versão; salvar com versão antiga devolve 409 e não altera nada.
- [x] A IA passa a usar a base nova na resposta seguinte (já lê a versão ativa a cada resposta).
- [x] Horário com reserva não pode ser excluído; vagas não ficam abaixo das reservas.
- [x] Painel funciona no celular (a recepção usa pelo telefone); conferido em 390 px e 1366 px.
- [x] Testes unitários dos casos acima e de integração com Postgres e Redis.
- [ ] Teste com a recepção da academia num celular de verdade.
