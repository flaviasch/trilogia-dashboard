# Auditoria de Segurança e LGPD — Dashboard Trilogia Financeira
Data: 24/07/2026
Escopo: repositório `dashboard` (Cloud Functions, Firestore rules, frontend, dependências). Motivada pelo projeto "Dashboard PJ" (ver `dashboard-pj/BLUEPRINT.md`), que vai expor a contas externas o módulo de Impostos Previstos construído nesta mesma leva (`tributosConfig`, `notasEmitidas`, `impostosPrevistos`), hoje admin-only. Não cobre configuração de infraestrutura fora do repo (permissões reais do Google Cloud Console, IAM do projeto Firebase).

Comparação: existe auditoria anterior de 10/07/2026 (`auditoria-seguranca-2026-07-10.md`), com addendum no mesmo dia. Confirmado nesta rodada que os 4 itens do plano de ação anterior foram de fato resolvidos, não só marcados como tal:

- `functions/get-refresh-token.js`, `functions/test-sa.js`, `functions/test-token.js` — confirmados ausentes do disco.
- Snapshot pré-construção do Raio-X — tag Git `pre-raio-x-dashboard` confirmada existente.
- `.claude/settings.local.json` na raiz — verificado sem padrão de secret em texto plano (client_secret, refresh_token, API key) hoje.
- `firebase-admin` — segue em `^13.0.0`, upgrade major ainda pendente (mantido deliberadamente para revisão trimestral, não é regressão).

## Resumo

Nenhum achado crítico nesta rodada. 1 achado alto (não é vulnerabilidade em produção hoje, é o bloqueio de arquitetura já identificado no dossiê de Estrutura, confirmado aqui formalmente antes do build). 3 achados médios, nenhum novo de fato — são continuidade de itens já conhecidos, revisitados porque o projeto Dashboard PJ os torna relevantes de novo.

## Achados

### 🟠 Alto

- **As 3 coleções do módulo de Impostos (`tributosConfig`, `notasEmitidas`, `impostosPrevistos`) não têm segregação por dono** — as 10 Cloud Functions construídas nesta sessão (`getTributosConfig`, `saveTributoConfig`, etc.) usam `requireAdmin` corretamente, sem exposição indevida hoje. O achado é sobre o que vem a seguir: essas coleções não têm campo `uid`, e o Firestore rules (`match /{document=**} { allow read, write: if false; }`) não protege dado algum aqui — o modelo de segurança do projeto inteiro depende 100% dos guards dentro das Cloud Functions, porque o cliente nunca acessa o Firestore direto (confirmado nas rules e no `CLAUDE.md`). Isso significa que não existe uma segunda camada de defesa: se o retrofit para multi-tenant trocar `requireAdmin` por `requireSelfOrAdmin` sem também filtrar as queries por `uid`, uma conta PJ conseguiria ler ou escrever dado de outra sem que as rules bloqueassem nada.
  Recomendação: antes de expor qualquer uma dessas 10 funções a contas não-admin, adicionar `uid` a cada documento das 3 coleções, trocar o guard para `requireSelfOrAdmin(request, uid)`, filtrar toda query por `where('uid', '==', uid)`, e testar manualmente com duas contas de teste que uma não enxerga dado da outra antes de ir para produção.

## 🟡 Médio

- **Backup diário (`backupDiario`) continua parcial e não cobre as coleções do módulo de Impostos** — mesmo achado de 10/07, ainda não resolvido (não era prioridade até agora). `backupDiario` snapshota só os campos principais do documento de cada mentorada em `mentoradas`; `tributosConfig`, `notasEmitidas` e `impostosPrevistos` não entram nesse backup. Hoje o custo de perda é baixo (só dados de teste/seed da própria Flávia). Isso muda quando contas PJ reais começarem a gravar dado ali.
  Recomendação: antes do retrofit, fazer um snapshot manual (`gcloud firestore export` + tag Git, mesmo padrão usado em `pre-raio-x-dashboard`) como ponto de rollback limpo. Depois de multi-tenant estar em produção, avaliar incluir essas 3 coleções no `backupDiario`.

