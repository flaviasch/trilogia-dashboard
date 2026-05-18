# Dashboard Trilogia Financeira — Guia do projeto

> Leia também `CONTEXTO.md` para detalhes das páginas do frontend da mentorada (patrimônio, reservas, perfil, orçamento).

## O que é

Dashboard financeiro para mentoradas da Mentoria Trilogia Financeira (Flávia Schuscimann, CFP®).
Dois níveis de acesso: **mentorada** (seus dados) e **admin** (Flávia, via `admin.html`).

---

## Deploy — ATENÇÃO

| O que muda | Comando | Vai para |
|---|---|---|
| HTML / JS (qualquer arquivo frontend) | `git add . && git commit -m "..." && git push origin main` | `dashboard.flaviaschusciman.com` ✅ produção |
| Cloud Functions | `firebase deploy --only functions:nomeDaFuncao` | us-central1 ✅ |
| `firebase deploy --only hosting` | ❌ só atualiza `trilogia-dashboard.web.app` | **não é produção** |

- Repositório: `https://github.com/flaviasch/trilogia-dashboard` (branch `main`)
- Produção: GitHub Pages via CNAME → `dashboard.flaviaschusciman.com`
- Firebase projeto: `trilogia-dashboard`

---

## Arquitetura de arquivos

```
dashboard/
├── admin.html              # Painel admin (só Flávia)
├── index.html              # Tela principal da mentorada
├── js/
│   └── api.js              # Todas as chamadas às Cloud Functions (importar com ?v=7)
├── functions/
│   ├── index.js            # Todas as Cloud Functions (v2, Node.js 20)
│   └── lib/
│       ├── auth.js         # requireAuth, requireAdmin, requireSelfOrAdmin
│       ├── mailer.js       # sendEmail + templates de e-mail
│       ├── provisionar.js  # Cria planilha Google Sheets da mentorada
│       └── sheets.js       # SheetsClient — CRUD Google Sheets
├── firestore.rules
└── firestore.indexes.json
```

---

## Cloud Functions (todas em us-central1)

### Mentoradas
| Função | Descrição |
|---|---|
| `getMentoradas` | Lista todas as mentoradas (admin) |
| `createMentorada` | Cria Auth + Firestore + planilha Sheets |
| `updateMentorada` | Atualiza campos permitidos (veja lista abaixo) |
| `bloquearMentorada` | Desabilita no Auth + status inativa |
| `reativarMentorada` | Reabilita no Auth + status ativa |
| `deletarMentorada` | Remove Auth + Firestore |
| `reenviarAcesso` | Reenvia link de definição de senha |

### Contratos & cobranças
| Função | Descrição |
|---|---|
| `createContrato` | Cria contrato + cobranças no Firestore |
| `editarContrato` | Edita produto/forma/periodicidade; se tipo=parcelado e sem parcelas pagas, pode recriar parcelas |
| `getContratos` | Lista contratos de uma mentorada |
| `pagarParcela` | Registra pagamento; gera próxima cobrança se recorrente |
| `editarPagamento` | Corrige valor/data de parcela já paga |
| `cancelarCobranca` | Cancela cobrança individual |
| `cancelarContrato` | Cancela contrato inteiro |
| `getCobrancas` | Cobranças por vencimento (filtra canceladas em memória) |

### Dashboard da mentorada
| Função | Descrição |
|---|---|
| `getDashboard` | Dados da tela principal (orçamento, patrimônio, reservas, perfil) |

### Scheduled (cron)
| Função | Horário | Descrição |
|---|---|---|
| `verificarExpiracoes` | 07h diário | Bloqueia mentoradas com `dataExpiracao` vencida — exceto se `assinaturaDashboard === true` |
| `notifExpiracaoProxima` | 08h diário | Avisa alunas com expiração em 7 dias |
| `notifCobrancasDia` | diário | E-mail para Flávia com cobranças do dia |

### Kiwify (webhook público)
```
POST https://us-central1-trilogia-dashboard.cloudfunctions.net/kiwifyWebhook
```
Configurado no painel Kiwify com os eventos: Compra aprovada, Assinatura cancelada, Assinatura em atraso.

**Atenção ao payload do Kiwify:** usa PascalCase.
- Evento: `body.webhook_event_type` (não `body.event`)
- E-mail: `body.Customer.email`
- Produto: `body.Product.name`
- Valor: `body.Order.amount` ou `body.Subscription.charge_amount`

---

## Campos Firestore — coleção `mentoradas`

