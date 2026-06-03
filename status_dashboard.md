# Dashboard Trilogia Financeira — Estado de produção

> Produção: `dashboard.flaviaschusciman.com` (GitHub Pages → CNAME)
> Última atualização: 03/06/2026

---

## Infraestrutura

| Camada | Tecnologia |
|---|---|
| Frontend | HTML/CSS/JS estático no GitHub Pages |
| Auth | Firebase Auth (e-mail + senha) |
| Banco | Firestore (orçamento, patrimônio, reservas, perfil, histórico, cobranças, contratos, scores) |
| Planilhas | Google Sheets por mentorada (backup fire-and-forget pós-migração Firestore) |
| Backend | Cloud Functions v2 (Node 22, southamerica-east1) |
| E-mail | Gmail SMTP via App Password (nodemailer) |
| Drive | Google Drive OAuth2 (cria planilha na conta da Flávia) |
| Pagamentos | Kiwify webhook |
| CRM notas | Notion API |
| PWA | Service Worker v16 + manifest v2 + ícones PNG |

---

## Deploy — CRÍTICO

| O que muda | Comando |
|---|---|
| HTML/JS/CSS | `git push origin main` no repo `flaviasch/trilogia-dashboard` → GitHub Pages ✅ |
| Cloud Functions | `firebase deploy --only functions:nomeDaFuncao` |
| Índices Firestore | `firebase deploy --only firestore:indexes` |
| `firebase deploy --only hosting` | ❌ NÃO — vai para trilogia-dashboard.web.app (dev) |

**Após qualquer mudança no api.js:** verificar que `api.js?vX` está na mesma versão em TODAS as páginas HTML. Versão atual: **v14**.

---

## Kiwify — Produtos e Preços (Jun/2026)

| Produto | Plano | Valor | dataExpiracao |
|---|---|---|---|
| Dashboard Trilogia | Mensal | R$147 | +1 mês |
| Dashboard Trilogia | Anual | R$1.470 | +12 meses |
| Dashboard + Clube | Fundadoras Mensal | R$67 | +1 mês |
| Dashboard + Clube | Fundadoras Anual | R$670 | +12 meses |
| Dashboard + Clube | Mensal | R$197 | +1 mês |
| Dashboard + Clube | Anual | R$1.970 | +12 meses |

**Lógica:** `valorRecebido >= 500` → anual (+12 meses); senão → mensal (+1 mês). Implementado no `kiwifyWebhook` para novas mentoradas. Mentoradas existentes: usa `periodicidade` do contrato via `pagarParcela`.

---

## PWA — estado atual

- **manifest.json**: `"id": "/index.html"`, dois ícones separados (`"purpose": "any"` e `"purpose": "maskable"`)
- **sw.js**: v16, cache `trilogia-v16`, corrige `icon-512-v2.png`
- Instalação funcionando: botão "📥 Baixar app" instala como PWA; "Adicionar atalho" cria atalho

---

## Score de Saúde Financeira (Jun/2026)

Score mensal 0-100 com 4 dimensões:
- **Sobra** (30%): % da receita que sobrou
- **Aporte** (35%): % do planejado que foi efetivado
- **Orçamento** (25%): categorias com limite que não estouraram
- **Regularidade** (10%): tem lançamentos no mês

Níveis: 🔴 0-39 / 🟡 40-59 / 🟢 60-79 / ⭐ 80-100

**Onde aparece:**
- `orcamento.html` → widget acima dos cards de resumo (só mês atual)
- `index.html` → card antes da seção de Reservas
- `orcamento.html` aba Anual → coluna Score na tabela

**Storage:** `mentoradas/{uid}/scores/{YYYY-MM}` + campo `scoreMes` no doc principal
**Functions:** `salvarScoreMes` (fire-and-forget do frontend) + `getScoreHistorico` (lido pela aba Anual)

---

## Onboarding — index.html

5 passos verificados no `checkOnboarding(data)` a cada carregamento:

| # | Passo | Condição de conclusão | Página |
|---|---|---|---|
| 1 | Perfil de investidor | `data.perfil?.perfil` existe | perfil.html |
| 2 | Patrimônio | `data.patrimonio?.ativos > 0` | patrimonio.html |
| 3 | Reservas | `data.reservas.length > 0` | reservas.html |
| 4 | Orçamento do mês | `data.orcamento?.receita > 0` | orcamento.html |
| 5 | Primeiro aporte | `data.orcamento?.aporte > 0` | orcamento.html |

**Lógica de exibição:**
- `totalDone === 0` → exibe `welcomeScreen` (tela de boas-vindas com lista dos 5 passos); aceita LGPD inline, sem modal
- `totalDone > 0` → exibe `mainContent`; se `totalDone < 5` mostra banner `setupProgress` com progresso
- `totalDone === 5` → mainContent limpo, sem banner

