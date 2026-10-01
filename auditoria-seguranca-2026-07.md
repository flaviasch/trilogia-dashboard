# Auditoria de Segurança e LGPD — Dashboard Trilogia Financeira
Data: 06/07/2026
Escopo: repositório `dashboard` (Cloud Functions, Firestore rules, frontend, dependências). Não cobre configuração de infraestrutura fora do repo (ex: permissões reais do Google Cloud Console, políticas de IAM do projeto Firebase).

## Resumo
5 achados relevantes: 1 crítico, 2 altos, 3 médios. O crítico exige ação imediata (credencial Google em texto plano numa pasta sincronizada com a nuvem). Nada indica comprometimento já ocorrido — são riscos de exposição, não evidência de exploração.

## Achados

### 🔴 Crítico

- **Refresh token e client ID do Google em texto plano, dentro de pasta sincronizada com OneDrive** — `functions/tmp_client_id.txt`, `functions/tmp_folder_id.txt` e `functions/tmp_refresh_token.txt` contêm credenciais reais (datadas de 05/mai), não estão no `.gitignore` nem foram commitadas no git (isso é bom — não vazaram para o GitHub), mas como a pasta inteira do dashboard é sincronizada via OneDrive, esses arquivos estão replicados na nuvem da Microsoft sem controle adicional. Esse refresh token dá acesso ao Drive onde ficam **todas** as planilhas de patrimônio/dívidas/reservas das mentoradas — não é um risco isolado.
  Recomendação: apagar os 3 arquivos assim que não forem mais necessários para debug; se o refresh token ainda for válido, revogar o acesso em https://myaccount.google.com/permissions e gerar um novo via `scripts/gerar-refresh-token.js` salvando direto no Secret Manager, nunca em arquivo solto.

### 🟠 Alto

- **`nodemailer` desatualizado (`^6.9.0`, resolvendo para versão vulnerável) — 8 CVEs conhecidas**, incluindo "Email to an unintended domain due to Interpretation Conflict" (GHSA-mm7p-fcc7-pg87) e injeção de comando SMTP via CRLF. Como esse pacote envia e-mails com dado financeiro e o link de definição de senha de boas-vindas, uma falha de parsing de endereço pode, em tese, desviar um e-mail sensível para destinatário errado.
  Recomendação: `npm install nodemailer@latest` em `functions/` e rodar os testes de envio antes do próximo deploy.

- **Vulnerabilidades altas em dependências indiretas** — `@grpc/grpc-js` (crash por requisição malformada), `form-data` (injeção CRLF) e `protobufjs` (DoS via expansão recursiva), puxadas por `firebase-admin`/`googleapis`. Risco principal é de disponibilidade (serviço cair), não de confidencialidade direta.
  Recomendação: `npm audit fix` em `functions/` resolve a maioria; os que pedirem major bump (`firebase-admin` → 14.x) planejar como tarefa separada, testando as Cloud Functions após o upgrade.

### 🟡 Médio

- **`CLAUDE.md` desatualizado sobre o `kiwifyWebhook`** — a documentação do projeto diz "sem autenticação por token ainda", mas o código (`functions/index.js`, linhas 3273–3304) já implementa verificação HMAC-SHA256 obrigatória com `timingSafeEqual`. Isso é uma boa notícia de segurança, mas a documentação errada pode levar a decisões erradas (ex: alguém "corrigir" um problema que não existe mais, ou não perceber se a verificação for removida por engano no futuro).
  Recomendação: atualizar a seção do `kiwifyWebhook` no `CLAUDE.md`.

- **14 vulnerabilidades moderate acumuladas** nas dependências do Google Cloud SDK (`@google-cloud/common`, `@google-cloud/firestore`, `@google-cloud/storage` etc.). Nenhuma tem exploit crítico conhecido hoje, mas é dívida técnica que cresce a cada mês sem atualização.
  Recomendação: incluir `npm audit` como checagem de rotina (ex: antes de cada deploy de functions, ou na cadência trimestral desta auditoria).

- **Planilha da mentorada permanece no Drive após exclusão da conta** (`deletarMentorada` remove Auth + Firestore, mas não a planilha Sheets) — já era um comportamento documentado, mas do ponto de vista de LGPD é um ponto de retenção sem prazo definido. Se uma mentorada pedir exclusão total dos dados, hoje a planilha com histórico financeiro dela continua existindo indefinidamente no Drive da Flávia.
  Recomendação: definir um prazo de retenção (ex: 90 dias) e um processo — manual ou automatizado — para excluir ou arquivar a planilha depois desse prazo.

