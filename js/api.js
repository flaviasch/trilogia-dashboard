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
import { signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  httpsCallable,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

// ─── Mensagens de erro amigáveis ──────────────────────────────────────────────

const _MSGS_ERRO = {
  'unauthenticated':    'Sessão expirada. Recarregue a página.',
  'permission-denied':  'Sem permissão para essa ação.',
  'not-found':          'Dado não encontrado.',
  'invalid-argument':   'Dados inválidos. Verifique e tente novamente.',
  'resource-exhausted': 'Muitas requisições simultâneas. Aguarde um momento.',
  'unavailable':        'Serviço indisponível. Tente novamente em segundos.',
  'internal':           'Erro interno. Tente novamente.',
  'deadline-exceeded':  'A operação demorou demais. Verifique sua conexão.',
};

/** Converte um erro de Cloud Function em mensagem legível para a usuária. */
export function msgErro(err) {
  const code = err?.code || '';
  return _MSGS_ERRO[code] || err?.message || 'Erro inesperado. Tente novamente.';
}

// ─── Helper central ────────────────────────────────────────────────────────────

// Token expirado: tenta renovar e faz uma segunda tentativa.
// Se a renovação também falhar, faz logout e redireciona para o login.
// Cobre todas as páginas e plataformas (iOS, Android, desktop).
async function _renovarOuLogout() {
  try {
    await auth.currentUser?.getIdToken(true);
    return true; // renovado com sucesso → pode tentar de novo
  } catch (_) {
    await signOut(auth).catch(() => {});
    window.location.href = 'login.html';
    return false;
  }
}

async function _logoutImediato() {
  await signOut(auth).catch(() => {});
  window.location.href = 'login.html';
}

// Chamadas de mentorada: unauthenticated → tenta renovar, falha → login.
function call(nome) {
  const fn = httpsCallable(functions, nome);
  return async (dados) => {
    try {
      const result = await fn(dados);
      return result.data;
    } catch (err) {
      if (err.code === 'functions/unauthenticated') {
        const renovado = await _renovarOuLogout();
        if (!renovado) throw { code: 'unauthenticated', message: msgErro(err) };
        try {
          const retry = await fn(dados);
          return retry.data;
        } catch (retryErr) {
          await _logoutImediato();
          throw { code: retryErr.code || 'unknown', message: msgErro(retryErr) };
        }
      }
      throw { code: err.code || 'unknown', message: msgErro(err) };
    }
  };
}

// Chamadas admin: unauthenticated → tenta renovar; permission-denied → logout imediato.
// Se a claim admin foi revogada com a sessão aberta, a usuária é redirecionada para login.
function adminCall(nome) {
  const fn = httpsCallable(functions, nome);
  return async (dados) => {
    try {
      const result = await fn(dados);
      return result.data;
    } catch (err) {
      if (err.code === 'functions/unauthenticated') {
        const renovado = await _renovarOuLogout();
        if (!renovado) throw { code: 'unauthenticated', message: msgErro(err) };
        try {
          const retry = await fn(dados);
          return retry.data;
        } catch (retryErr) {
          await _logoutImediato();
          throw { code: retryErr.code || 'unknown', message: msgErro(retryErr) };
        }
      }
      if (err.code === 'functions/permission-denied') {
        await _logoutImediato();
      }
      throw { code: err.code || 'unknown', message: msgErro(err) };
    }
  };
}

// ─── UID do usuário logado ─────────────────────────────────────────────────────

let _viewAsUid = null;

/** Define um UID de mentorada para ser usado em lugar do usuário logado.
 *  Chamado pelas sub-páginas quando acessadas com ?viewAs=uid pelo admin. */
export function setViewAsUid(uid) { _viewAsUid = uid || null; }

export function uidAtual() {
  if (_viewAsUid) return _viewAsUid;
  // Fallback ao localStorage — cobre casos onde setViewAsUid não foi chamado
  // (cache antigo, nova aba, bfcache). localStorage persiste entre abas/navegações.
  const lsUid = localStorage.getItem('viewAsUid');
  if (lsUid) return lsUid;
  const user = auth.currentUser;
  if (!user) throw { code: 'unauthenticated', message: 'Usuária não está logada.' };
  return user.uid;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

/**
 * Retorna orçamento do mês atual, patrimônio, reservas e perfil.
 * Usado por index.html.
 */
export const getDashboard     = call('getDashboard');
export const getDashboardHome = call('getDashboardHome');

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

/**
 * Soma o valor aportado à classe indicada na aba patrimônio.
 * @param {string} classe  - label exibido na UI (ex: 'RF Pós')
 * @param {number} valor
 */
export async function aportePatrimonio(classe, valor) {
  return call('aportePatrimonio')({ uid: uidAtual(), classe, valor });
}

/**
 * Debita `valor` proporcionalmente de todos os ativos financeiros — operação atômica.
 * @param {number} valor — valor positivo a ser debitado
 */
export async function debitarPatrimonio(valor) {
  return call('debitarPatrimonio')({ uid: uidAtual(), valor });
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

// ─── Histórico de PL ──────────────────────────────────────────────────────────

/**
 * @returns {Promise<Array<{data: string, ativos: number, dividas: number, pl: number}>>}
 */
export async function getHistoricoPatrimonio() {
  return call('getHistoricoPatrimonio')({ uid: uidAtual() });
}

/**
 * Grava snapshot do mês atual. Chamar após qualquer alteração de patrimônio.
 * @param {number} ativos  - total de ativos em R$
 * @param {number} dividas - total de dívidas em R$
 */
export async function upsertHistoricoPatrimonio(ativos, dividas) {
  return call('upsertHistoricoPatrimonio')({ uid: uidAtual(), ativos, dividas });
}

/**
 * Parseia o CSV de dívidas gerado pelo Agente de Patrimônio.
 *
 * Formato esperado:
 *   nome,tipo,saldo,parcela,termino
 *   Financiamento imobiliário,financiamento,250000,2500,2035-06
 *
 * Colunas obrigatórias: nome, tipo, saldo
 * Colunas opcionais: parcela (default 0), termino (default '')
 *
 * Tipos aceitos: financiamento | carro | emprestimo | cartao | outro
 * (o parser normaliza variações como "empréstimo", "cartão de crédito", etc.)
 *
 * @param {string} csvText
 * @returns {Array<{id, nome, tipo, saldo, parcela, termino}>}
 */
export function parsearCsvDividas(csvText) {
  const TIPO_ALIAS = {
    'financiamento': 'financiamento', 'financiamento imobiliario': 'financiamento',
    'financiamento imobiliário': 'financiamento', 'hipoteca': 'financiamento',
    'carro': 'carro', 'veiculo': 'carro', 'veículo': 'carro',
    'financiamento de veiculo': 'carro', 'financiamento de veículo': 'carro',
    'financiamento auto': 'carro', 'automovel': 'carro', 'automóvel': 'carro',
    'emprestimo': 'emprestimo', 'empréstimo': 'emprestimo',
    'emprestimo pessoal': 'emprestimo', 'empréstimo pessoal': 'emprestimo',
    'consignado': 'emprestimo', 'credito pessoal': 'emprestimo', 'crédito pessoal': 'emprestimo',
    'cartao': 'cartao', 'cartão': 'cartao',
    'cartao de credito': 'cartao', 'cartão de crédito': 'cartao',
    'fatura': 'cartao',
    'outro': 'outro', 'outros': 'outro', 'other': 'outro',
  };

  const linhas = csvText.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (linhas.length < 2) throw new Error('CSV vazio ou sem dados.');

  const primeiraLinha = linhas[0];
  const sep = primeiraLinha.includes('\t') ? '\t'
            : primeiraLinha.includes(';')  ? ';'
            : ',';

  const cabecalho = primeiraLinha.split(sep).map(c => c.trim().toLowerCase());

  const ALIAS_NOME    = ['nome', 'descricao', 'descrição', 'description', 'divida', 'dívida', 'credito', 'crédito'];
  const ALIAS_TIPO    = ['tipo', 'type', 'category', 'categoria'];
  const ALIAS_SALDO   = ['saldo', 'saldo_devedor', 'valor', 'value', 'amount', 'montante', 'divida_total', 'dívida_total'];
  const ALIAS_PARCELA = ['parcela', 'parcela_mensal', 'prestacao', 'prestação', 'mensalidade', 'installment'];
  const ALIAS_TERMINO = ['termino', 'término', 'termino_previsto', 'término_previsto', 'vencimento', 'end_date', 'data_termino'];

  const idxNome    = ALIAS_NOME   .map(n => cabecalho.indexOf(n)).find(i => i !== -1) ?? -1;
  const idxTipo    = ALIAS_TIPO   .map(n => cabecalho.indexOf(n)).find(i => i !== -1) ?? -1;
  const idxSaldo   = ALIAS_SALDO  .map(n => cabecalho.indexOf(n)).find(i => i !== -1) ?? -1;
  const idxParcela = ALIAS_PARCELA.map(n => cabecalho.indexOf(n)).find(i => i !== -1) ?? -1;
  const idxTermino = ALIAS_TERMINO.map(n => cabecalho.indexOf(n)).find(i => i !== -1) ?? -1;

  if (idxNome === -1 || idxSaldo === -1) {
    throw new Error(`CSV inválido: colunas esperadas são "nome" e "saldo". Colunas encontradas: ${cabecalho.join(', ')}.`);
  }

  return linhas.slice(1).map((linha, i) => {
    const cols   = linha.split(sep).map(c => c.trim());
    const nome   = cols[idxNome]?.trim() || '';
    if (!nome) return null;

    const tipoRaw = idxTipo !== -1 ? (cols[idxTipo]?.trim().toLowerCase() || '') : '';
    const tipo    = TIPO_ALIAS[tipoRaw] || 'outro';

    const saldo   = parseFloat(cols[idxSaldo]?.replace(',', '.'));
    if (isNaN(saldo)) throw new Error(`Linha ${i + 2}: saldo inválido "${cols[idxSaldo]}".`);

    const parcelaRaw = idxParcela !== -1 ? cols[idxParcela] : '';
    const parcela    = parseFloat(parcelaRaw?.replace(',', '.')) || 0;

    const termino = idxTermino !== -1 ? (cols[idxTermino]?.trim() || '') : '';

    return {
      id: `d${Date.now()}_${i}`,
      nome, tipo, saldo, parcela, termino,
    };
  }).filter(Boolean);
}

// ─── Admin ────────────────────────────────────────────────────────────────────

/**
 * Bootstrap: configura claim admin=true para a conta master (flaviasch@gmail.com).
 * Só funciona para esse e-mail — chamado automaticamente em index.html quando necessário.
 */
export const bootstrapAdmin = call('bootstrapAdmin');

export const getMentoradas = adminCall('getMentoradas');

/**
 * @param {{ nome, email, inicio, perfil, produto, valorMensal, formaPagamento, dataExpiracao }} dados
 * @returns {Promise<{ uid, sheetId }>}
 */
export const createMentorada = adminCall('createMentorada');

/**
 * @param {string} uid
 * @param {{ status?, nota?, perfil?, inicio?, produto?, valorMensal?, formaPagamento?, dataExpiracao? }} campos
 */
export async function updateMentorada(uid, campos) {
  return adminCall('updateMentorada')({ uid, campos });
}

export async function bloquearMentorada(uid) {
  return adminCall('bloquearMentorada')({ uid });
}

export async function reativarMentorada(uid) {
  return adminCall('reativarMentorada')({ uid });
}

export async function deletarMentorada(uid) {
  return adminCall('deletarMentorada')({ uid });
}

/** Reenvía o link de definição de senha para a mentorada (admin only). */
export async function reenviarAcesso(uid) {
  return adminCall('reenviarAcesso')({ uid });
}

export async function criarPlanilha(uid) {
  return adminCall('criarPlanilha')({ uid });
}

/**
 * Lê a página Notion da mentorada e retorna dados de CRM:
 * último encontro (numero, tema, data) e lições de casa pendentes.
 * @param {string} uid
 */
export async function getNotionCRM(uid) {
  return adminCall('getNotionCRM')({ uid });
}

/** Retorna todos os encontros da mentorada com lições pendentes e concluídas. */
export async function getMinhaJornada(uid) {
  return adminCall('getMinhaJornada')(uid ? { uid } : {});
}

/** Registra acesso da aluna (chamar no load do dashboard). */
export const registrarAcesso = call('registrarAcesso');

/** Registra aceite do termo LGPD. */
export const aceitarLGPD = call('aceitarLGPD');

// ─── Score de Saúde Financeira ───────────────────────────────────────────────

/** Salva o score do mês no Firestore (chamado pelo orcamento.html após o cálculo). */
export const salvarScoreMes   = call('salvarScoreMes');

/** Retorna os últimos 12 scores mensais da mentorada. */
export const getScoreHistorico = call('getScoreHistorico');

// ─── Contratos & Cobranças ────────────────────────────────────────────────────

/** Cria contrato com parcelas. */
export async function createContrato(dados) {
  return adminCall('createContrato')(dados);
}

/** Lista contratos de uma mentorada com suas cobranças. */
export async function getContratos(uid) {
  return adminCall('getContratos')({ uid });
}

/** Registra pagamento de uma parcela. */
export async function pagarParcela(dados) {
  return adminCall('pagarParcela')(dados);
}

/** Edita data e valor de um pagamento já registrado. */
export async function editarPagamento(dados) {
  return adminCall('editarPagamento')(dados);
}

/** Estorna um pagamento já registrado — reverte para pendente. */
export async function estornarPagamento(cobrancaId) {
  return adminCall('estornarPagamento')({ cobrancaId });
}

/** Cancela um contrato. */
export async function cancelarCobranca(cobrancaId) {
  return adminCall('cancelarCobranca')({ cobrancaId });
}

export async function cancelarContrato(uid, contratoId) {
  return adminCall('cancelarContrato')({ uid, contratoId });
}

/** Edita produto, forma de pagamento e periodicidade de um contrato. */
export async function editarContrato(uid, contratoId, dados) {
  return adminCall('editarContrato')({ uid, contratoId, ...dados });
}

/** Retorna cobranças do mês para o hub financeiro. */
export async function getCobrancas(mes, ano, uid) {
  return adminCall('getCobrancas')({ mes, ano, uid: uid || null });
}

// ─── CRM Pipeline ────────────────────────────────────────────────────────────

/** Retorna todos os leads (filtros opcionais: segmento, estagio, origem). */
export async function getLeads(filtros = {}) {
  return adminCall('getLeads')(filtros);
}

/** Cria um novo lead. */
export async function saveLead(lead) {
  return adminCall('saveLead')(lead);
}

/** Atualiza campos de um lead. */
export async function updateLead(id, campos) {
  return adminCall('updateLead')({ id, ...campos });
}

/** Deleta um lead. */
export async function deleteLead(id) {
  return adminCall('deleteLead')({ id });
}

/** Importa múltiplos leads de uma vez (batch). */
export async function bulkImportLeads(leads) {
  return adminCall('bulkImportLeads')({ leads });
}

/** Sincroniza leads novos da planilha de diagnóstico. */
export async function syncDiagnostico() {
  return adminCall('syncDiagnostico')({});
}

/** Descobre e salva notionPageId para todas as mentoradas que ainda não têm. */
export async function bootstrapNotionPageIds() {
  return adminCall('bootstrapNotionPageIds')({});
}

// ─── Mapa de cores para patrimônio (usado por patrimonio.html) ─────────────────
// Nome original do IR → código de categoria para cor na UI.
// Não usado pelo parser — apenas exportado para consulta visual.
export const PATRIMONIO_COR = {
  // ── Labels diretos de classe (adicionados manualmente ou via CSV) ──────────
  // Estes são os nomes que aparecem no campo "classe" quando o usuário
  // adiciona ativos manualmente ou o agente exporta com os labels do dashboard.
  'rf pós': 'pos', 'rf pos': 'pos', 'renda fixa pos': 'pos', 'renda fixa pós': 'pos',
  'rf pós (liquidez diária)': 'pos', 'rf pos (liquidez diaria)': 'pos',
  'rf inflação': 'infl', 'rf inflacao': 'infl',
  'renda fixa inflação': 'infl', 'renda fixa inflacao': 'infl',
  'rf pré': 'pre', 'rf pre': 'pre', 'rf pré-fixado': 'pre', 'rf pre-fixado': 'pre',
  'renda fixa pré': 'pre', 'renda fixa pre': 'pre', 'renda fixa pré-fixado': 'pre',
  'renda variável': 'rv', 'renda variavel': 'rv',
  'multimercado': 'mm', 'multi': 'mm',
  'internacional': 'int', 'internacionais': 'int',
  'alternativos': 'alt', 'alternativo': 'alt',
  'imóveis': 'imov', 'imoveis': 'imov',

  // ── Imóveis ───────────────────────────────────────────────────────────────
  'imovel': 'imov', 'imóvel': 'imov',
  'imoveis e direitos': 'imov', 'imóveis e direitos': 'imov',
  'bens imoveis': 'imov', 'bens imóveis': 'imov',
  'imovel residencial': 'imov', 'imóvel residencial': 'imov',
  'imovel comercial': 'imov', 'imóvel comercial': 'imov',
  'predio': 'imov', 'prédio': 'imov',
  'apartamento': 'imov', 'casa': 'imov',
  'terreno': 'imov', 'lote': 'imov', 'sala comercial': 'imov', 'imovel rural': 'imov',
  'imóvel rural': 'imov', 'galpao': 'imov', 'galpão': 'imov',
  // ── Veículos ──────────────────────────────────────────────────────────────
  'veiculos': 'alt', 'veículos': 'alt', 'veiculo': 'alt', 'veículo': 'alt',
  'veiculos e embarcacoes': 'alt', 'veículos e embarcações': 'alt',
  'automovel': 'alt', 'automóvel': 'alt', 'carro': 'alt', 'motocicleta': 'alt',
  'moto': 'alt', 'caminhao': 'alt', 'caminhão': 'alt',
  'onibus': 'alt', 'ônibus': 'alt',
  'embarcacao': 'alt', 'embarcação': 'alt', 'lancha': 'alt', 'barco': 'alt',
  'aeronave': 'alt', 'aviao': 'alt', 'avião': 'alt',
  // ── Contas / liquidez ─────────────────────────────────────────────────────
  'conta corrente': 'pos', 'conta bancaria': 'pos', 'conta bancária': 'pos',
  'conta salario': 'pos', 'conta salário': 'pos', 'poupanca': 'pos', 'poupança': 'pos',
  'deposito bancario': 'pos', 'depósito bancário': 'pos', 'fgts': 'pos',
  'disponibilidades': 'pos', 'caixa': 'pos', 'dinheiro em especie': 'pos',
  'aplicacoes financeiras': 'pos', 'aplicações financeiras': 'pos',
  // ── Renda Variável ────────────────────────────────────────────────────────
  'acoes': 'rv', 'ações': 'rv', 'fii': 'rv', 'fiis': 'rv',
  'participacoes societarias': 'rv', 'participações societárias': 'rv',
  'etf': 'rv', 'etfs': 'rv',
  // ── RF Inflação ───────────────────────────────────────────────────────────
  'debentures': 'infl', 'debêntures': 'infl', 'cri': 'infl', 'cra': 'infl',
  'tesouro ipca': 'infl', 'ntnb': 'infl',
  // ── RF Pré ────────────────────────────────────────────────────────────────
  'tesouro prefixado': 'pre', 'ltn': 'pre', 'prefixado': 'pre',
  // ── Multimercado / Previdência ────────────────────────────────────────────
  'previdencia privada': 'mm', 'previdência privada': 'mm',
  'pgbl': 'mm', 'vgbl': 'mm', 'fundos': 'mm',
  // ── Internacional ─────────────────────────────────────────────────────────
  'ativos internacionais': 'int', 'investimentos internacionais': 'int',
  'bdr': 'int', 'bdrs': 'int', 'exterior': 'int', 'moeda estrangeira': 'int',
  // ── Alternativos ──────────────────────────────────────────────────────────
  'cripto': 'alt', 'criptomoedas': 'alt', 'bitcoin': 'alt',
  'ouro': 'alt', 'coe': 'alt', 'joias': 'alt', 'jóias': 'alt',
  'consorcio': 'alt', 'consórcio': 'alt', 'outros bens': 'alt', 'outros': 'alt',
};

// ─── Utilitários de parse de CSV ───────────────────────────────────────────────

/**
 * Parseia o CSV do Raio-X para o formato esperado por saveOrcamento.
 *
 * Formato mínimo (legado):   categoria,tipo,valor
 * Formato completo (v2):     data,descricao,categoria,tipo,valor
 * Coluna opcional "Fixa":    S/N — quando S, o item recebe `fixa: true` (usado para cadastro automático de recorrentes)
 * Colunas opcionais aceitam qualquer ordem; separador auto-detectado (,;tab).
 *
 * @param {string} csvText
 * @returns {Array<{categoria, tipo, valor, data?, descricao?, fixa?}>}
 */
export function parsearCsvRaioX(csvText) {
  // Remove BOM (gerado por Excel/Numbers) e normaliza quebras de linha
  const linhas = csvText.replace(/^﻿/, '').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (linhas.length < 2) throw new Error('CSV vazio ou sem dados.');

  const primeiraLinha = linhas[0];
  const sep = primeiraLinha.includes('\t') ? '\t'
            : primeiraLinha.includes(';')  ? ';'
            : ',';

  const cabecalho = primeiraLinha.split(sep).map(c => c.trim().toLowerCase().replace(/[^a-záéíóúãõâêôçàü]/gi, ''));

  const _find = (...nomes) => nomes.map(n => cabecalho.indexOf(n)).find(i => i !== -1) ?? -1;

  const idxCategoria = _find('categoria', 'category', 'cat', 'nome', 'name');
  const idxTipo      = _find('tipo', 'type', 'natureza');
  const idxValor     = _find('valor', 'value', 'amount', 'quantia', 'preco', 'preco');
  const idxData      = _find('data', 'date', 'dt');
  const idxDescricao = _find('descricao', 'descrio', 'description', 'descricao', 'obs', 'observacao');
  const idxFixa      = _find('fixa', 'fixed', 'is_fixed', 'isfixed', 'recorrente');

  if (idxCategoria === -1 || idxTipo === -1 || idxValor === -1) {
    const encontradas = cabecalho.join(', ');
    throw new Error(`CSV inválido: colunas esperadas são "categoria", "tipo", "valor". Encontradas: ${encontradas}`);
  }

  // Padrões de linhas de totais/subtotais que devem ser ignorados
  const IGNORAR_CAT = /^(totais?|subtotais?|total\s*geral|grand\s*total|soma)$/i;
  const FIXA_SIM    = /^(s|sim|yes|1|x)$/i;

  return linhas.slice(1).reduce((acc, linha, i) => {
    const cols = linha.split(sep).map(c => c.trim());
    const catBruta = cols[idxCategoria] || '';

    // Pula linhas de totais/subtotais
    if (IGNORAR_CAT.test(catBruta.trim())) return acc;

    const tipo = cols[idxTipo]?.toLowerCase();
    if (tipo !== 'receita' && tipo !== 'despesa') {
      throw new Error(`Linha ${i + 2}: tipo inválido "${cols[idxTipo]}". Use "receita" ou "despesa".`);
    }
    const valor = parseFloat(cols[idxValor]?.replace(',', '.'));
    if (isNaN(valor)) throw new Error(`Linha ${i + 2}: valor inválido "${cols[idxValor]}".`);
    const item = { categoria: catBruta || 'Sem categoria', tipo, valor };
    if (idxData      !== -1 && cols[idxData])      item.data      = cols[idxData];
    if (idxDescricao !== -1 && cols[idxDescricao]) item.descricao = cols[idxDescricao];
    if (idxFixa      !== -1 && FIXA_SIM.test(cols[idxFixa] || '')) item.fixa = true;
    acc.push(item);
    return acc;
  }, []);
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

// ─── Comunicados (admin only) ────────────────────────────────────────────────

/** Dispara e-mail de novidades para todas as mentoradas ativas. Admin only. */
export async function anunciarNovidades() {
  return call('anunciarNovidades')({});
}

/** Dispara e-mail de novidades Jun/2026 v2 (conteúdo correto das melhorias). Admin only. */
export async function anunciarNovidadesJun2026() {
  return call('anunciarNovidadesJun2026')({});
}

/** Dispara e-mail de novidades Jun/2026 v3 — texto livre + CSV por mês. Admin only. */
export async function anunciarNovidadesJun2026v3() {
  return call('anunciarNovidadesJun2026v3')({});
}

/** Comunica nova aba Minha Jornada para mentoradas em processo. Admin only. */
export async function anunciarJornadaDashboard() {
  return call('anunciarJornadaDashboard')({});
}

/** Envia link de redefinição de senha via Gmail (substitui sendPasswordResetEmail do Firebase). */
export async function solicitarRedefinicaoSenha(email) {
  return call('solicitarRedefinicaoSenha')({ email });
}

/** Edita o vencimento de uma cobrança pendente. Admin only. */
export async function editarVencimento(cobrancaId, novoVencimento) {
  return call('editarVencimento')({ cobrancaId, novoVencimento });
}

/** Envia comunicado técnico (instabilidade/reinstalação do app) para todas as ativas. Admin only. */
export async function comunicadoTecnico() {
  return call('comunicadoTecnico')({});
}

/** Migra dados de orçamento do Sheets para Firestore. Admin only. */
export async function migrarOrcamento() {
  return call('migrarOrcamento')({});
}

/**
 * Exporta todos os dados pessoais da usuária (LGPD portabilidade).
 * @returns {Promise<Object>} JSON com todos os dados
 */
export async function exportarMeusDados() {
  return call('exportarMeusDados')({ uid: uidAtual() });
}

// ─── Planejamento de orçamento por mês ───────────────────────────────────────

/**
 * Retorna o planejamento de categorias para um mês/ano específico.
 * @param {number} mes - 1 a 12
 * @param {number} ano
 * @returns {Promise<Array<{nome, limite}>>}
 */
export async function getCategoriasMes(mes, ano) {
  const res = await call('getCategoriasMes')({ uid: uidAtual(), mes, ano });
  return res?.categorias || [];
}

/**
 * Salva o planejamento de categorias para um mês/ano específico.
 * @param {number} mes
 * @param {number} ano
 * @param {Array<{nome, limite}>} categorias
 */
export async function saveCategoriasMes(mes, ano, categorias) {
  return call('saveCategoriasMes')({ uid: uidAtual(), mes, ano, categorias });
}

// ─── Categorias globais (legacy) ─────────────────────────────────────────────
export async function getCategorias() {
  const res = await call('getCategorias')({ uid: uidAtual() });
  return res?.categorias || [];
}
export async function saveCategorias(categorias) {
  return call('saveCategorias')({ uid: uidAtual(), categorias });
}

// ─── Clube Trilogia ───────────────────────────────────────────────────────────

/** Retorna todos os itens publicados no Clube (requer assinaturaClube: true). */
export const getClubeContent = call('getClubeContent');

/** Cria ou atualiza um item no Clube. Somente admin. */
export async function saveClubeItem(item) {
  return call('saveClubeItem')(item);
}

/** Deleta um item do Clube. Somente admin. */
export async function deleteClubeItem(id) {
  return call('deleteClubeItem')({ id });
}

// ─── RECORRENTES ─────────────────────────────────────────────────────────────

export async function getRecorrentes() {
  return call('getRecorrentes')({ uid: uidAtual() });
}

export async function saveRecorrente(recorrente) {
  return call('saveRecorrente')({ uid: uidAtual(), recorrente });
}

export async function deleteRecorrente(id) {
  return call('deleteRecorrente')({ uid: uidAtual(), id });
}

// ─── Parcelamento ─────────────────────────────────────────────────────────────

/** Cria N lançamentos parcelados a partir de uma compra. */
export async function saveParcelamento(dados) {
  return call('saveParcelamento')(dados);
}

/** Remove parcelas futuras de um parcelamentoId. */
export async function cancelarParcelamento(uid, parcelamentoId) {
  return call('cancelarParcelamento')({ uid, parcelamentoId });
}

// ─── CARTÕES ──────────────────────────────────────────────────────────────────

export async function getCartoes() {
  return call('getCartoes')({ uid: uidAtual() });
}

export async function saveCartao(cartao) {
  return call('saveCartao')({ uid: uidAtual(), cartao });
}

export async function deleteCartao(id) {
  return call('deleteCartao')({ uid: uidAtual(), id });
}

// ─── PUSH NOTIFICATIONS ──────────────────────────────────────────────────────

export async function savePushSubscription(subscription) {
  return call('savePushSubscription')({ subscription });
}

export async function deletePushSubscription(endpoint) {
  return call('deletePushSubscription')({ endpoint });
}

export async function enviarPushManual({ titulo, corpo, url }) {
  return call('enviarPushManual')({ titulo, corpo, url });
}

export async function saveMissaoMes({ titulo, descricao }) {
  return call('saveMissaoMes')({ titulo, descricao });
}

export async function getComunicadosStatus() {
  return call('getComunicadosStatus')({});
}

// ─── ANALYTICS ───────────────────────────────────────────────────────────────

export function registrarEvento(evento) {
  // Fire-and-forget — nunca bloqueia a UI
  call('registrarEvento')({ evento }).catch(() => {});
}

export async function getAnalytics(uid) {
  return call('getAnalytics')({ uid });
}

export async function getAdmins()              { return call('getAdmins')({}); }
export async function addAdmin(email, nome)    { return call('addAdmin')({ email, nome }); }
export async function removeAdmin(uid)         { return call('removeAdmin')({ uid }); }
export async function getBackupStatus()        { return call('getBackupStatus')({}); }
