# Dashboard Trilogia Financeira — Documentação completa

> Para detalhes de UI das páginas do frontend (patrimônio, reservas, perfil, orçamento) leia também `CONTEXTO.md`.

---

## O que é

Dashboard financeiro pessoal para mentoradas da Mentoria Trilogia Financeira (Flávia Schuscimann, CFP®).
Dois níveis de acesso: **mentorada** (seus próprios dados) e **admin** (Flávia, via `admin.html`).

Produto `dashboard` = assinatura recorrente autônoma que mantém acesso ao painel após o término da mentoria (R$197/mês, cobrado pelo Kiwify).

---

## Deploy — CRÍTICO

| O que muda | Comando correto | Destino |
|---|---|---|
| HTML, JS, CSS (qualquer frontend) | `git add . && git commit -m "..." && git push origin main` | `dashboard.flaviaschusciman.com` ✅ produção |
| Cloud Functions | `firebase deploy --only functions:nomeDaFuncao` | us-central1 ✅ |
| `firebase deploy --only hosting` | ❌ **NÃO usar para produção** | só `trilogia-dashboard.web.app` |

- **Repositório:** `https://github.com/flaviasch/trilogia-dashboard` (branch `main`)
- **Produção:** GitHub Pages via CNAME → `dashboard.flaviaschusciman.com`
- **Firebase projeto:** `trilogia-dashboard`

---

## Estrutura de arquivos

```
dashboard/
├── admin.html              # Painel admin (só Flávia)
├── index.html              # Tela principal da mentorada (cards resumo)
├── orcamento.html          # Orçamento mensal (importação CSV do Raio-X)
├── patrimonio.html         # Ativos, dívidas, balanço patrimonial, evolução PL
├── reservas.html           # Reservas de longo prazo + comparativo de carteira
├── perfil.html             # Perfil de investidor + suitability + impacto nos objetivos
├── login.html              # Autenticação Firebase
├── recuperar-senha.html    # Recuperação de senha
├── ajuda.html              # Tutorial dos 3 agentes + FAQ
├── js/
│   ├── api.js              # Todas as chamadas às Cloud Functions (importar com ?v=7)
│   └── firebase-config.js  # Configuração do Firebase SDK
├── css/                    # Estilos (Navy #0D2B45, Gold #CFAE65, Playfair + Inter)
├── functions/
│   ├── index.js            # Todas as Cloud Functions (v2, Node.js 20)
│   └── lib/
│       ├── auth.js         # requireAuth, requireAdmin, requireSelfOrAdmin, getSheetId
│       ├── mailer.js       # sendEmail + templates HTML de todos os e-mails
│       ├── provisionar.js  # Cria planilha Google Sheets da mentorada no Drive da Flávia
│       └── sheets.js       # SheetsClient — CRUD completo das abas da planilha
├── firestore.rules         # Regras de segurança do Firestore
├── firestore.indexes.json  # Índices compostos
├── firebase.json           # Configuração de hosting, functions, emulators
└── CONTEXTO.md             # Detalhes das páginas do frontend
```

---

## Páginas do frontend (acesso da mentorada)

| Página | O que faz |
|---|---|
| `login.html` | Autenticação com e-mail e senha (Firebase Auth) |
| `recuperar-senha.html` | Envia link de redefinição de senha |
| `index.html` | Tela principal: cards de PL, sobra, reservas, orçamento do mês; aceite de LGPD |
| `orcamento.html` | Importa CSV do Raio-X (categoria, tipo, valor); navega por mês; exibe receitas x despesas; botão de aporte registra valor na classe de ativo |
| `patrimonio.html` | Importa CSV do IR (patrimônio) e CSV da corretora (investimentos); CRUD de dívidas (manual ou CSV); balanço patrimonial (barras); evolução do PL (12 meses) |
| `reservas.html` | CRUD de reservas (nome, meta, acumulado, dataMeta, aporte); alocação sugerida automática por prazo; comparativo carteira sugerida × atual |
| `perfil.html` | Suitability de 5 perguntas → conservador / moderado / arrojado; seção de impacto nos objetivos (reservas > 10 anos); validade de 180 dias |
| `ajuda.html` | Tutorial dos agentes Raio-X, Patrimônio e Investimentos; FAQ de uso do dashboard |