| Campo | Tipo | Descrição |
|---|---|---|
| `status` | string | `ativa` / `inativa` / `alerta` |
| `email` | string | Usado para matching no webhook Kiwify |
| `produto` | string | `mentoria` / `private` / `clube` / `dashboard` |
| `dataExpiracao` | string YYYY-MM-DD | Quando o acesso expira (renovado por pagamento de dashboard ou clube) |
| `mentoriaEncerrada` | boolean | true = mentoria encerrada manualmente |
| `assinaturaDashboard` | boolean | true = tem assinatura ativa do produto `dashboard` no Kiwify |
| `nota` | string | Nota interna da Flávia sobre a mentorada |

Campos permitidos em `updateMentorada`: `status`, `nota`, `perfil`, `inicio`, `produto`, `valorMensal`, `formaPagamento`, `dataExpiracao`, `mentoriaEncerrada`, `assinaturaDashboard`.

Constantes importantes em `functions/index.js`:
```js
const PRODUTOS_RECORRENTES = ['clube', 'dashboard']; // estes atualizam dataExpiracao ao pagar
const ADMIN_EMAIL = 'flaviasch@gmail.com';
```

---

## Lógica de acesso ao dashboard

O produto `dashboard` é uma assinatura recorrente independente que mantém o acesso ao painel após o fim da mentoria. Os demais produtos (`mentoria`, `private`, `clube`) dão acesso somente durante o período contratado.

### Webhook Kiwify — comportamento por evento

| Evento | Produto | Ação |
|---|---|---|
| Cancelamento | `dashboard` | Bloqueia Auth + `status: inativa` + `assinaturaDashboard: false` |
| Cancelamento | `mentoria` / `private` / `clube` / desconhecido | Bloqueia Auth + `status: inativa` + `mentoriaEncerrada: true` |
| Atraso | qualquer | `status: alerta` (não bloqueia) |
| Pagamento | `dashboard` | `assinaturaDashboard: true` + reativa Auth/status se estava bloqueada |
| Pagamento | outros | Registra cobrança no Firestore normalmente |

### Job diário `verificarExpiracoes` (07h)
- `dataExpiracao` expirou + `assinaturaDashboard === true` → **mantém acesso** (tem dashboard)
- `dataExpiracao` expirou + sem dashboard → **bloqueia** (inativa no Auth + Firestore)

---

## Painel admin — `admin.html`

### Aba Mentoradas
- Lista com filtros: Todas, Ativas, Com alerta, Sem acesso (14+ dias)
- KPIs: Ativas, MRR (cobranças reais do mês), Alertas, PL médio
- Alertas automáticos (sem marcar manual):
  - 💸 Cobrança vencida
  - 🔴 Acesso expirado
  - ⏳ Expira em ≤ 7 dias
  - 📋 Perfil não preenchido
  - ⚠️ Status alerta manual

### Detalhe da mentorada
- Edição inline: produto, forma de pagamento, data de expiração
- Salvar nota
- Bloquear / Reativar / Deletar / Reenviar acesso
- **Seção Acompanhamento** — lê página Notion da mentorada (último encontro, lições abertas); oculta se `mentoriaEncerrada: true`
- **Contratos:** criar, ver parcelas, registrar pagamento, editar pagamento, cancelar
- **Botão "✎ Editar" no contrato** — edita produto/forma/periodicidade/parcelas (se nenhuma paga)
- **Botão "Fechar mentoria"** (dourado) — abre modal com prompt para `/entregaveis-finais-mentoria`
- **Botão "Marcar como encerrada"** — seta `mentoriaEncerrada: true` sem gerar entregáveis

### Aba Financeiro
- Navegação por mês
- KPIs: Previsto, Recebido, A receber
- Tabela com status por cobrança; botão ✕ cancela cobrança individual

---

## Skills do ecossistema (rodam no Claude Code da Flávia)

- `/email-pos-encontro` — atualiza Notion + cria rascunho de e-mail pós-encontro
- `/entregaveis-finais-mentoria` — gera PDF de evolução + Excel de plano de investimento ao encerrar mentoria
  - Scripts: `scripts/gerar_planilha.py`, `scripts/gerar_relatorio.py`
  - Saída: `[workspace]/FUP/[Nome Completo]/`

## Notion por mentorada
- Página: `🌙 Mentoria Trilogia Financeira - [Nome]`
- MCP Notion: `notion-search` + `notion-fetch` para leitura no painel admin
- Estrutura: Encontro N → tema, data, mapa mental, gravação, alinhamentos, lição de casa, materiais