- **12 vulnerabilidades em `functions/` via `npm audit` (1 crítica, 10 moderate, 1 baixa)** — a crítica é em `websocket-driver`, dependência transitiva de `firebase-tools` usado só no script de teste local com emulador (`npm run test`); não entra no bundle de produção das Cloud Functions, risco real baixo. As 10 moderate são as mesmas de sempre, presas ao upgrade major do `firebase-admin` (item 5 do plano de ação, já mantido como pendência trimestral desde 06/07). A baixa é em `body-parser` (DoS de baixa severidade).
  Recomendação: rodar `npm audit fix` em `functions/` para resolver o crítico de dev e a baixa — não bloqueante para o Dashboard PJ, mas barato de fazer.

- **`scripts/` inteiro não está versionado no Git** — confirmado via `git status` (todos os arquivos aparecem como `??`, não rastreados), incluindo agora `seed-tributos-config.js`, criado nesta mesma sessão. Não há segredo em texto plano nesses arquivos (usam `scripts/serviceAccountKey.json`, corretamente no `.gitignore`), então não é vulnerabilidade — é risco operacional: se a pasta local (sincronizada via OneDrive) for perdida ou corrompida, os scripts de administração (criação de conta admin, concessão de claim, seed de tributos) somem sem histórico de versão.
  Recomendação: versionar `scripts/*.js` no Git, mantendo `.env` e `serviceAccountKey.json` de fora (já protegidos hoje).

## Sem achados relevantes (confirmado corrigido desde 10/07)

- Credenciais OAuth em texto plano (`get-refresh-token.js`, `test-sa.js`, `test-token.js`) — arquivos ausentes do disco, confirmado.
- Snapshot pré-construção do Raio-X — tag Git `pre-raio-x-dashboard` existe.
- Secret em `.claude/settings.local.json` (achado do addendum de 10/07) — verificado ausente hoje.
- `kiwifyWebhook` — validação HMAC-SHA256 com `crypto.timingSafeEqual` confirmada em produção.
- Firestore rules — padrão deny-by-default confirmado, sem mudança de postura desde a última auditoria.
- Chave pública do Firebase Web SDK (`js/firebase-config.js`) — não é segredo por design (identifica só o projeto; segurança real é via Cloud Functions + Auth), não é achado.
- Compartilhamento de planilhas Google Sheets (`functions/lib/provisionar.js`) — compartilhado especificamente com a Service Account (`type: 'user'`), sem link público (`type: 'anyone'`) em nenhum ponto do código revisado.

## Plano de ação

| # | Ação | Prazo | Status |
|---|---|---|---|
| 1 | Retrofit multi-tenant das 3 coleções do módulo Impostos: `uid` em cada documento, guard `requireSelfOrAdmin`, filtro `where uid ==` em toda query, teste manual com 2 contas confirmando isolamento. | Antes de iniciar a construção do Dashboard PJ | Pendente |
| 2 | Snapshot manual (`gcloud firestore export` + tag Git) antes do retrofit. | Antes de iniciar a construção do Dashboard PJ | Pendente |
| 3 | `npm audit fix` em `functions/` (crítico de dev + baixa). | Próxima janela de manutenção, não bloqueante | Pendente |
| 4 | Versionar `scripts/*.js` no Git. | Próxima janela de manutenção, não bloqueante | Pendente |
| 5 | Avaliar upgrade major do `firebase-admin` (→14.x), testando as Cloud Functions depois. | Próxima revisão trimestral (01/10/2026) | Pendente (mantido desde 06/07) |

## Próxima revisão sugerida

Sem achado crítico novo, mas os itens 1 e 2 são pré-requisito direto para o início da construção do Dashboard PJ — não pendência solta. Sugiro revisão de confirmação assim que o retrofit estiver pronto, antes de liberar a construção para contas reais (mesmo padrão usado no Raio-X: confirmação pontual, não uma auditoria completa nova). Cadência trimestral geral mantida: próxima completa em 01/10/2026, já alinhada com o item 5.