---

## Todas as Cloud Functions

### Dashboard da mentorada

**`getDashboard`** (`onCall`, secrets: GOOGLE_SERVICE_ACCOUNT_JSON)
- Lê da planilha: orçamento do mês, patrimônio IR, investimentos corretora, dívidas, reservas, perfil
- Consolida ativos: posição da corretora sobrescreve IR para mesma classe
- Calcula: PL, sobra, total de reservas
- Cacheia snapshot (pl, sobra, totalReservas) no Firestore em background
- Registra ultimoAcesso, totalAcessos, acessosMes quando é a própria mentorada (não admin visualizando)
- Retorna: { nome, orcamento, patrimonio, reservas, perfil, inicio, lgpdAceite, sheetError }

**`getOrcamento`** — lê orçamento de mês/ano da planilha
**`saveOrcamento`** — salva itens importados do CSV do Raio-X
**`getPatrimonio`** — retorna { ativos (consolidados), dividas }
**`savePatrimonio`** — salva ativos; tipo 'ir' → aba patrimônio, tipo 'corretora' → aba investimentos
**`aportePatrimonio`** — soma valor a uma classe; prioriza aba investimentos se classe existir lá
**`getHistoricoPatrimonio`** — retorna array de 12 meses { data, ativos, dividas, pl }
**`upsertHistoricoPatrimonio`** — grava/atualiza snapshot do mês atual
**`saveDivida`** / **`deleteDivida`** — CRUD de dívidas na planilha
**`getReservas`** / **`saveReserva`** / **`deleteReserva`** — CRUD de reservas
**`getPerfil`** / **`savePerfil`** — lê/grava perfil; savePerfil espelha no Firestore como fallback
**`registrarAcesso`** — atualiza ultimoAcesso + contadores (chamado no load do dashboard)
**`aceitarLGPD`** — registra aceite do termo LGPD com timestamp

### Admin — gestão de mentoradas

**`getMentoradas`** — lista todas as mentoradas ordenadas por nome
**`createMentorada`** — cria: (1) conta Firebase Auth com senha temporária, (2) planilha Sheets no Drive da Flávia, (3) documento Firestore, (4) e-mail de boas-vindas com link de definição de senha
**`updateMentorada`** — atualiza campos permitidos: `status`, `nota`, `perfil`, `inicio`, `produto`, `valorMensal`, `formaPagamento`, `dataExpiracao`, `mentoriaEncerrada`, `assinaturaDashboard`
**`bloquearMentorada`** — desabilita no Firebase Auth + status: inativa
**`reativarMentorada`** — reabilita no Firebase Auth + status: ativa
**`deletarMentorada`** — remove conta Auth + documento Firestore (planilha Sheets permanece no Drive)
**`reenviarAcesso`** — gera novo link de redefinição de senha + envia e-mail
**`criarPlanilha`** — provisiona planilha para mentorada que ainda não tem sheetId
**`bootstrapAdmin`** — auto-configura custom claim `admin: true` para a conta master (flaviasch@gmail.com)
**`setAdminClaim`** — concede/revoga claim admin para qualquer conta (só admin pode chamar)

### Contratos & cobranças

**`createContrato`** — cria contrato + cobranças no Firestore
- Parcelado: recebe array `[{ valor, vencimento }]`
- Recorrente: recebe primeira parcela; demais são geradas automaticamente a cada pagamento

**`getContratos`** — lista contratos de uma mentorada com suas cobranças (subcoleção `contratos` + coleção `cobrancas`)

**`pagarParcela`** — registra pagamento; se recorrente: gera próxima cobrança + atualiza `dataExpiracao` para produtos `dashboard` e `clube`; se parcelado e todas pagas: marca contrato como `quitado`

**`editarPagamento`** — corrige data e valor de um pagamento já registrado

**`editarContrato`** — edita produto, formaPagamento, periodicidade; se tipo=parcelado e **nenhuma** parcela paga: recria todas as cobranças com novo conjunto de parcelas

**`cancelarCobranca`** — marca cobrança individual como `cancelada: true` (só não-pagas)

