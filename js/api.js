/**
 * api.js — cliente das Cloud Functions do Trilogia Dashboard.
 *
 * Todas as páginas devem importar daqui em vez de usar fetch direto.
 * Cada função chama o endpoint Firebase onCall correspondente e retorna
 * os dados já parseados.
 *
 * Em caso de erro lança um objeto { code, message } compatível com
 * FirebaseFunctionsError para tratamento uniforme no frontend.
 */

import { auth, functions } from './firebase-config.js';
import {
  httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

// ─── Helper central ────────────────────────────────────────────────────────────

function call(nome) {
  const fn = httpsCallable(functions, nome);
  return async (dados) => {
    try {
      const result = await fn(dados);
      return result.data;
    } catch (err) {
      // Relança como objeto simples para o catch dos callers
      throw {
        code:    err.code    || 'unknown',
        message: err.message || 'Erro inesperado. Tente novamente.',
      };
    }
  };
}

// ─── UID do usuário logado ─────────────────────────────────────────────────────

export function uidAtual() {
  const user = auth.currentUser;
  if (!user) throw { code: 'unauthenticated', message: 'Usuária não está logada.' };
  return user.uid;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

/**
 * Retorna orçamento do mês atual, patrimônio, reservas e perfil.
 * Usado por index.html.
 */
export const getDashboard = call('getDashboard');

// ─── Orçamento ────────────────────────────────────────────────────────────────

/**
 * @param {number} mes - 1 a 12
 * @param {number} ano
 * @returns {Promise<Array<{categoria, tipo, valor}>>}
 */
export async function getOrcamento(mes, ano) {
  return call('getOrcamento')({ uid: uidAtual(), mes, ano });
}

/**
 * Salva orçamento importado do CSV do Raio-X.
 * @param {number} mes
 * @param {number} ano
 * @param {Array<{categoria: string, tipo: 'receita'|'despesa', valor: number}>} itens
 */
export async function saveOrcamento(mes, ano, itens) {
  return call('saveOrcamento')({ uid: uidAtual(), mes, ano, itens });
}

// ─── Patrimônio ───────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ativos: Array, dividas: Array}>}
 */
export async function getPatrimonio() {
  return call('getPatrimonio')({ uid: uidAtual() });
}

/**
 * Salva ativos importados do CSV (IR ou corretora).
 * @param {Array<{classe, valor}>} itens
 * @param {'ir'|'corretora'} tipo
 */
export async function savePatrimonio(itens, tipo) {
  return call('savePatrimonio')({ uid: uidAtual(), itens, tipo });
}

// ─── Dívidas ──────────────────────────────────────────────────────────────────

/**
 * @param {{ id, nome, tipo, saldo, parcela, termino }} divida
 */
export async function saveDivida(divida) {
  return call('saveDivida')({ uid: uidAtual(), divida });
}

export async function deleteDivida(dividaId) {
  return call('deleteDivida')({ uid: uidAtual(), dividaId });
}

// ─── Reservas ─────────────────────────────────────────────────────────────────

export async function getReservas() {
  return call('getReservas')({ uid: uidAtual() });
}

/**
 * @param {{ id, nome, meta, acumulado, dataMeta, aporte }} reserva
 */
export async function saveReserva(reserva) {
  return call('saveReserva')({ uid: uidAtual(), reserva });
}

export async function deleteReserva(reservaId) {
  return call('deleteReserva')({ uid: uidAtual(), reservaId });
}

// ─── Perfil de investidor ──────────────────────────────────────────────────────

export async function getPerfil() {
  return call('getPerfil')({ uid: uidAtual() });
}

/**
 * @param {'conservador'|'moderado'|'arrojado'} perfil
 */
export async function savePerfil(perfil) {
  return call('savePerfil')({ uid: uidAtual(), perfil });
}

// ─── Admin ────────────────────────────────────────────────────────────────────

/**
 * Bootstrap: configura claim admin=true para a conta master (flaviasch@gmail.com).
 * Só funciona para esse e-mail — chamado automaticamente em index.html quando necessário.
 */
export const bootstrapAdmin = call('bootstrapAdmin');

export const getMentoradas = call('getMentoradas');

/**
 * @param {{ nome, email, inicio, perfil }} dados
 * @returns {Promise<{ uid, sheetId }>}
 */
export const createMentorada = call('createMentorada');

/**
 * @param {string} uid
 * @param {{ status?, nota?, perfil?, inicio? }} campos
 */
export async function updateMentorada(uid, campos) {
  return call('updateMentorada')({ uid, campos });
}

export async function bloquearMentorada(uid) {
  return call('bloquearMentorada')({ uid });
}

export async function reativarMentorada(uid) {
  return call('reativarMentorada')({ uid });
}

// ─── Mapa de cores para patrimônio (usado por patrimonio.html) ─────────────────
// Nome original do IR → código de categoria para cor na UI.
// Não usado pelo parser — apenas exportado para consulta visual.
export const PATRIMONIO_COR = {
  // Imóveis
  'imoveis': 'imov', 'imóveis': 'imov', 'apartamento': 'imov', 'casa': 'imov',
  'terreno': 'imov', 'lote': 'imov', 'sala comercial': 'imov', 'imovel rural': 'imov',
  'imóvel rural': 'imov', 'galpao': 'imov', 'galpão': 'imov',
  // Veículos
  'veiculos': 'alt', 'veículos': 'alt', 'veiculo': 'alt', 'veículo': 'alt',
  'automovel': 'alt', 'automóvel': 'alt', 'carro': 'alt', 'motocicleta': 'alt',
  'moto': 'alt', 'caminhao': 'alt', 'embarcacao': 'alt', 'aeronave': 'alt',
  // Contas / liquidez
  'conta corrente': 'pos', 'conta bancaria': 'pos', 'conta bancária': 'pos',
  'conta salario': 'pos', 'conta salário': 'pos', 'poupanca': 'pos', 'poupança': 'pos',
  'deposito bancario': 'pos', 'depósito bancário': 'pos', 'fgts': 'pos',
  'disponibilidades': 'pos', 'caixa': 'pos', 'dinheiro em especie': 'pos',
  'aplicacoes financeiras': 'pos', 'aplicações financeiras': 'pos',
  // Renda Variável
  'acoes': 'rv', 'ações': 'rv', 'fii': 'rv', 'fiis': 'rv',
  'participacoes societarias': 'rv', 'participações societárias': 'rv',
  'etf': 'rv', 'etfs': 'rv',
  // RF Inflação
  'debentures': 'infl', 'debêntures': 'infl', 'cri': 'infl', 'cra': 'infl',
  'tesouro ipca': 'infl', 'ntnb': 'infl',
  // RF Pré
  'tesouro prefixado': 'pre', 'ltn': 'pre', 'prefixado': 'pre',
  // Multimercado / Previdência
  'previdencia privada': 'mm', 'previdência privada': 'mm',
  'pgbl': 'mm', 'vgbl': 'mm', 'fundos': 'mm', 'multimercado': 'mm',
  // Internacional
  'ativos internacionais': 'int', 'investimentos internacionais': 'int',
  'bdr': 'int', 'bdrs': 'int', 'exterior': 'int', 'moeda estrangeira': 'int',
  // Alternativos
  'cripto': 'alt', 'criptomoedas': 'alt', 'bitcoin': 'alt',
  'ouro': 'alt', 'coe': 'alt', 'joias': 'alt', 'jóias': 'alt',
  'consorcio': 'alt', 'consórcio': 'alt', 'outros bens': 'alt', 'outros': 'alt',
};

// ─── Utilitários de parse de CSV ───────────────────────────────────────────────

/**
 * Parseia o CSV do Raio-X para o formato esperado por saveOrcamento.
 *
 * Formato esperado do CSV (gerado pelo Agente Raio-X):
 *   categoria,tipo,valor
 *   Salário,receita,15000
 *   Moradia,despesa,4200
 *   ...
 *
 * @param {string} csvText - conteúdo do arquivo CSV
 * @returns {Array<{categoria, tipo, valor}>}
 */
export function parsearCsvRaioX(csvText) {
  const linhas = csvText.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (linhas.length < 2) throw new Error('CSV vazio ou sem dados.');

  const cabecalho = linhas[0].split(',').map(c => c.trim().toLowerCase());
  const idxCategoria = cabecalho.indexOf('categoria');
  const idxTipo      = cabecalho.indexOf('tipo');
  const idxValor     = cabecalho.indexOf('valor');

  if (idxCategoria === -1 || idxTipo === -1 || idxValor === -1) {
    throw new Error('CSV inválido: colunas esperadas são "categoria", "tipo", "valor".');
  }

  return linhas.slice(1).map((linha, i) => {
    const cols = linha.split(',').map(c => c.trim());
    const tipo = cols[idxTipo]?.toLowerCase();
    if (tipo !== 'receita' && tipo !== 'despesa') {
      throw new Error(`Linha ${i + 2}: tipo inválido "${cols[idxTipo]}". Use "receita" ou "despesa".`);
    }
    const valor = parseFloat(cols[idxValor]?.replace(',', '.'));
    if (isNaN(valor)) throw new Error(`Linha ${i + 2}: valor inválido "${cols[idxValor]}".`);
    return { categoria: cols[idxCategoria] || 'Sem categoria', tipo, valor };
  });
}

/**
 * Parseia o CSV do Agente de Patrimônio (IR) para o formato de patrimônio.
 *
 * Formato esperado:
 *   classe,valor
 *   pos,45000
 *   rv,80000
 *   ...
 *
 * @param {string} csvText
 * @returns {Array<{classe, valor}>}
 */
export function parsearCsvPatrimonio(csvText) {
  // Classe interna → código de cor/categoria usado na UI para cores e agrupamento.
  // Não restringe o que pode ser importado — aceita qualquer nome de classe;
  // este mapa é usado APENAS pelo patrimonio.html para determinar a cor do item.
  const ALIAS = {

    // ════ IMÓVEIS (→ imov) ════════════════════════════════════════════════

    'imoveis': 'imov', 'imovel': 'imov', 'imóveis': 'imov', 'imóvel': 'imov',
    'imoveis e direitos': 'imov', 'bens imoveis': 'imov', 'bens imóveis': 'imov',
    'apartamento': 'imov', 'casa': 'imov', 'terreno': 'imov', 'lote': 'imov',
    'sala comercial': 'imov', 'imovel rural': 'imov', 'imóvel rural': 'imov',
    'galpao': 'imov', 'galpão': 'imov', 'predio': 'imov', 'prédio': 'imov',
    'imovel residencial': 'imov', 'imóvel residencial': 'imov',
    'imovel comercial': 'imov', 'imóvel comercial': 'imov',

    // ════ BENS FÍSICOS / VEÍCULOS (→ alt) ════════════════════════════════

    // Veículos
    'veiculos': 'alt', 'veículos': 'alt', 'veiculo': 'alt', 'veículo': 'alt',
    'automovel': 'alt', 'automóvel': 'alt', 'carro': 'alt',
    'motocicleta': 'alt', 'moto': 'alt',
    'caminhao': 'alt', 'caminhão': 'alt', 'onibus': 'alt', 'ônibus': 'alt',
    'embarcacao': 'alt', 'embarcação': 'alt', 'lancha': 'alt', 'barco': 'alt',
    'aeronave': 'alt', 'aviao': 'alt', 'avião': 'alt',

    // Bens móveis / outros bens físicos
    'bens moveis': 'alt', 'bens móveis': 'alt',
    'joias': 'alt', 'jóias': 'alt', 'joia': 'alt', 'jóia': 'alt',
    'obras de arte': 'alt', 'obra de arte': 'alt',
    'antiguidades': 'alt', 'objetos de valor': 'alt', 'colecionaveis': 'alt',
    'animais': 'alt', 'semoventes': 'alt', 'gado': 'alt',
    'benfeitoria': 'alt', 'benfeitorias': 'alt',
    'consorcio': 'alt', 'consórcio': 'alt', 'consorcio nao contemplado': 'alt',
    'outros bens': 'alt', 'outros': 'alt', 'outros bens e direitos': 'alt',

    // ════ RENDA VARIÁVEL (→ rv) ════════════════════════════════════════════

    'acoes': 'rv', 'ações': 'rv', 'acao': 'rv', 'ação': 'rv',
    'acoes sa': 'rv', 'ações s.a.': 'rv',
    'fii': 'rv', 'fiis': 'rv', 'fundos imobiliarios': 'rv', 'fundos imobiliários': 'rv',
    'renda variavel': 'rv', 'renda variável': 'rv',
    'participacoes societarias': 'rv', 'participações societárias': 'rv',
    'participacao societaria': 'rv', 'participação societária': 'rv',
    'cotas de ltda': 'rv', 'cotas ltda': 'rv',
    'acoes e participacoes': 'rv', 'ações e participações': 'rv',
    'etf': 'rv', 'etfs': 'rv',
    'stock': 'rv', 'stocks': 'rv',
    'opcoes': 'rv', 'opções': 'rv', 'derivativos': 'rv',

    // ════ RF PÓS / LIQUIDEZ (→ pos) ═══════════════════════════════════════

    'rf pos': 'pos', 'rf pós': 'pos',
    'renda fixa pos': 'pos', 'renda fixa pós': 'pos',
    'tesouro selic': 'pos', 'lft': 'pos',
    'cdb': 'pos', 'cdb pos': 'pos', 'cdb pós': 'pos',
    'lci': 'pos', 'lca': 'pos', 'lci lca': 'pos', 'lci/lca': 'pos',
    'cri pos': 'pos', 'cra pos': 'pos',
    'conta bancaria': 'pos', 'conta bancária': 'pos',
    'contas bancarias': 'pos', 'contas bancárias': 'pos',
    'conta corrente': 'pos', 'contas correntes': 'pos',
    'conta salario': 'pos', 'conta salário': 'pos',
    'conta pagamento': 'pos', 'conta investimento': 'pos',
    'aplicacoes financeiras': 'pos', 'aplicações financeiras': 'pos',
    'aplicacao financeira': 'pos', 'aplicação financeira': 'pos',
    'poupanca': 'pos', 'poupança': 'pos',
    'deposito bancario': 'pos', 'depósito bancário': 'pos',
    'fgts': 'pos',
    'caixa': 'pos', 'dinheiro em especie': 'pos', 'dinheiro em espécie': 'pos',
    'disponibilidades': 'pos',

    // ════ RF INFLAÇÃO (→ infl) ════════════════════════════════════════════

    'rf inflacao': 'infl', 'rf inflação': 'infl',
    'renda fixa inflacao': 'infl', 'renda fixa inflação': 'infl',
    'inflacao': 'infl', 'inflação': 'infl',
    'tesouro ipca': 'infl', 'tesouro ipca+': 'infl', 'ntnb': 'infl',
    'ipca': 'infl', 'cdb ipca': 'infl',
    'debentures': 'infl', 'debêntures': 'infl',
    'cri': 'infl', 'cra': 'infl',

    // ════ RF PRÉ-FIXADO (→ pre) ════════════════════════════════════════════

    'rf pre': 'pre', 'rf pré': 'pre',
    'renda fixa pre': 'pre', 'renda fixa pré': 'pre',
    'prefixado': 'pre', 'pre-fixado': 'pre', 'pré-fixado': 'pre',
    'tesouro prefixado': 'pre', 'tesouro pre': 'pre', 'tesouro pré': 'pre',
    'ltn': 'pre', 'ntnf': 'pre',
    'cdb pre': 'pre', 'cdb pré': 'pre',

    // ════ MULTIMERCADO (→ mm) ══════════════════════════════════════════════

    'multimercado': 'mm', 'multi': 'mm', 'fundos multimercado': 'mm',
    'fundos de investimento': 'mm', 'fundos': 'mm',
    'previdencia privada': 'mm', 'previdência privada': 'mm',
    'pgbl': 'mm', 'vgbl': 'mm',
    'fundo de pensao': 'mm', 'fundo de pensão': 'mm',
    'plano de previdencia': 'mm', 'plano de previdência': 'mm',

    // ════ INTERNACIONAL (→ int) ════════════════════════════════════════════

    'internacional': 'int', 'internacionais': 'int', 'exterior': 'int',
    'ativos no exterior': 'int', 'investimentos no exterior': 'int',
    'bdr': 'int', 'bdrs': 'int',
    'moeda estrangeira': 'int', 'dolar': 'int', 'dólar': 'int',
    'euro': 'int', 'libra': 'int',

    // ════ ALTERNATIVOS (→ alt) ════════════════════════════════════════════

    'alternativos': 'alt', 'alternativo': 'alt',
    'cripto': 'alt', 'criptomoedas': 'alt', 'criptoativos': 'alt',
    'bitcoin': 'alt', 'ethereum': 'alt',
    'coe': 'alt', 'fip': 'alt', 'fips': 'alt',
    'ouro': 'alt', 'ouro ativo financeiro': 'alt',
    'commodities': 'alt', 'commodity': 'alt',
    'direitos': 'alt', 'direitos autorais': 'alt', 'propriedade intelectual': 'alt',
    'creditos': 'alt', 'créditos': 'alt', 'creditos a receber': 'alt',
    'emprestimos concedidos': 'alt', 'empréstimos concedidos': 'alt',
  };

  const linhas = csvText.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (linhas.length < 2) throw new Error('CSV vazio ou sem dados.');

  // Detecta separador automaticamente: tab, ponto-e-vírgula ou vírgula
  const primeiraLinha = linhas[0];
  const sep = primeiraLinha.includes('\t') ? '\t'
            : primeiraLinha.includes(';')  ? ';'
            : ',';

  const cabecalho = primeiraLinha.split(sep).map(c => c.trim().toLowerCase());

  // Aceita variações de nome de coluna geradas por diferentes agentes
  const ALIAS_COL_CLASSE = ['classe', 'class', 'tipo', 'tipo_ativo', 'ativo', 'categoria', 'category', 'asset', 'asset_class'];
  const ALIAS_COL_VALOR  = ['valor', 'valor líquido', 'valor liquido', 'valor_liquido', 'value', 'montante', 'saldo', 'amount', 'preco', 'preço', 'price'];

  const idxClasse = ALIAS_COL_CLASSE.map(n => cabecalho.indexOf(n)).find(i => i !== -1) ?? -1;
  const idxValor  = ALIAS_COL_VALOR .map(n => cabecalho.indexOf(n)).find(i => i !== -1) ?? -1;

  if (idxClasse === -1 || idxValor === -1) {
    const colsEncontradas = cabecalho.join(', ');
    throw new Error(`CSV inválido: não encontrei colunas de classe e valor. Colunas no arquivo: ${colsEncontradas || '(nenhuma)'}.`);
  }

  // Aceita qualquer nome de classe; agrega por nome original (case-insensitive,
  // preserva o caso da primeira ocorrência). Não remapeia para códigos internos:
  // "Imoveis" fica "Imoveis", "Veiculos" fica "Veiculos", "pos" fica "pos".
  const acumulado = {}; // chave = lowercase, valor = { classe (original), valor }

  linhas.slice(1).forEach((linha, i) => {
    const cols      = linha.split(sep).map(c => c.trim());
    const classeRaw = cols[idxClasse]?.trim() || '';
    if (!classeRaw) return; // pula linhas em branco
    // Ignora linhas de totalizador que o agente coloca no final
    const classeLC = classeRaw.toLowerCase();
    if (['total', 'total geral', 'soma', 'subtotal'].includes(classeLC)) return;

    const chave = classeRaw.toLowerCase();
    const valor = parseFloat(cols[idxValor]?.replace(',', '.'));
    if (isNaN(valor)) throw new Error(`Linha ${i + 2}: valor inválido "${cols[idxValor]}".`);

    if (acumulado[chave]) {
      acumulado[chave].valor += valor;
    } else {
      acumulado[chave] = { classe: classeRaw, valor };
    }
  });

  return Object.values(acumulado);
}
