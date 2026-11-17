# Spec 0011 — Página da base: histórico, busca, importar e testar a IA

## Objetivo
Na aba **O que a IA sabe**, a equipe mantém a base sozinha: encontra e organiza os assuntos, vê e desfaz mudanças, carrega o documento preenchido e testa a resposta da IA antes de salvar.

## Design
- **Histórico de versões:** cada salvamento grava uma cópia da base (`knowledge_versions`: academia, versão, itens em JSON, autor, data) na mesma transação que troca os itens. A migration copia a base atual como primeira versão. `GET /knowledge/versions` lista as últimas 50 (versão, autor, data, itens, caracteres); `GET /knowledge/versions/:v` traz os itens. "Restaurar" só carrega a versão no editor; quem salva cria uma versão nova (nada é apagado). O autor é o e-mail de quem salvou, ou "importador".
- **Busca e organização** (só na tela): busca por palavra em assunto e conteúdo, com contagem; índice dos assuntos para pular até um deles; botões para subir e descer itens. A ordem salva é a ordem da tela.
- **Importar o documento:** enviar o `.md` exportado. `POST /knowledge/import/preview` devolve o que o parser de 0009 leu (itens, pendências, avisos, horário da recepção, horários da experimental). "Usar no editor" troca os itens da tela pelos do documento, sem salvar. "Criar horários da experimental" chama `POST /knowledge/import/schedule` com o mesmo texto (semanas: 4), sem duplicar. O horário da recepção é mostrado com link para Configurações.
- **Testar a IA:** `POST /knowledge/test` com a pergunta e os itens da tela (inclusive não salvos). Roda o agente de verdade com ferramentas de mentira: nada é gravado, agendado ou transferido; a resposta diz o texto e quais ferramentas a IA teria usado. Limite de 30 testes por hora por pessoa. Sem `LLM_API_KEY` na API, responde 503 com mensagem clara.

## Critérios de aceite
- [x] Salvar cria versão com autor; versões são por academia; restaurar e salvar gera versão nova.
- [x] Busca, índice e reordenação funcionam no celular; a ordem persiste.
- [x] Pré-visualização do documento e criação de horários pelo painel, sem duplicar.
- [x] Teste da IA sem efeitos colaterais, com limite por pessoa e 503 sem chave.
- [x] Testes unitários e de integração.