**`cancelarContrato`** — marca contrato como `cancelado` + cancela todas as cobranças futuras não-pagas

**`getCobrancas`** — retorna cobranças por mês/ano (filtra canceladas em memória); opcionalmente filtra por uid

### Notion CRM

**`getNotionCRM`** (`onCall`, secret: NOTION_TOKEN)
1. Busca página Notion pelo nome da mentorada (`🌙 Mentoria Trilogia Financeira - [Nome]`)
2. Lê blocos da página (até 100 blocos)
3. Parseia estrutura: `heading_2` = marcador de encontro `"Encontro N | Tema | Data"`, `heading_3` com "Lição de Casa" = início de seção de tarefas, `to_do` desmarcado = lição pendente
4. Retorna: `{ notionPageUrl, ultimoEncontro: { numero, tema, data }, licoesPendentes: string[] }`
5. Cacheia no Firestore: `notionPageId`, `notionUltimoEncontro`, `notionLicoesPendentes` (contagem), `notionSyncedAt`

### Kiwify (webhook público)

**`kiwifyWebhook`** (`onRequest`, POST)
- URL: `https://us-central1-trilogia-dashboard.cloudfunctions.net/kiwifyWebhook`
- Configurado no Kiwify: Compra aprovada + Assinatura cancelada + Assinatura em atraso
- Campo do evento no payload: `body.webhook_event_type` (PascalCase Kiwify), fallback para `body.event` / `body.type`
- E-mail do cliente: `body.Customer.email` → `body.Order.Customer.email` → `body.Subscription.Customer.email`
- Produto: `body.Product.name` → `body.Order.Product.name`
- Valor: `body.Order.amount` → `body.Subscription.charge_amount` (heurística: se > 1000, divide por 100)

| Evento Kiwify | Produto | Ação |
|---|---|---|
| Cancelamento | `dashboard` | Bloqueia Auth + `status: inativa` + `assinaturaDashboard: false` |
| Cancelamento | `mentoria` / `private` / `clube` / desconhecido | Bloqueia Auth + `status: inativa` + `mentoriaEncerrada: true` |
| Atraso | qualquer | `status: alerta` (não bloqueia) |
| Pagamento | `dashboard` | `assinaturaDashboard: true` + reativa Auth/status se bloqueada |
| Pagamento | outros | Registra cobrança no Firestore |

### Notificações agendadas (cron)

| Função | Horário | O que faz |
|---|---|---|
| `notifDia1` | 1º de cada mês, 08h | Lembrete de orçamento para todas as ativas; se sem perfil → e-mail para cadastrar; se perfil > 180 dias → e-mail de renovação |
| `notifDia28` | Dia 28, 08h | Lembrete de aporte mensal para todas as ativas |
| `notifMaioIR` | 5 de maio, 08h | Lembrete de importação da declaração de IR |
| `notifCobrancasDia` | Diário, 08h | E-mail para Flávia com cobranças com vencimento no dia |
| `verificarExpiracoes` | Diário, 07h | Bloqueia mentoradas com `dataExpiracao` vencida — exceto se `assinaturaDashboard === true` |
| `notifExpiracaoProxima` | Diário, 08h | Avisa mentorada se `dataExpiracao` = daqui a 7 dias |

---

## Painel admin — `admin.html`

### Aba Mentoradas

**Lista**
- Filtros: Todas, Ativas, Com alerta, Sem acesso (14+ dias sem login)
- KPIs: Ativas (clicável → filtra), MRR (cobranças reais do mês), Alertas (clicável), PL médio
- Alertas computados automaticamente, sem marcar manual:
  - 💸 Cobrança vencida (não paga, vencimento < hoje)
  - 🔴 Acesso expirado (`dataExpiracao` < hoje)
  - ⏳ Acesso expira em ≤ 7 dias
  - 📋 Perfil de investidor não preenchido
  - ⚠️ Status = alerta
- Ícones de motivo ao lado do nome (com tooltip)
- Badge "Sem acesso" para mentoradas sem login há 14+ dias

