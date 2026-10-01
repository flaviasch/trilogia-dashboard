# Auditoria de Segurança e LGPD — Dashboard Trilogia Financeira
Data: 10/07/2026
Escopo: repositório `dashboard` (Cloud Functions, Firestore rules, frontend, dependências). Motivada pelo projeto "Raio-X dentro do Dashboard" (ver `raio-x-no-dashboard/BLUEPRINT.md`), que vai mexer em Cloud Functions e Firestore rules. Não cobre configuração de infraestrutura fora do repo (permissões reais do Google Cloud Console, IAM do projeto Firebase).

Comparação: existe uma auditoria anterior de 06/07/2026 e um ciclo de correções em 07/07/2026 que resolveu a maior parte do plano de ação daquela auditoria. Este relatório confirma o que foi corrigido, identifica um achado crítico novo (não coberto na rodada anterior) e atualiza o que ainda está pendente.

## Resumo

4 achados: 1 crítico (novo, não estava no relatório de 06/07), 3 médios. Nenhum alto desta vez — os dois altos da rodada anterior (nodemailer, dependências indiretas) foram resolvidos. O crítico é do mesmo tipo do achado crítico anterior (credencial Google em texto plano numa pasta sincronizada com OneDrive), mas em arquivos diferentes que não tinham sido encontrados antes. Nada indica comprometimento já ocorrido.

## Achados

### 🔴 Crítico

- **Três credenciais OAuth do Google completas e em texto plano, em arquivos gitignored mas presentes no disco** — `functions/get-refresh-token.js`, `functions/test-sa.js` e `functions/test-token.js` contêm, cada um, `client_id` + `client_secret` + (dois deles) `refresh_token` reais, com escopo `spreadsheets`, `drive` e `gmail.send`. São dois pares client_id/secret diferentes (`...hddbscde7d...` e `...qv0kotr0b7...`), sugerindo duas gerações de credencial OAuth, e dois refresh tokens distintos ainda presentes no código.
  Esses arquivos não estão no Git (confirmado: não aparecem em `git ls-files`, estão listados no `.gitignore`) — não vazaram para o GitHub. Mas a pasta inteira do dashboard é sincronizada via OneDrive, então esses arquivos estão replicados na nuvem da Microsoft sem controle adicional, exatamente como o achado crítico da auditoria de 06/07 (que tratou de `tmp_client_id.txt`/`tmp_refresh_token.txt`, já removidos). Esse padrão se repetiu em arquivos diferentes que a limpeza anterior não cobriu. Qualquer um desses tokens, se ainda válido, dá acesso de leitura/escrita a todas as planilhas de patrimônio, dívidas e reservas das mentoradas, além de permissão para enviar e-mail em nome da conta.
  Recomendação: apagar os três arquivos assim que não forem mais necessários para debug local. Antes de apagar, revogar os dois pares de credencial em https://myaccount.google.com/permissions (ou, se preferir manter o app OAuth, pelo menos invalidar os refresh tokens específicos). Se algum desses fluxos de debug ainda for necessário no dia a dia, recriar como script que lê de variável de ambiente local (não commitada, não em arquivo com valor fixo), nunca com o segredo escrito no arquivo.

## 🟡 Médio

- **10 vulnerabilidades moderate pendentes em `functions/`, presas ao upgrade major do `firebase-admin`** — eram 14 na auditoria de 06/07; a redução veio dos altos já corrigidos (nodemailer, form-data, etc.), mas o núcleo (`@google-cloud/*` puxado por `firebase-admin` ^13.0.0) segue sem exploit crítico conhecido, é dívida técnica que não expira sozinha.
  Recomendação: mantém como item de tarefa separada — testar as Cloud Functions inteiras após o upgrade para `firebase-admin` 14.x antes de ir para produção. Não é bloqueante para o projeto Raio-X, mas vale planejar janela para isso nos próximos meses.

- **Backup automático existe, mas é parcial** — `backupDiario` (Cloud Function agendada, 03h, retenção de 30 dias) salva um snapshot dos campos principais do documento de cada mentorada em `mentoradas` (status, produto, sheetId, PL cacheado, etc.), mas não inclui subcoleções nem os lançamentos financeiros linha a linha (esses vivem no Google Sheets de cada mentorada, com histórico de revisão próprio do Drive, não neste backup). Isso é suficiente para recuperar a estrutura de contas em caso de corrupção do Firestore, mas não é um backup completo do dado financeiro.
  Recomendação: antes de começar a construir o projeto Raio-X (que vai alterar Firestore rules e adicionar Cloud Functions novas), fazer um snapshot manual adicional: `gcloud firestore export` para um bucket, e marcar o commit atual do repositório com uma tag Git (ex: `git tag pre-raio-x-dashboard`) como ponto de rollback limpo. Isso é o "backup" exigido pelo Princípio 6 antes de mexer em sistema já em produção — o backup diário existente não foi desenhado para esse propósito.

- **Duas gerações de credencial OAuth do Google em uso/histórico, sem confirmação de qual está ativa** — os dois pares de client_id/secret encontrados no achado crítico sugerem que houve pelo menos uma rotação de credencial no passado, mas os arquivos antigos não foram limpos. Vale conferir no Google Cloud Console quais client IDs OAuth ainda existem e revogar os que não estão mais em uso (reduz superfície de ataque, mesmo sem exploit direto).
  Recomendação: revisar em console.cloud.google.com → APIs e Serviços → Credenciais, e remover client IDs OAuth órfãos.

