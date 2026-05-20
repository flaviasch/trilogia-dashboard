# Trilogia Dashboard — Contexto do Projeto

## O que é
Dashboard financeiro pessoal para mentoradas da Mentoria Trilogia Financeira (Flávia Schuscimann, CFP®). Produto de assinatura mensal entregue no encontro 7 da mentoria.

**Precificação:**
- Dashboard standalone: R$147/mês
- Clube Trilogia standalone: R$97/mês
- Combo Dashboard + Clube: R$197/mês

## Stack
- **Frontend:** HTML/CSS/JavaScript puro
- **Auth:** Firebase Authentication (email e senha)
- **Banco de dados:** Google Sheets (um arquivo por mentorada, na conta da Flávia)
- **Escrita no Sheets:** Firebase Cloud Functions com conta de serviço Google
- **Hospedagem:** GitHub Pages — `dashboard.flaviaschusciman.com` (CNAME apontando para `flaviasch.github.io`)
- **Repositório:** `https://github.com/flaviasch/trilogia-dashboard`

## Firebase
```js
const firebaseConfig = {
  apiKey: "AIzaSyCbgekmh90OPhr7DZJsVS-GXAYMOqtZ3Ds",
  authDomain: "trilogia-dashboard.firebaseapp.com",
  projectId: "trilogia-dashboard",
  storageBucket: "trilogia-dashboard.firebasestorage.app",
  messagingSenderId: "175437497741",
  appId: "1:175437497741:web:59aa773c374c4eceb429c4"
};
```

## Páginas criadas ✅ (todas funcionais e em produção)

| Arquivo | Descrição | Status |
|---|---|---|
| `login.html` | Autenticação Firebase | ✅ testado |
| `recuperar-senha.html` | Recuperação de senha | ✅ |
| `index.html` | Tela principal (cards resumo) | ✅ |
| `orcamento.html` | Orçamento — importação CSV do Raio-X | ✅ |
| `patrimonio.html` | Patrimônio — ativos, dívidas, balanço, evolução | ✅ |
| `reservas.html` | Reservas de longo prazo + comparativo carteira | ✅ |
| `perfil.html` | Perfil de investidor + suitability + impacto reservas | ✅ |
| `admin.html` | Visão admin (Flávia) | ✅ |
| `ajuda.html` | Tutorial dos 3 agentes + FAQ | ✅ |
| `js/api.js` | Todas as chamadas Firebase Functions | ✅ |
| `functions/` | Firebase Cloud Functions v2 (Node.js) | ✅ |
| `functions/lib/sheets.js` | SheetsClient — CRUD Google Sheets | ✅ |

## Identidade visual
- Navy escuro: `#0D2B45` / `#081e30`
- Gold: `#CFAE65`
- Fonte: Playfair Display (títulos) + Inter (corpo)
- Igual ao site flaviaschusciman.com

---

## patrimonio.html — detalhes de implementação

### Seções
1. **Importar dados** — 3 cards:
   - Importar declaração IR (CSV do Agente de Patrimônio)
   - Importar posição da corretora (CSV do Agente de Investimentos)
   - Importar dívidas (CSV do Agente de Patrimônio — gera 2 arquivos separados)
2. **Ativos por classe** — barra horizontal + cards por classe
3. **Dívidas** — tabela com editar/excluir + botão adicionar + importação CSV
4. **Balanço Patrimonial** — duas barras verticais largas estilo balanço contábil:
   - Esquerda: Ativos (dourado)
   - Direita: Dívidas (vermelho, topo) + PL (verde escuro, base)
   - Ambas sempre com a mesma altura total (maxH = 260px)
   - Labels e valores dentro das barras
5. **Evolução do PL** — gráfico de 12 meses (barras verticais, verde/vermelho por sinal)

### Agente de Patrimônio gera 2 CSVs
- CSV de patrimônio: colunas `classe,valor`
- CSV de dívidas: colunas `nome,tipo,saldo,parcela,termino`
- O disclaimer no topo da página já reflete isso

