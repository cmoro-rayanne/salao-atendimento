# Spec 0012 — Sessão do painel com JWT

## Objetivo
Trocar a sessão do painel (hoje: token opaco guardado inteiro no Redis) por um JWT assinado, mantendo a mesma interface (`SessionStore`) e sem regressão de segurança nos fluxos que hoje dependem de revogação imediata (logout, reset de senha, remoção de acesso).

## Contexto / decisão
JWT puro é stateless: uma vez emitido, não dá para invalidar antes de expirar. Isso quebraria dois fluxos reais do painel (`resetTeamMemberPassword`, `removeTeamMember`), que hoje encerram a sessão da pessoa na hora. Decisão (confirmada com o usuário): **JWT + blocklist leve no Redis**, só para os casos que precisam de revogação imediata — o resto (validação de assinatura e expiração) é stateless.

## Design
- **Claims do JWT:** `sub` (userId), `tenantId`, `email`, `role`, `mustChangePassword`, `jti` (id aleatório), `iat`, `exp`. Assinado com HS256 via `jose`, segredo em `JWT_SECRET` (env, mínimo 32 caracteres).
- **Adapter novo** `src/adapters/auth/jwt-session.ts` (`JwtSessionStore implements SessionStore`), substitui `RedisSessionStore` em `src/main.ts`. `ports.ts` e os módulos de domínio (`login.ts`, `manage-users.ts`) não mudam.
- **Revogação individual** (`destroy`, logout): decodifica o token, guarda `admin:jwt-revoked:<jti>` no Redis com TTL igual ao tempo restante até expirar.
- **Revogação em massa** (`destroyAllForUser`, reset de senha / remoção de acesso): grava `admin:jwt-notbefore:<userId>` = agora (ms). No `get`, token com `iat` anterior a esse timestamp é rejeitado. Quando chamado com `exceptToken` (troca da própria senha, que gira a sessão), o jti do token novo entra em `admin:jwt-kept:<jti>` (TTL = tempo restante) para sobreviver ao corte.
- **Validação em `get`:** assinatura + expiração (via `jose`), claims validados com o mesmo `zod` schema de hoje, depois os dois checks de revogação acima.
- **Limitação aceita:** a validade deixa de ser renovada a cada uso (janela deslizante) e passa a ser fixa a partir da emissão — `ADMIN_SESSION_TTL_HOURS` continua valendo, só que como prazo fixo, não mais renovado.

## Critérios de aceite
- [x] Login emite um JWT válido; `/auth/me` e demais rotas autenticadas aceitam.
- [x] Logout revoga o token imediatamente (uso depois do logout → 401).
- [x] Resetar senha / remover acesso derruba a sessão ativa da pessoa na hora (não só na próxima expiração).
- [x] Trocar a própria senha gira a sessão: a nova sobrevive, as antigas são revogadas.
- [x] Token com assinatura inválida, expirado ou de outro segredo → 401.
- [x] Testes unitários do adapter e de integração cobrindo os fluxos acima.
