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
  const CLASSES_VALIDAS = ['pos', 'infl', 'pre', 'rv', 'mm', 'int', 'alt'];

  // Aliases gerados pelos agentes → classe interna
  const ALIAS = {
    // Imóveis
    'imoveis': 'alt', 'imovel': 'alt', 'imóveis': 'alt', 'imóvel': 'alt',
    'imoveis e direitos': 'alt', 'bens imoveis': 'alt',
    // Ações / Renda Variável
    'acoes': 'rv', 'ações': 'rv', 'acao': 'rv', 'ação': 'rv',
    'fii': 'rv', 'fiis': 'rv', 'fundos imobiliarios': 'rv', 'fundos imobiliários': 'rv',
    'renda variavel': 'rv', 'renda variável': 'rv',
    // RF Pós
    'rf pos': 'pos', 'rf pós': 'pos',
    'renda fixa pos': 'pos', 'renda fixa pós': 'pos',
    'tesouro selic': 'pos', 'cdb pos': 'pos',
    // RF Inflação
    'rf inflacao': 'infl', 'rf inflação': 'infl',
    'renda fixa inflacao': 'infl', 'renda fixa inflação': 'infl',
    'inflacao': 'infl', 'inflação': 'infl',
    'tesouro ipca': 'infl', 'ipca': 'infl',
    // RF Pré
    'rf pre': 'pre', 'rf pré': 'pre',
    'renda fixa pre': 'pre', 'renda fixa pré': 'pre',
    'prefixado': 'pre', 'pre-fixado': 'pre', 'pré-fixado': 'pre',
    // Multimercado
    'multimercado': 'mm', 'multi': 'mm', 'fundos multimercado': 'mm',
    // Internacional
    'internacional': 'int', 'internacionais': 'int', 'exterior': 'int',
    'bdr': 'int', 'bdrs': 'int',
    // Alternativos
    'alternativos': 'alt', 'alternativo': 'alt',
    'cripto': 'alt', 'criptomoedas': 'alt', 'criptoativos': 'alt',
    'coe': 'alt', 'fip': 'alt', 'fips': 'alt',
  };

  const linhas = csvText.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (linhas.length < 2) throw new Error('CSV vazio ou sem dados.');

  // Detecta separador automaticamente: tab, ponto-e-vírgula ou vírgula
  const primeiraLinha = linhas[0];
  const sep = primeiraLinha.includes('\t') ? '\t'
            : primeiraLinha.includes(';')  ? ';'
            : ',';

  const cabecalho = primeiraLinha.split(sep).map(c => c.trim().toLowerCase());
  const idxClasse = cabecalho.indexOf('classe');
  const idxValor  = cabecalho.indexOf('valor');

  if (idxClasse === -1 || idxValor === -1) {
    throw new Error('CSV inválido: colunas esperadas são "classe" e "valor".');
  }

  return linhas.slice(1).map((linha, i) => {
    const cols      = linha.split(sep).map(c => c.trim());
    const classeRaw = cols[idxClasse]?.trim() || '';
    const chave     = classeRaw.toLowerCase();

    // Aceita o código direto (pos, rv…) ou busca no mapa de aliases
    const classe = CLASSES_VALIDAS.includes(chave) ? chave : (ALIAS[chave] || null);

    if (!classe) {
      throw new Error(`Linha ${i + 2}: classe inválida "${classeRaw}". Use: ${CLASSES_VALIDAS.join(', ')}.`);
    }

    const valor = parseFloat(cols[idxValor]?.replace(',', '.'));
    if (isNaN(valor)) throw new Error(`Linha ${i + 2}: valor inválido "${cols[idxValor]}".`);
    return { classe, valor };
  });
}