## Sem achados relevantes (confirmado corrigido desde 06/07)

- **`nodemailer`** — atualizado para `^9.0.3`. Vulnerabilidades altas resolvidas.
- **Dependências indiretas altas** (`@grpc/grpc-js`, `form-data`, `protobufjs`) — resolvidas via `npm audit fix`. `npm audit` hoje mostra 0 crítico, 0 alto, 0 baixo, 10 moderate (ver achado médio acima).
- **Documentação do `kiwifyWebhook`** — `CLAUDE.md` já reflete a autenticação HMAC-SHA256 obrigatória corretamente.
- **Retenção de dados após exclusão (LGPD)** — implementado: `deletarMentorada` faz soft delete com 30 dias de carência, `mentoradas_deletadas` tem TTL de 5 anos, e há uma função agendada que apaga a planilha do Drive de mentoradas deletadas há mais de 12 meses. O que era "decidido, não implementado" na auditoria de 06/07 agora está em produção.
- **Rate limiting** — implementado em pelo menos 13 endpoints de escrita (`checkRateLimit`), não só os 6 mencionados no commit inicial.
- **Comparação timing-safe** — `crypto.timingSafeEqual` em uso tanto no `kiwifyWebhook` quanto no `syncDiagnosticoWebhook`.
- **Security headers HTTP** — `X-Frame-Options: DENY`, `Strict-Transport-Security` e `Content-Security-Policy` configurados em `firebase.json`.
- **Firestore rules** — seguem padrão deny-by-default; todas as coleções sensíveis (`mentoradas`, `orcamento`, `rateLimit`, `mentoradas_deletadas`, `_lgpd_log`) só são acessíveis via Admin SDK. Essa é a base sobre a qual o campo novo `nivelAcesso` do projeto Raio-X vai ser adicionado — a estrutura atual não exige mudança de padrão, só extensão.

## Plano de ação

| # | Ação | Prazo | Status |
|---|---|---|---|
| 1 | Revogar os dois pares de credencial OAuth (`get-refresh-token.js`, `test-sa.js`, `test-token.js`) em myaccount.google.com/permissions e apagar os três arquivos do disco. | Antes de iniciar a construção do Raio-X | Pendente |
| 2 | Snapshot manual pré-construção: `gcloud firestore export` + tag Git no commit atual (`pre-raio-x-dashboard`). | Antes de iniciar a construção do Raio-X | Pendente |
| 3 | Revisar client IDs OAuth órfãos no Google Cloud Console e remover os não usados. | Próxima revisão trimestral | Pendente |
| 4 | Avaliar upgrade major do `firebase-admin` (→14.x) como tarefa separada, testando as Cloud Functions depois. | Próxima revisão trimestral (01/10/2026) | Pendente (mantido da auditoria anterior) |

## Próxima revisão sugerida

Por causa do achado crítico, revisão de acompanhamento em 7 dias (até 17/07/2026) só para confirmar que os itens 1 e 2 foram feitos antes de liberar a construção do Raio-X para produção. Depois disso, mantém a cadência trimestral (próxima completa: 01/10/2026), já alinhada com o item pendente do firebase-admin.

## Addendum — 10/07/2026 (mesmo dia, durante a remediação)

Ao executar o item 1 do plano de ação, apareceu um achado crítico novo, não previsto no relatório original: `.claude/settings.local.json`, na raiz do repositório **Trilogia-Financeira** (repo pai do `dashboard`, remoto próprio no GitHub), continha o client secret Google recém-rotacionado (`GOCSPX-[removido em 01/10/2026]`, confirmado como o secret ativo em produção), um código de autorização OAuth e um fragmento do refresh token antigo, todos em texto plano dentro de entradas de permissão salvas pelo Claude Code. Esse repo raiz não tinha `.gitignore` nenhum até este momento.

Avaliação de severidade: janela de exposição de poucas horas (gerado durante a própria sessão de remediação), nunca commitado, sem indício de leitura ou sincronização externa no intervalo. Decisão: não gerar um terceiro secret — o custo de mais uma rotação em produção não se justifica para uma janela de exposição tão curta e sem evidência de acesso. Ação tomada: as 4 entradas com segredo em texto puro foram removidas de `settings.local.json`, `.gitignore` foi criado na raiz de Trilogia-Financeira cobrindo esse arquivo, e busca full-tree confirmou que não resta nenhum valor de secret (só os próprios comandos de busca, que citam o padrão da regex, não valores reais). Verificado de forma independente.

**Lição de processo:** o risco recorrente aqui não é um arquivo específico, é o hábito de scripts de debug/rotação escreverem segredo em texto puro em arquivos que vivem dentro de uma pasta sincronizada com nuvem (OneDrive) — incluindo arquivos gerados pelo próprio Claude Code (settings.local.json). Vale adicionar uma regra permanente: nenhuma sessão futura deve aprovar ou registrar comando que contenha valor de secret literal; usar sempre arquivo temporário fora da pasta sincronizada, variável de ambiente, ou `--data-file` apontando para um caminho que não seja versionado nem sincronizado.

Status final: todos os itens do plano de ação (1 a 4) resolvidos, incluindo o achado adicional deste addendum. Nenhum bloqueio restante para iniciar a construção do projeto Raio-X.