---

## Gráfico Aportes Realizados × Planejados — orcamento.html (aba Resumo)

**Fonte dos dados:**
- `carregarHistoricoAnual(ano)` chama `buscarPeriodo(m, ano)` para cada mês → soma `data.aportes` → array `historicoAtual = [{mes, valor, temDados}]`
- Carregado em background após o primeiro render; armazenado em `let historicoAtual`

**Dois datasets (Chart.js misto bar + line):**

| Dataset | Tipo | Cor | Cálculo |
|---|---|---|---|
| Realizado (acumulado) | Barra | Dourado `#CFAE65` | Soma cumulativa de `historicoAtual[m].valor` a partir do 1º mês com dados |
| Planejado (acumulado) | Linha | Verde `#4ade80` | Por mês: soma de `r.aporte` de todas as reservas onde `acumulado < meta && aporte > 0 && dataInicioAporte <= mesStr` — depois acumulado |

**Regra do planejado:** só inclui reservas ainda não atingidas, com aporte mensal definido, e cujo `dataInicioAporte` já passou. Reservas com `dataInicioAporte` futura entram nos meses corretos.

**Instância Chart.js:** `graficoInstance` — destruída e recriada a cada `renderGrafico(historico)`.

---

## Funcionalidades implementadas — orcamento.html

### Abas
- **Resumo**: cards (Receita/Despesa/Sobra/Aporte), score widget, banner alertas de limite, receitas/despesas colapsáveis, sobra box, strip de aporte, ritmo de aportes, gráfico acumulado
- **Planejamento**: limites por categoria, alertas 80%/100%, copiar mês anterior
- **Gráficos**: pizza de despesas + tabela de tendência 3 meses
- **Detalhe**: grupos de categoria com limites, busca em tempo real, delta vs mês anterior
- **Anual**: KPIs do ano, gráfico receita×despesa×sobra, tabela mensal com score

### Funcionalidades de lançamento
- Importação CSV do Raio-X
- Lançamento manual
- Botão "📱 Importar notificação do banco" (SMS parser: extrai valor, data, categoria)
- Botão "+ Lançar manualmente"
- Despesas fixas (recorrentes): cadastro, lançamento automático, editar só este mês vs próximos
- Cartões de crédito: dia de corte, cálculo automático de fatura

### Outras funcionalidades
- Exportação PDF do mês (`window.print()` com CSS dedicado)
- Banner de alertas de limite na aba Resumo (automático quando categoria ≥ 80% do limite)
- Comparativo mês atual × anterior por categoria (aba Detalhe)
- ViewAs (admin visualizando mentorada)
- **Cache de navegação de mês** (`_periodoCache` Map): navegar para mês já visitado não dispara nova requisição; invalidado automaticamente após qualquer save
- **Abas Anual/Gráficos usam cache**: `renderAnual`, `carregarHistoricoAnual` e `carregarTendencia` chamam `buscarPeriodo()` em vez de `getOrcamento()` direto
- **Campo `origem` nos lançamentos**: `'manual'` | `'csv'` | `'recorrente'`; CSV preserva entradas manuais e recorrentes
- **Tratamento de erro padronizado**: `msgErro(err)` em `api.js` v14; erros em português; falhas silenciosas → toast

---

## Cloud Functions — lista completa (Jun/2026)

### Dashboard mentorada
`getDashboard`, `getDashboardHome`, `getOrcamento`, `saveOrcamento`, `getPatrimonio`, `savePatrimonio`, `aportePatrimonio`, `getHistoricoPatrimonio`, `upsertHistoricoPatrimonio`, `saveDivida`, `deleteDivida`, `getReservas`, `saveReserva`, `deleteReserva`, `getPerfil`, `savePerfil`, `registrarAcesso`, `aceitarLGPD`

### Score
`salvarScoreMes`, `getScoreHistorico`

### Admin
`getMentoradas`, `createMentorada`, `updateMentorada`, `bloquearMentorada`, `reativarMentorada`, `deletarMentorada`, `reenviarAcesso`, `criarPlanilha`, `bootstrapAdmin`, `setAdminClaim`

### Contratos & cobranças
`createContrato`, `editarContrato`, `getContratos`, `pagarParcela`, `editarPagamento`, `cancelarCobranca`, `cancelarContrato`, `getCobrancas`

### Notion CRM
`getNotionCRM`

### Kiwify
`kiwifyWebhook` — POST público