**Detalhe da mentorada**
- Edição inline: Produto & Pagamento (salva só campos preenchidos)
- Edição inline: Data de expiração
- Salvar nota
- Ações: Bloquear / Reativar / Deletar / Reenviar link de acesso
- **Seção Acompanhamento (Notion CRM)** — lê página Notion da mentorada
  - Mostra: último encontro (número, tema, data) + lições de casa pendentes
  - Botão "Atualizar" recarrega
  - Oculta automaticamente se `mentoriaEncerrada: true`
- **Contratos:**
  - Criar contrato (modal: produto, tipo, forma, parcelas)
  - Ver parcelas com status (pago / vencido / pendente)
  - Registrar pagamento (data + valor recebido)
  - Editar pagamento (corrige valor/data já registrado)
  - Cancelar cobrança individual
  - Cancelar contrato inteiro
  - **Botão "✎ Editar"** no cabeçalho do contrato — edita produto/forma/periodicidade; se tipo=parcelado e sem parcelas pagas: permite recriar parcelas com novo número e valores (não aparece em contratos cancelados)
- **Botão "Fechar mentoria"** (dourado)
  - Aparece quando: há contrato de produto `mentoria` com status `ativo` ou `quitado` E `dataExpiracao` ainda não passou
  - Abre modal com prompt pré-preenchido para o skill `/entregaveis-finais-mentoria`
  - Inclui: nome, e-mail, produto, início, perfil, PL, sobra, reservas, contratos, nota
- **Botão "Marcar como encerrada"**
  - Seta `mentoriaEncerrada: true` sem gerar entregáveis
  - Oculta seção Acompanhamento e botões de ação

### Aba Financeiro
- Navegação por mês (← →)
- KPIs: Previsto no mês, Recebido (líquido), A receber (pendentes)
- Tabela: Aluna, Produto, Parcela, Vencimento, Forma, Valor, Recebido, Status
- Botão ✕ em cada linha não-paga → cancela cobrança com confirmação
- Badges: Pago (verde), Vencido (vermelho), Pendente (âmbar)

---

## Modelo de dados

### Firestore — coleção `mentoradas` (campos relevantes)

| Campo | Tipo | Descrição |
|---|---|---|
| `nome` | string | Nome completo |
| `email` | string | E-mail (usado no matching do webhook Kiwify) |
| `status` | string | `ativa` / `inativa` / `alerta` |
| `inicio` | string YYYY-MM | Mês de início da mentoria |
| `perfil` | string | `conservador` / `moderado` / `arrojado` (fallback do Sheets) |
| `produto` | string | `mentoria` / `private` / `clube` / `dashboard` |
| `valorMensal` | number | Valor mensal do contrato principal |
| `formaPagamento` | string | Forma de pagamento do contrato principal |
| `dataExpiracao` | string YYYY-MM-DD | Quando o acesso expira (renovado a cada pagamento de `dashboard` ou `clube`) |
| `mentoriaEncerrada` | boolean | true = mentoria encerrada |
| `assinaturaDashboard` | boolean | true = tem assinatura ativa do produto `dashboard` no Kiwify |
| `sheetId` | string | ID da planilha Google Sheets desta mentorada |
| `nota` | string | Nota interna da Flávia |
| `ultimoAcesso` | timestamp | Último login da mentorada |
| `totalAcessos` | number | Contador total de acessos |
| `acessosMes` | number | Acessos no mês corrente |
| `pl` | number | PL cacheado pelo getDashboard |
| `sobra` | number | Sobra mensal cacheada |
| `totalReservas` | number | Total de reservas cacheado |
| `lgpdAceite` | boolean | Se aceitou o termo LGPD |
| `notionPageId` | string | ID cacheado da página Notion |
| `notionUltimoEncontro` | object | `{ numero, tema, data }` cacheado |
| `notionLicoesPendentes` | number | Contagem de lições pendentes cacheada |

### Firestore — subcoleção `mentoradas/{uid}/contratos`

| Campo | Tipo |
|---|---|
| `produto` | string |
| `tipo` | `parcelado` / `recorrente` |
| `periodicidade` | `mensal` / `anual` (só recorrente) |
| `valorTotal` | number |
| `formaPagamento` | string |
| `status` | `ativo` / `quitado` / `cancelado` |

### Firestore — coleção `cobrancas` (raiz, não subcoleção)

