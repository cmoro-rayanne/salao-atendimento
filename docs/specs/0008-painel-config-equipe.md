# Spec 0008 — Configurações da academia e equipe no painel

## Objetivo
O dono da academia ajusta os dados que o agente usa e gerencia os acessos da equipe pelo painel, sem SQL nem script.

## Design
- **Papéis:** só `dono` vê e altera Configurações e Equipe; `recepcao` continua com leads, aulas, grade e base. A regra fica na API (403), não só na tela.
- **Configurações** (`GET/PUT /admin/api/settings`): nome da academia (usado pela IA), horário da recepção (`open`/`close` em horas cheias, usado no aviso de fora do horário e no relatório), link da política de privacidade (rodapé da primeira resposta) e fuso (lista de fusos do Brasil).
- **Equipe** (`/admin/api/users`): listar; criar com senha provisória gerada pelo sistema e mostrada **uma vez**; redefinir a senha (nova provisória); remover. Não dá para remover a si mesmo nem o último dono. Remover ou redefinir encerra as sessões abertas daquela pessoa.
- **Senha provisória:** quem entra com ela é levado a trocar antes de usar o painel (`must_change_password`).
- **Trocar a própria senha** (`POST /admin/api/auth/password`): exige a senha atual; nova com pelo menos 10 caracteres e diferente da atual; encerra as outras sessões.
- **Sessões por pessoa:** o Redis guarda, por usuário, as sessões abertas para poder encerrá-las.

## Critérios de aceite
- [x] Recepção recebe 403 em configurações e equipe.
- [x] Senha provisória aparece uma vez; o login com ela exige troca antes de qualquer outra rota.
- [x] Remover a si mesmo ou o último dono é recusado.
- [x] Remover ou redefinir senha derruba as sessões da pessoa.
- [x] Configurações validadas (horas 0–24, abertura antes do fechamento, URL https, fuso da lista).
- [x] Testes unitários e de integração; telas funcionando no celular.