### Dívidas — funcionalidades
- Adicionar manualmente (modal)
- Editar (modal pré-preenchido)
- Excluir (confirmação)
- Importar CSV (substitui todas as dívidas existentes)

### Histórico de PL (aba `historico` no Sheets)
- Upsert por chave `AAAA-MM` a cada mudança de patrimônio/dívidas
- Exibe últimos 12 meses na evolução

---

## reservas.html — detalhes de implementação

### Alocação sugerida automática por prazo
- Até 1 ano → 100% RF Pós (liquidez diária)
- 1 a 4 anos → 70% RF Pós / 25% RF Inflação / 5% RF Pré
- 4 a 10 anos → configável (mesma lógica moderado sem RV)
- Acima de 10 anos → usa perfil de investidor da mentorada

### Comparativo CARTEIRA: SUGERIDA × ATUAL
- Puxa `patrimonioAtual` de `getPatrimonio()` ao abrir a página
- Resolve nomes livres via `PATRIMONIO_COR` (em `api.js`) → código interno → `CLASS_TO_LABEL` → label
- Exibe apenas as classes que fazem parte da alocação sugerida do perfil
- Ativos não financeiros (imóveis etc.) são desconsiderados — **sem linha de rodapé cinza**
- Colunas: Classe | Sugerido | Atual | Diferença (verde/vermelho)

### ALOCACAO_PERFIL (valores corretos)
```js
conservador: [
  { label: 'RF Pós',      pct: 70,   cor: '#60a5fa' },
  { label: 'RF Inflação', pct: 25,   cor: '#34d399' },
  { label: 'RF Pré',      pct:  5,   cor: '#a78bfa' },
],
moderado: [
  { label: 'RF Pós',         pct: 52.5, cor: '#60a5fa' },
  { label: 'RF Inflação',    pct: 25,   cor: '#34d399' },
  { label: 'RF Pré',         pct:  5,   cor: '#a78bfa' },
  { label: 'Multimercado',   pct:  7.5, cor: '#fb7185' },
  { label: 'Renda Variável', pct:  5,   cor: '#f59e0b' },
  { label: 'Internacional',  pct:  5,   cor: '#22d3ee' },
],
arrojado: [
  { label: 'RF Pós',         pct: 20,  cor: '#60a5fa' },
  { label: 'RF Inflação',    pct: 25,  cor: '#34d399' },
  { label: 'RF Pré',         pct:  5,  cor: '#a78bfa' },
  { label: 'Multimercado',   pct: 15,  cor: '#fb7185' },
  { label: 'Renda Variável', pct: 15,  cor: '#f59e0b' },
  { label: 'Internacional',  pct: 15,  cor: '#22d3ee' },
  { label: 'Alternativos',   pct:  5,  cor: '#c084fc' },
],
```
*(mesma tabela espelhada em `perfil.html` → `PERFIS[x].alocacao`)*

---

## perfil.html — detalhes de implementação

### Fluxo
1. Banner de validade (verde/amarelo/vermelho conforme prazo 2 anos)
2. Card "Perfil atual" com barra de alocação e legenda
3. Botão "Atualizar perfil" → abre o questionário (5 perguntas suitability)
4. Resultado: novo perfil + barra de alocação
5. **Seção "Impacto nos objetivos"** — mostra reservas com prazo > 10 anos afetadas
6. Botões "Confirmar e salvar" / "Refazer questionário"

### Seção de impacto (implementada)
- Aparece apenas se houver reservas com `dataMeta` > 120 meses à frente
- Lista cada reserva afetada com: nome, data objetivo, anos restantes
- Se perfil mudou: barra "Antes · [perfil antigo]" → seta → barra "Depois · [novo perfil]"
- Se primeiro cadastro (sem perfil anterior): só a barra do novo perfil
- Se perfil não mudou (mesmo resultado): só a barra, sem "antes"
- Ativos não financeiros (imóveis) desconsiderados — consistente com reservas.html