| Campo | Tipo |
|---|---|
| `uidMentorada` | string |
| `nomeAluna` / `emailAluna` | string |
| `contratoId` | string |
| `produto` | string |
| `tipo` | `parcelado` / `recorrente` |
| `periodicidade` | string |
| `numero` / `total` | number (ex: 3/12) |
| `valor` | number |
| `vencimento` | string YYYY-MM-DD |
| `pago` | boolean |
| `dataPagamento` | string |
| `valorRecebido` | number |
| `formaPagamento` | string |
| `cancelada` | boolean |

### Google Sheets — estrutura por mentorada (abas)

| Aba | Colunas | Quem grava |
|---|---|---|
| `orcamento` | mes, ano, categoria, tipo, valor | CSV do Raio-X via dashboard |
| `patrimonio` | classe, valor | CSV da declaração de IR |
| `investimentos` | classe, valor | CSV da corretora |
| `dividas` | id, nome, tipo, saldo, parcela, termino | Manual ou CSV |
| `reservas` | id, nome, meta, acumulado, dataMeta, aporte | Cadastro no dashboard |
| `perfil` | perfil, dataAtualizacao | Suitability no dashboard |
| `historico` | data (AAAA-MM), ativos, dividas, pl | Upsert automático |

---

## Lógica de acesso

- `dataExpiracao` é atualizado automaticamente a cada pagamento de `dashboard` ou `clube`
- `verificarExpiracoes` (07h diário): bloqueia quem expirou, **exceto** se `assinaturaDashboard === true`
- `assinaturaDashboard: true` = acesso permanente via assinatura mensal do produto dashboard (independente da mentoria)

---

## Constantes críticas em `functions/index.js`

```js
const PRODUTOS_RECORRENTES = ['clube', 'dashboard']; // estes atualizam dataExpiracao ao pagar
const ADMIN_EMAIL = 'flaviasch@gmail.com';
const ADMIN_MASTER_EMAIL = 'flaviasch@gmail.com';
```

---

## Integrações externas

| Serviço | Uso | Secret |
|---|---|---|
| Google Sheets API | CRUD das planilhas das mentoradas | `GOOGLE_SERVICE_ACCOUNT_JSON` |
| Google Drive API | Criar planilha no Drive da Flávia | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `DRIVE_FOLDER_ID` |
| Kiwify | Webhook de pagamentos/cancelamentos | (sem autenticação por token ainda) |
| Notion API | Leitura do CRM de encontros | `NOTION_TOKEN` |
| Gmail (via OAuth) | Envio de e-mails transacionais | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` |

---

## E-mails transacionais enviados

| Template | Quando |
|---|---|
| `emailBoasVindas` | Ao criar mentorada (inclui link de definição de senha) |
| `emailReenvioAcesso` | Ao reenviar link de acesso pelo painel admin |
| `emailLembreteOrcamento` | Dia 1 de cada mês (todas as ativas) |
| `emailSemPerfil` | Dia 1 se não tem perfil de investidor |
| `emailRenovacaoPerfil` | Dia 1 se perfil > 180 dias |
| `emailLembreteAporte` | Dia 28 de cada mês (todas as ativas) |
| `emailIR` | 5 de maio (lembrete de importação do IR) |
| `emailCobrancasDia` | Diário para Flávia com cobranças do dia |
| `emailExpiracaoProxima` | Quando `dataExpiracao` = daqui a 7 dias |

---

## Skills do ecossistema (rodam no Claude Code da Flávia)

- **`/email-pos-encontro`** (alias `/fup`) — após cada encontro: atualiza página Notion + cria rascunho de e-mail de follow-up
- **`/entregaveis-finais-mentoria`** — ao encerrar mentoria: gera PDF (Relatório de Evolução) + Excel (Plano de Investimento); salva em `[workspace]/FUP/[Nome Completo]/`; scripts: `scripts/gerar_planilha.py`, `scripts/gerar_relatorio.py`

## Notion por mentorada

- Página: `🌙 Mentoria Trilogia Financeira - [Nome]`
- Estrutura: `Encontro N | Tema | Data` (heading_2) → sub-seções (heading_3) → checkboxes de lição de casa
- `getNotionCRM` lê e cacheia no Firestore; painel admin exibe no detalhe da mentorada
