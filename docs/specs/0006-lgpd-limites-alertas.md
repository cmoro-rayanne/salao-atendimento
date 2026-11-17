# Spec 0006 — Opt-out, aviso de privacidade, limite por conversa e alertas

## Objetivo
Fechar o que a arquitetura prevê para o go-live: respeitar quem não quer mensagens ativas, avisar que o atendimento é automatizado, limitar abuso e avisar a RMoro quando algo falha.

## Design
- **Opt-out:** se a mensagem do cliente for só `SAIR` (ou `PARAR`, `STOP`, `DESCADASTRAR`, sem diferenciar maiúsculas e acentos), o worker marca `leads.opted_out_at`, confirma sem chamar a IA e não manda mais lembretes nem mensagens ativas para esse contato. `VOLTAR` desfaz. Conversas iniciadas pelo cliente continuam sendo atendidas.
- **Aviso de privacidade:** a primeira resposta de cada conversa ganha, no fim, um rodapé fixo (não depende da IA): atendimento automatizado, link da política de privacidade (`tenants.privacy_url`, opcional) e como sair dos lembretes.
- **Limite por conversa:** no webhook, antes de agendar a resposta, contador no Redis por conversa: no máximo 20 mensagens por minuto e 150 por dia (configurável). Passou disso, a mensagem é ignorada (fica no Chatwoot para a equipe) e um alerta é enviado uma vez.
- **Alertas:** porta `AlertNotifier`. Adapter por webhook (`ALERT_WEBHOOK_URL`): texto puro (ex.: ntfy.sh, que chega como notificação no celular) ou JSON `{"text": …}` (Slack, Discord, Google Chat) por `ALERT_WEBHOOK_FORMAT`. O mesmo alerta não se repete por 10 minutos. Disparam: job de resposta ou de lembrete na DLQ, falha ao transferir depois de erro, conversa passando do limite.

## Critérios de aceite
- [x] "Sair", "SAIR!" e "sáir" viram opt-out; "quero sair da academia" não (é conversa normal).
- [x] Opt-out confirma sem chamar a IA; lembrete para contato com opt-out não é enviado.
- [x] Rodapé só na primeira resposta; com e sem link de privacidade.
- [x] Mensagens além do limite não geram resposta da IA; alerta enviado uma vez.
- [x] Alerta repetido em 10 minutos é suprimido; falha no envio do alerta não derruba o worker.
- [x] Testes unitários e de integração.