### Suitability — pontuação
- 5 perguntas, 1-3 pontos cada (max 15)
- ratio ≤ 0.45 → Conservador | ≤ 0.75 → Moderado | > 0.75 → Arrojado

---

## js/api.js — pontos-chave

### PATRIMONIO_COR
Mapa de nomes livres → código interno. Cobre tanto os labels do agente quanto os que o usuário digita manualmente:
```
'rf pós' / 'rf pos' / 'renda fixa pos' → 'pos'
'rf inflação' / 'rf inflacao' → 'infl'
'rf pré' / 'rf pre' → 'pre'
'renda variável' / 'renda variavel' → 'rv'
'multimercado' → 'mm'
'internacional' / 'internacionais' → 'int'
'alternativos' / 'alternativo' → 'alt'
'imóveis' / 'imoveis' → 'imov'
```

### parsearCsvDividas(csvText)
Parseia CSV com colunas `nome,tipo,saldo,parcela,termino`. Suporta separadores tab/ponto-e-vírgula/vírgula. Normaliza aliases de tipo (financiamento → financiamento, cartao → cartão etc.).

### parsearCsvPatrimonio(csvText)
Parseia CSV com colunas `classe,valor`. Resolve nomes via PATRIMONIO_COR.

---

## Google Sheets — estrutura por mentorada

| Aba | Colunas | Quem grava |
|---|---|---|
| `orcamento` | mes, ano, categoria, tipo, valor | CSV do Raio-X via dashboard |
| `patrimonio` | classe, valor, atualizado | CSV do Agente de Patrimônio |
| `investimentos` | classe, valor, atualizado | CSV do Agente de Investimentos |
| `dividas` | id, nome, tipo, saldo, parcela, termino | Manual ou CSV no dashboard |
| `reservas` | id, nome, meta, acumulado, dataMeta, aporte | Cadastro no dashboard |
| `perfil` | perfil, dataAtualizacao | Suitability no dashboard |
| `historico` | data (AAAA-MM), ativos, dividas, pl | Upsert automático a cada atualização |

---

## Lógica de reservas
- Cada reserva tem: nome, meta total, valor acumulado, data objetivo, aporte mensal objetivo
- Alocação sugerida é automática por prazo (não editável pela mentorada)
- Quando reserva atinge 100% → aporte cessa automaticamente
- Quando reserva cai abaixo de 100% após completada → notificação por dashboard e email

## Dois níveis de acesso
- **Mentorada:** acessa só o próprio perfil, pode editar campos específicos
- **Admin (Flávia):** acessa todas as mentoradas, pode editar qualquer coisa

## Fontes de dados
- **Orçamento:** Raio-X gera CSV → upload no dashboard → escreve no Sheets
- **Patrimônio:** Agente de Patrimônio lê CSV do IR → gera 2 CSVs (patrimônio + dívidas) → upload no dashboard
- **Investimentos:** Agente de Investimentos lê PDF da corretora → CSV → upload no dashboard
- **Dívidas:** entrada manual OU importação CSV no dashboard
- **Reservas:** cadastro no dashboard (pela Flávia ou pela mentorada)

## Cancelamento
- Mentorada pode exportar seus dados
- 30 dias de acesso somente leitura após cancelamento
- Bloqueio de acesso manual pela Flávia (via Firebase Console)
- Cobrança via Kiwify (recorrência)

---

## Commits recentes (referência)
```
11c51ac  fix(reservas): remove linha 'fora da alocação' da tabela comparativa
d34c62c  feat(perfil): seção de impacto nos objetivos após resultado do quiz
60d853b  fix(alocacao): corrige percentuais sugeridos por perfil em reservas e perfil
aa3e362  feat(reservas): linha 'fora da alocação' no comparativo de carteira  ← revertido em 11c51ac
0732201  fix(api): PATRIMONIO_COR cobre labels diretos de classe
3821b71  fix(reservas): carteira atual puxa corretamente do patrimônio
a8d06ef  fix(balanço): corrige altura — ambos os lados sempre iguais
4e35dc0  refactor(balanço): barras largas estilo balanço contábil com labels internos
```