### Scheduled (crons)
| Função | Horário | O que faz |
|---|---|---|
| `notifExpiracaoProxima` | 07h diário | Avisa expirações em 7 dias |
| `verificarExpiracoes` | 09h diário | Bloqueia contas expiradas (exceto `assinaturaDashboard: true`) |
| `notifCobrancasDia` | 08h diário | E-mail Flávia com cobranças do dia |
| `notifDia1` | Dia 1, 08h | Orçamento + perfil + renovação |
| `notifDia28` | Dia 28, 08h | Lembrete aporte |
| `notifMaioIR` | 5 mai, 08h | Lembrete IR |
| `limparDadosExpirados` | Dia 1, 09h30 | Apaga planilhas de mentoradas deletadas há 12+ meses (LGPD) |

### Misc
`registrarEvento`, `getCategoriasMes`, `saveCategoriasMes`, `getRecorrentes`, `saveRecorrente`, `deleteRecorrente`, `getCartoes`, `saveCartao`, `deleteCartao`, `syncDiagnosticoWebhook`, `salvarScoreMes`, `getScoreHistorico`

---

## Firestore Indexes (Jun/2026)

Todos deployados em `firestore.indexes.json`:
- `cobrancas`: uidMentorada+contratoId+numero, uidMentorada+vencimento
- `mentoradas`: status+dataExpiracao, dataExpiracao+assinaturaDashboard
- `contratos` (COLLECTION_GROUP): criadoEm DESC
- `pushSubscriptions` (COLLECTION_GROUP): atualizadoEm DESC
- `reservas`: criadoEm ASC
- `historico`: data ASC
- `scores` (COLLECTION_GROUP): calculadoEm DESC

---

## Secrets (Firebase Secret Manager)

| Secret | Uso |
|---|---|
| `GMAIL_APP_PASSWORD` | SMTP Gmail |
| `GOOGLE_CLIENT_ID/SECRET` | OAuth2 Drive/Sheets |
| `GOOGLE_REFRESH_TOKEN` | OAuth2 refresh (versão 9) |
| `DRIVE_FOLDER_ID` | Pasta no Drive da Flávia |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Leitura de planilhas |
| `NOTION_TOKEN` | getNotionCRM |
| `DIAGNOSTICO_WEBHOOK_SECRET` | syncDiagnosticoWebhook — Apps Script já atualizado (02/06/2026) |
| `KIWIFY_WEBHOOK_SECRET` | kiwifyWebhook (verificar se Kiwify envia token — pendente) |

---

## Webhooks externos — URLs atualizadas (02/06/2026)

| Webhook | URL atual (southamerica-east1) | Status |
|---|---|---|
| Kiwify → Dashboard Trilogia | `https://southamerica-east1-trilogia-dashboard.cloudfunctions.net/kiwifyWebhook` | ✅ Atualizado |
| Apps Script (Diagnóstico) | `https://southamerica-east1-trilogia-dashboard.cloudfunctions.net/syncDiagnosticoWebhook` | ✅ Atualizado |

---

## Pendências técnicas (ação manual da Flávia)

1. **Token Kiwify**: verificar em Configurações → Webhooks se existe campo "Token" e rodar `firebase functions:secrets:set KIWIFY_WEBHOOK_SECRET`
2. **CONTEXTO.md linha 4**: ainda diz "encontro 7" — deveria ser "encontro 3"

---

## Site flaviaschusciman.com — estado (Jun/2026)

- Hub `index.html`: esteira com Dashboard (substituiu Clube), card Acompanhamento atualizado
- `pagina-vendas/dashboard/`: página de vendas completa (4 planos, seção app, posicionamento visual+comportamental)
- `pagina-vendas/clube/`: redirect automático → `/dashboard/`
- Pendente: página do Raio-X Financeiro, reposicionar Mapa da Reserva

---

## Plano de ação — estado final (Jun/2026)

**13 de 13 itens concluídos.**
Próxima ação relevante: quando pronto para WhatsApp → registrar número dedicado + conta Meta Business verificada.

---

## Lições operacionais críticas

- **Deploy correto**: `git push origin main` no repo `flaviasch/trilogia-dashboard` (NÃO `firebase deploy --only hosting`)
- **api.js versão**: manter sincronizado em todos os HTMLs — **v14 atual**
- **PWA install**: `"purpose": "any maskable"` combinado quebra instalação — sempre separar em dois registros
- **Link de redefinição de senha**: expira em 72h; gerar novo link invalida o anterior imediatamente
- **Índice Firestore novo**: sempre adicionar em `firestore.indexes.json` + `firebase deploy --only firestore:indexes`
- **SyntaxError silencioso**: `const`/`let` redeclarado no mesmo escopo → script inteiro para de executar sem mensagem visível; abrir F12 → Console quando spinner travar
- **Testar após cada mudança**: verificar que a página principal carrega antes de continuar
- **Rollback**: `git revert HEAD --no-edit && git push` para frontend; guia completo no `CLAUDE.md`