## Sem achados relevantes

- **Firestore rules** — padrão deny-by-default correto; coleções sensíveis (`mentoradas`, `orcamento`, `rateLimit`, logs de LGPD) só são acessíveis via Admin SDK (Cloud Functions), nunca direto do cliente.
- **Concessão de admin** (`setAdminClaim`, `bootstrapAdmin`) — restrita ao e-mail master, com checagem server-side antes de qualquer alteração de claim.
- **Guard client-side** (`js/admin-guard.js`) — usado só para UX (redirecionar quem não é admin); a autorização real está no backend, que é o padrão certo.
- **Consentimento LGPD** — `lgpdAceite` é registrado com timestamp antes do uso do dashboard.

## Plano de ação

| # | Ação | Prazo | Status |
|---|---|---|---|
| 1 | Apagar `functions/tmp_client_id.txt`, `tmp_folder_id.txt`, `tmp_refresh_token.txt`. Se o refresh token ainda for válido, revogar em myaccount.google.com/permissions e gerar um novo via `scripts/gerar-refresh-token.js`, salvando direto no Secret Manager (nunca em arquivo solto). | até 05/08/2026 | **Parcial** — arquivos apagados em 06/07. Falta revogar/rotacionar o token no Google (isso só você faz, exige login no navegador) |
| 2 | `npm install nodemailer@latest` em `functions/` e testar envio de e-mail antes do próximo deploy. | até 05/08/2026 | **Feito** — `package.json` atualizado para `^9.0.3`, API de envio (`createTransport`/`sendMail`) confirmada compatível. Sem teste automatizado de envio real — mandar um e-mail de teste manualmente antes do próximo deploy |
| 3 | `npm audit fix` em `functions/` para os itens altos/moderados restantes (`@grpc/grpc-js`, `form-data`, `protobufjs`); avaliar upgrade major do `firebase-admin` (→14.x) como tarefa separada, testando as functions depois. | próxima revisão trimestral | **Parcial** — os 4 altos foram resolvidos (0 restantes). Restam 11 moderate presos ao upgrade major do `firebase-admin`, que fica pra tarefa separada |
| 4 | Corrigir a seção do `kiwifyWebhook` no `CLAUDE.md` (documentação diz que não há autenticação; o código já implementa HMAC-SHA256 obrigatório). | sem urgência | **Feito** |
| 5 | Definir prazo de retenção para a planilha de mentorada excluída e um processo de exclusão/arquivamento depois desse prazo. | próxima revisão trimestral | **Decidido, implementação futura** — ver "Decisão: retenção e reativação" abaixo |

### Decisão: retenção e reativação (06/07/2026)

- Pausa/inadimplência (mentorada pode voltar): usar `bloquearMentorada` / `reativarMentorada`, que já preservam Firestore e planilha sem perda de dado. Não é o mesmo fluxo de exclusão — não confundir os dois.
- Exclusão de verdade (pedido LGPD): `deletarMentorada` vai passar a fazer soft delete — desativa o Auth na hora (perde acesso imediato) e marca `deletada: true` com timestamp, mas só apaga Firestore + planilha depois de **30 dias de carência** (cron diário nos moldes do `verificarExpiracoes`). Dentro da carência, reativar é reabilitar o Auth e desmarcar o flag, sem perda de dado. Depois dos 30 dias, é definitivo — se ela quiser voltar depois disso, é onboarding novo.
- Durante a carência, a mentorada `deletada: true` precisa ficar fora de qualquer fluxo ativo (crons de lembrete, e-mails, listagem padrão do admin) — senão não é uma exclusão de verdade aos olhos dela.
- Se a mentorada pedir uma cópia dos dados dela (portabilidade), isso é independente do fluxo acima: baixar a planilha do Drive como XLSX e enviar, a qualquer momento que ela pedir.
- **Status: decisão registrada, código ainda não implementado.** Entra no próximo ciclo de desenvolvimento, não nesta rodada.

Os itens 1 e 2 já têm lembrete automático agendado para 05/08/2026 (acompanhamento de 30 dias). Os itens 3, 4 e 5 entram na revisão trimestral recorrente (próxima: 01/10/2026).

## Próxima revisão sugerida

Por causa do achado crítico, recomendo uma **revisão de acompanhamento em 30 dias (até 05/08/2026)** só para confirmar que as credenciais foram removidas/rotacionadas e o `nodemailer` atualizado. Depois disso, dado que o dashboard lida com dado financeiro sensível de várias mentoradas, a cadência regular recomendada é **trimestral**.
