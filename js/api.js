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

// Chamadas da conta PJ (Dashboard PJ, 24/07/2026): mesma lógica de `call()`,
// mas redireciona pra login-pj.html em vez de login.html — página de login
// separada (mesmo Firebase Auth, mesmo e-mail possível em PF e PJ, ver
// dashboard-pj/BLUEPRINT.md).
async function _renovarOuLogoutPJ() {
  try {
    await auth.currentUser?.getIdToken(true);
    return true;
  } catch (_) {
    await signOut(auth).catch(() => {});
    window.location.href = 'login-pj.html';
    return false;
  }
}
async function _logoutImediatoPJ() {
  await signOut(auth).catch(() => {});
  window.location.href = 'login-pj.html';
}
function callPJ(nome) {
  const fn = httpsCallable(functions, nome);
  return async (dados) => {
    try {
      const result = await fn(dados);
      return result.data;
    } catch (err) {
      if (err.code === 'functions/unauthenticated') {
        const renovado = await _renovarOuLogoutPJ();
        if (!renovado) throw { code: 'unauthenticated', message: msgErro(err) };
        try {
          const retry = await fn(dados);
          return retry.data;
        } catch (retryErr) {
          await _logoutImediatoPJ();
          throw { code: retryErr.code || 'unknown', message: msgErro(retryErr) };
        }
      }
      if (err.code === 'functions/permission-denied') {
        await _logoutImediatoPJ();
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
  // Usuário secundário do Dashboard PJ (02/09/2026) — chave própria, separada
  // de 'viewAsUid' (que é exclusiva do "ver como" do admin, com seu próprio
  // banner/lógica de "voltar ao admin"). Os dados sempre são os da titular
  // (pjSubUserOwnerUid), mesmo a autenticação sendo de outra conta — a
  // permissão de fato é sempre checada no servidor (requireContaPJAccess),
  // nunca só por este valor estar presente no client.
  const subOwnerUid = localStorage.getItem('pjSubUserOwnerUid');
  if (subOwnerUid) return subOwnerUid;
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
 * @param {boolean} [permitirReducao] - confirma que uma redução grande da lista
 *   (ou o desaparecimento de um tipo inteiro de lançamento) é intencional.
 *   Só usar em substituições completas de propósito (import de CSV, dedup) —
 *   deixar de fora em qualquer fluxo que só deveria adicionar/editar itens.
 */
export async function saveOrcamento(mes, ano, itens, permitirReducao) {
  return call('saveOrcamento')({ uid: uidAtual(), mes, ano, itens, ...(permitirReducao ? { permitirReducao: true } : {}) });
}

/**
 * @param {string|null} apartirDe - "YYYY-MM" opcional. Se enviado, só
 * atualiza meses >= apartirDe (escopo "este e os próximos"); sem ele,
 * atualiza todos os meses, inclusive passados (escopo "todos").
 */
export async function atualizarRecorrenteEmTodos(recorrenteId, valor, descricao, apartirDe = null) {
  return call('atualizarRecorrenteEmTodos')({ uid: uidAtual(), recorrenteId, valor, descricao, apartirDe });
}

// ─── Fatura estados ───────────────────────────────────────────────────────────

export async function getFaturaEstados() {
  return call('getFaturaEstados')({ uid: uidAtual() });
}

export async function saveFaturaEstado(cartaoId, faturaKey, updates) {
  return call('saveFaturaEstado')({ uid: uidAtual(), cartaoId, faturaKey, ...updates });
}

// ─── Patrimônio ───────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ativos: Array, dividas: Array, corretoraPosicoes: Array<{id, nome, itens, total, atualizadoEm}>}>}
 */
export async function getPatrimonio() {
  return call('getPatrimonio')({ uid: uidAtual() });
}

/**
 * Leitura mínima do nível de acesso — usada como guard nas páginas que não
 * chamam getDashboard/getDashboardHome (patrimonio.html, reservas.html, perfil.html).
 * @returns {Promise<{nivelAcesso: string|null}>} nivelAcesso === 'raio-x' → só Orçamento liberado.
 */
export async function getNivelAcesso() {
  return call('getNivelAcesso')({ uid: uidAtual() });
}

/**
 * Envia extrato/fatura para categorização via IA (substitui o Agente Raio-X do ChatGPT).
 * @param {string} conteudo — texto colado, ou base64 (sem prefixo data:) de PDF/imagem
 * @param {'texto'|'pdf'|'imagem'} tipoConteudo
 * @param {string[]} [nomesCartoes] — nomes dos cartões ativos da usuária, ajuda a IA a
 *   reconhecer pagamento de fatura (ex: "PAGTO ELETRON COBRANCA BANCO XP S.A") mesmo quando
 *   a linha não diz "cartão"/"fatura" explicitamente (achado 14/07/2026).
 * @returns {Promise<{itens: Array}>} mesmo formato de parsearCsvRaioX — usar do mesmo jeito.
 */
export async function categorizarExtratoIA(conteudo, tipoConteudo, nomesCartoes = []) {
  return call('categorizarExtratoIA')({ uid: uidAtual(), conteudo, tipoConteudo, nomesCartoes });
}

/**
 * Salva a categoria que a usuária confirmou para um estabelecimento cuja
 * categorização a IA marcou como incerta — passa a ser aplicada automaticamente
 * em futuras importações via categorizarExtratoIA.
 */
export async function salvarCategoriaAprendida(descricao, categoria) {
  return call('salvarCategoriaAprendida')({ uid: uidAtual(), descricao, categoria });
}

/**
 * Envia declaração de IR, posição de corretora, ou lista de dívidas para
 * classificação via IA (substitui o Agente de Patrimônio e o Agente de
 * Investimentos do ChatGPT).
 * @param {string} conteudo — texto colado, ou base64 (sem prefixo data:) de PDF/imagem
 * @param {'texto'|'pdf'|'imagem'} tipoConteudo
 * @param {'ativos'|'dividas'} modo
 * @param {'ir'|'corretora'} [origem] — obrigatório quando modo === 'ativos'. 'ir' extrai
 *   SÓ bens não financeiros (imóveis, bens móveis); 'corretora' extrai SÓ ativos
 *   financeiros. De propósito, para o IR (1x/ano) nunca desatualizar o que a
 *   corretora mantém mês a mês.
 * @returns {Promise<{itens: Array}>} modo 'ativos' + origem 'ir' → mesmo formato de
 *   parsearCsvPatrimonio ([{classe, valor}]); modo 'ativos' + origem 'corretora' → item a
 *   item, não agregado, com confiança da classificação ([{nome, classe, valor, confianca:
 *   'alta'|'baixa'}]) — some por classe só depois da usuária revisar os de baixa confiança;
 *   modo 'dividas' → mesmo formato de parsearCsvDividas, sem "id" (gere o id antes de
 *   chamar saveDivida, igual já se faz com o resultado do CSV).
 */
export async function categorizarPatrimonioIA(conteudo, tipoConteudo, modo, origem) {
  return call('categorizarPatrimonioIA')({ uid: uidAtual(), conteudo, tipoConteudo, modo, origem });
}

/**
 * Salva ativos do IR (declaração, 1x/ano — sempre uma posição só).
 * Corretora usa saveCorretoraPosicao (suporta mais de uma posição).
 * @param {Array<{classe, valor}>} itens
 * @param {'ir'} tipo
 */
export async function savePatrimonio(itens, tipo) {
  return call('savePatrimonio')({ uid: uidAtual(), itens, tipo });
}

/**
 * Cria ou atualiza UMA posição nomeada da corretora — dá pra ter mais de
 * uma (casal, mais de uma corretora) sem uma sobrescrever a outra.
 * @param {Array<{classe, valor}>} itens
 * @param {string} nome — nome da posição (ex: "XP - Flávia")
 * @param {string} [posicaoId] — omitir pra criar nova; informar pra atualizar uma existente
 * @returns {Promise<{ok: boolean, posicaoId: string}>}
 */
export async function saveCorretoraPosicao(itens, nome, posicaoId) {
  return call('saveCorretoraPosicao')({ uid: uidAtual(), itens, nome, posicaoId });
}

/** Remove uma posição inteira da corretora, sem afetar as demais. */
export async function deleteCorretoraPosicao(posicaoId) {
  return call('deleteCorretoraPosicao')({ uid: uidAtual(), posicaoId });
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
 * Registra a venda de um bem não financeiro (imóvel, veículo, bem móvel):
 * baixa o valor declarado na classe do bem e credita o valor de venda na
 * classe financeira de destino, na mesma transação — evita que o patrimônio
 * fique inflado até a próxima reimportação de IR.
 * @param {string} classeBem      - classe do bem no IR (ex: 'Imóveis')
 * @param {number} valorBaixa     - valor declarado que sai dessa classe
 * @param {string} classeDestino  - classe financeira que recebe a venda
 * @param {number} valorVenda     - valor de venda recebido
 */
export async function venderBemPatrimonio(classeBem, valorBaixa, classeDestino, valorVenda) {
  return call('venderBemPatrimonio')({ uid: uidAtual(), classeBem, valorBaixa, classeDestino, valorVenda });
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
 * Corrige manualmente o snapshot de um mês específico (admin only, uso pontual).
 * @param {string} uid
 * @param {string} mesKey - formato YYYY-MM
 * @param {number} ativos
 * @param {number} dividas
 */
export async function corrigirHistoricoMes(uid, mesKey, ativos, dividas) {
  return call('corrigirHistoricoMes')({ uid, mesKey, ativos, dividas });
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

// ─── Materiais da Jornada (jornada.html — seção "Ferramentas da sua Jornada") ──

/** Retorna o status/respostas salvas de todas as ferramentas da mentorada. */
export async function getMateriaisJornada() {
  return call('getMateriaisJornada')({ uid: uidAtual() });
}

/** Admin: retorna o status/respostas salvas de todas as ferramentas de outra mentorada (ex: ISF na ficha). */
export async function getMateriaisJornadaAdmin(uid) {
  return adminCall('getMateriaisJornada')({ uid });
}

/** Admin: salva/edita o progresso de uma ferramenta de outra mentorada (ex: ISF inicial lançado manualmente na ficha). */
export async function salvarMaterialJornadaAdmin(uid, ferramentaId, respostas, status) {
  return adminCall('salvarMaterialJornada')({ uid, ferramentaId, respostas, status });
}

/** Salva (upsert) o progresso de uma ferramenta da Jornada. */
export async function salvarMaterialJornada(ferramentaId, respostas, status) {
  return call('salvarMaterialJornada')({ uid: uidAtual(), ferramentaId, respostas, status });
}

/** Registra uma nova decisão financeira (fluxo P.A.R.I.S. + Anti-Impulso). */
export async function registrarDecisaoFinanceira(descricaoCompra, paris, antiImpulso, decisao) {
  return call('registrarDecisaoFinanceira')({ uid: uidAtual(), descricaoCompra, paris, antiImpulso, decisao });
}

/** Lista o histórico de decisões financeiras já registradas. */
export async function getDecisoesFinanceiras() {
  return call('getDecisoesFinanceiras')({ uid: uidAtual() });
}

/** Roda o motor de simulação do Mapa da Liberdade Financeira e salva os inputs. */
export async function simularLiberdadeFinanceira(dados) {
  return call('simularLiberdadeFinanceira')({ uid: uidAtual(), ...dados });
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

// ─── Impostos previstos (provisionamento a partir de notas emitidas) ─────────

// Retrofit 24/07/2026 (auditoria de segurança): as 3 coleções por trás
// destas funções ganharam segregação por uid — pré-requisito pro Dashboard
// PJ. `uid` agora é sempre o primeiro parâmetro, obrigatório.
export async function getTributosConfig(uid) {
  return adminCall('getTributosConfig')({ uid });
}
export async function saveTributoConfig(uid, dados) {
  return adminCall('saveTributoConfig')({ uid, ...dados });
}
export async function deleteTributoConfig(uid, id) {
  return adminCall('deleteTributoConfig')({ uid, id });
}
export async function getNotasEmitidas(uid, mes, ano) {
  return adminCall('getNotasEmitidas')({ uid, mes, ano });
}
export async function saveNotaEmitida(uid, dados) {
  return adminCall('saveNotaEmitida')({ uid, ...dados });
}
export async function deleteNotaEmitida(uid, id) {
  return adminCall('deleteNotaEmitida')({ uid, id });
}
export async function getImpostosPrevistos(uid, mes, ano) {
  return adminCall('getImpostosPrevistos')({ uid, mes, ano });
}
export async function editarValorImpostoPrevisto(uid, id, valor) {
  return adminCall('editarValorImpostoPrevisto')({ uid, id, valor });
}
export async function marcarImpostoPago(uid, id, pago, dataPagamento) {
  return adminCall('marcarImpostoPago')({ uid, id, pago, dataPagamento });
}
export async function deleteImpostoPrevisto(uid, id) {
  return adminCall('deleteImpostoPrevisto')({ uid, id });
}

// ─── Dashboard PJ (fatia 1: conta + onboarding) ───────────────────────────────
// Usa callPJ (não adminCall) — quem chama é a própria usuária PJ, não a
// Flávia como admin. Redireciona pra login-pj.html em caso de sessão expirada.

export async function getContaPJ(uid) {
  return callPJ('getContaPJ')({ uid });
}
export async function getStatusContaPF(uid) {
  return callPJ('getStatusContaPF')({ uid });
}
export async function salvarOnboardingPJ(uid, dados) {
  return callPJ('salvarOnboardingPJ')({ uid, ...dados });
}
export async function getOnboardingStatusPJ(uid) {
  return callPJ('getOnboardingStatusPJ')({ uid });
}

// Admin-only — chamado de admin.html, por isso usa adminCall (não callPJ):
// liga/desliga o acesso PJ de um uid, independente do PF (achado 26/07/2026).
export async function definirAcessoPJ(uid, ativo) {
  return adminCall('definirAcessoPJ')({ uid, ativo });
}

// Admin-only — lista todas as contas PJ pro painel admin (achado 29/07/2026).
export async function getContasPJTodas() {
  return adminCall('getContasPJTodas')({});
}

// ─── LGPD — PJ (29/07/2026, Fase Venda) ───────────────────────────────────────
export async function aceitarLGPDPJ(uid) {
  return callPJ('aceitarLGPDPJ')({ uid });
}
export async function exportarMeusDadosPJ(uid) {
  return callPJ('exportarMeusDadosPJ')({ uid });
}
// Admin-only — exclusão de conta PJ (não apaga o Firebase Auth, ver functions/index.js).
export async function excluirContaPJ(uid) {
  return adminCall('excluirContaPJ')({ uid });
}

// ─── Usuários secundários do Dashboard PJ (02/09/2026) ────────────────────────
// Caso Isabela: a titular cadastra, dentro do próprio Dashboard PJ, usuários
// com login/senha próprios e permissão granular por aba (ver
// requireContaPJAccess em functions/lib/auth.js).

/** true se o usuário logado é um usuário secundário PJ (não a titular) — lido
 *  da flag salva em login-pj.html após checar minhasPermissoesPJ(). */
export function ehUsuarioSecundarioPJ() {
  return localStorage.getItem('pjSubUserOwnerUid') !== null;
}

/** Verifica as próprias permissões (chamável por qualquer usuário logado,
 *  inclusive secundário — checa a claim pjOwnerUid e o doc no Firestore). */
export async function minhasPermissoesPJ() {
  return callPJ('minhasPermissoesPJ')({});
}

export async function criarUsuarioSecundarioPJ(uidTitular, nome, email, abasPermitidas) {
  return callPJ('criarUsuarioSecundarioPJ')({ uidTitular, nome, email, abasPermitidas });
}
export async function listarUsuariosSecundariosPJ(uidTitular) {
  return callPJ('listarUsuariosSecundariosPJ')({ uidTitular });
}
export async function editarUsuarioSecundarioPJ(uidTitular, subUid, dados) {
  return callPJ('editarUsuarioSecundarioPJ')({ uidTitular, subUid, ...dados });
}
export async function excluirUsuarioSecundarioPJ(uidTitular, subUid) {
  return callPJ('excluirUsuarioSecundarioPJ')({ uidTitular, subUid });
}

// ─── Dashboard PJ (fatia 2: Contas a Receber, Despesas, Fluxo de Caixa) ───────

export async function getRecebimentosNota(uid, notaId) {
  return callPJ('getRecebimentosNota')({ uid, notaId });
}
export async function salvarRecebimento(uid, notaId, dados) {
  return callPJ('salvarRecebimento')({ uid, notaId, ...dados });
}
export async function gerarParcelasRecebimento(uid, notaId, dados) {
  return callPJ('gerarParcelasRecebimento')({ uid, notaId, ...dados });
}
export async function confirmarRecebimento(uid, notaId, id, dataRecebimento, valorBruto, taxa) {
  return callPJ('confirmarRecebimento')({ uid, notaId, id, dataRecebimento, valorBruto, taxa });
}
export async function estornarRecebimento(uid, notaId, id) {
  return callPJ('estornarRecebimento')({ uid, notaId, id });
}
export async function deleteRecebimento(uid, notaId, id) {
  return callPJ('deleteRecebimento')({ uid, notaId, id });
}
export async function getRecebimentosPendentesPJ(uid, mes, ano) {
  return callPJ('getRecebimentosPendentesPJ')({ uid, mes, ano });
}

export async function getDespesasPJ(uid) {
  return callPJ('getDespesasPJ')({ uid });
}
export async function saveDespesaPJ(uid, dados) {
  return callPJ('saveDespesaPJ')({ uid, ...dados });
}
export async function deleteDespesaPJ(uid, id) {
  return callPJ('deleteDespesaPJ')({ uid, id });
}

export async function getContasPagarPendentesPJ(uid, mes, ano) {
  return callPJ('getContasPagarPendentesPJ')({ uid, mes, ano });
}
export async function confirmarPagamentoDespesaPJ(uid, despesaId, mesAno, dataPagamento) {
  return callPJ('confirmarPagamentoDespesaPJ')({ uid, despesaId, mesAno, dataPagamento });
}
export async function estornarPagamentoDespesaPJ(uid, despesaId, mesAno) {
  return callPJ('estornarPagamentoDespesaPJ')({ uid, despesaId, mesAno });
}
export async function cancelarOcorrenciaDespesaPJ(uid, despesaId, mesAno) {
  return callPJ('cancelarOcorrenciaDespesaPJ')({ uid, despesaId, mesAno });
}

export async function getFluxoCaixaPJ(uid, mes, ano) {
  return callPJ('getFluxoCaixaPJ')({ uid, mes, ano });
}
export async function atualizarSaldoCaixaPJ(uid, saldo) {
  return callPJ('atualizarSaldoCaixaPJ')({ uid, saldo });
}

export async function getDRESimplificadoPJ(uid, mes, ano) {
  return callPJ('getDRESimplificadoPJ')({ uid, mes, ano });
}
export async function getRelatorioAnualPJ(uid, ano) {
  return callPJ('getRelatorioAnualPJ')({ uid, ano });
}
export async function getVencimentosHojePJ(uid) {
  return callPJ('getVencimentosHojePJ')({ uid });
}
export async function getPontoEquilibrioPJ(uid, mes, ano) {
  return callPJ('getPontoEquilibrioPJ')({ uid, mes, ano });
}
export async function salvarRetiradaMinimaPJ(uid, valor) {
  return callPJ('salvarRetiradaMinimaPJ')({ uid, valor });
}
export async function salvarDespesasFixasAjusteManualPJ(uid, valor) {
  return callPJ('salvarDespesasFixasAjusteManualPJ')({ uid, valor });
}

// Sugestão de despesa recorrente → Fixa (02/09/2026)
export async function getSugestoesDespesaFixaPJ(uid) {
  return callPJ('getSugestoesDespesaFixaPJ')({ uid });
}
export async function converterDespesaParaFixaPJ(uid, despesaId) {
  return callPJ('converterDespesaParaFixaPJ')({ uid, despesaId });
}
export async function dispensarSugestaoDespesaFixaPJ(uid, nomeNormalizado) {
  return callPJ('dispensarSugestaoDespesaFixaPJ')({ uid, nomeNormalizado });
}

// Retirada Sugerida + 3 Reservas (28/07/2026, fatia final)
export async function getIndicadoresReservasPJ(uid, mes, ano) {
  return callPJ('getIndicadoresReservasPJ')({ uid, mes, ano });
}
export async function salvarReservaMinimaCaixaPJ(uid, valor) {
  return callPJ('salvarReservaMinimaCaixaPJ')({ uid, valor });
}
export async function criarReservaPJ(uid, dados) {
  return callPJ('criarReservaPJ')({ uid, ...dados });
}
export async function getReservasPJ(uid) {
  return callPJ('getReservasPJ')({ uid });
}
export async function registrarMovimentoReservaPJ(uid, reservaId, tipoMov, valor, data) {
  return callPJ('registrarMovimentoReservaPJ')({ uid, reservaId, tipoMov, valor, data });
}
export async function ajustarSaldoReservaPJ(uid, reservaId, novoSaldo, data) {
  return callPJ('ajustarSaldoReservaPJ')({ uid, reservaId, novoSaldo, data });
}
export async function excluirReservaPJ(uid, reservaId) {
  return callPJ('excluirReservaPJ')({ uid, reservaId });
}

// Pró-labore com previsibilidade (14/08/2026)
export async function getProLaborePJ(uid) {
  return callPJ('getProLaborePJ')({ uid });
}
export async function aprovarSalarioTrimestrePJ(uid, valor) {
  return callPJ('aprovarSalarioTrimestrePJ')({ uid, valor });
}
export async function salvarPercentuaisBaldesProLaborePJ(uid, percentuais) {
  return callPJ('salvarPercentuaisBaldesProLaborePJ')({ uid, ...percentuais });
}
export async function confirmarAporteBaldeExcedentePJ(uid, balde, valor) {
  return callPJ('confirmarAporteBaldeExcedentePJ')({ uid, balde, valor });
}
export async function registrarDistribuicaoLucroPJ(uid, valor) {
  return callPJ('registrarDistribuicaoLucroPJ')({ uid, valor });
}

// Importação de extrato/fatura com IA (28/07/2026)
export async function categorizarExtratoPJIA(uid, conteudo, tipoConteudo) {
  return callPJ('categorizarExtratoPJIA')({ uid, conteudo, tipoConteudo });
}

// Entradas de caixa que não são venda (aporte de sócio, reembolso, outro) —
// não passam por nota fiscal nem entram na DRE, só no Fluxo de Caixa.
export async function getOutrasEntradasPJ(uid, mes, ano) {
  return callPJ('getOutrasEntradasPJ')({ uid, mes, ano });
}
export async function saveOutraEntradaPJ(uid, dados) {
  return callPJ('saveOutraEntradaPJ')({ uid, ...dados });
}
export async function deleteOutraEntradaPJ(uid, id) {
  return callPJ('deleteOutraEntradaPJ')({ uid, id });
}
export async function criarVendaAntigaParceladaPJ(uid, dados) {
  return callPJ('criarVendaAntigaParceladaPJ')({ uid, ...dados });
}

// ─── Cartões de crédito PJ ───────────────────────────────────────────────────
export async function getCartoesPJ(uid) {
  return callPJ('getCartoesPJ')({ uid });
}
export async function saveCartaoPJ(uid, cartao) {
  return callPJ('saveCartaoPJ')({ uid, cartao });
}
export async function deleteCartaoPJ(uid, id) {
  return callPJ('deleteCartaoPJ')({ uid, id });
}
export async function lancarCompraCartaoPJ(uid, dados) {
  return callPJ('lancarCompraCartaoPJ')({ uid, ...dados });
}
export async function cancelarParcelasCartaoPJ(uid, parcelamentoId) {
  return callPJ('cancelarParcelasCartaoPJ')({ uid, parcelamentoId });
}
export async function getFaturasCartaoPJ(uid) {
  return callPJ('getFaturasCartaoPJ')({ uid });
}
export async function saveFaturaEstadoPJ(uid, dados) {
  return callPJ('saveFaturaEstadoPJ')({ uid, ...dados });
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
  // "-fixada" (concordando com "Renda Fixa", feminino) além de "-fixado" —
  // achado 20/07/2026: a IA de corretora gera "Renda Fixa Pós-fixada"/"Pré-
  // fixada", que não batia com nenhuma entrada aqui (só existia "-fixado"),
  // então ficava sem classe resolvida e sumia do comparativo em Reservas.
  'rf pós-fixada': 'pos', 'rf pos-fixada': 'pos',
  'renda fixa pós-fixada': 'pos', 'renda fixa pos-fixada': 'pos',
  'rf inflação': 'infl', 'rf inflacao': 'infl',
  'renda fixa inflação': 'infl', 'renda fixa inflacao': 'infl',
  'rf pré': 'pre', 'rf pre': 'pre', 'rf pré-fixado': 'pre', 'rf pre-fixado': 'pre',
  'renda fixa pré': 'pre', 'renda fixa pre': 'pre', 'renda fixa pré-fixado': 'pre',
  'rf pré-fixada': 'pre', 'rf pre-fixada': 'pre',
  'renda fixa pré-fixada': 'pre', 'renda fixa pre-fixada': 'pre',
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
  // ── Automóveis (classe própria — não é "Alternativos", achado 20/07/2026:
  //    colidia com a classe de Alternativos financeiros) ──────────────────────
  'automoveis': 'auto', 'automóveis': 'auto',
  'veiculos': 'auto', 'veículos': 'auto', 'veiculo': 'auto', 'veículo': 'auto',
  'veiculos e embarcacoes': 'auto', 'veículos e embarcações': 'auto',
  'automovel': 'auto', 'automóvel': 'auto', 'carro': 'auto', 'motocicleta': 'auto',
  'moto': 'auto', 'caminhao': 'auto', 'caminhão': 'auto',
  'onibus': 'auto', 'ônibus': 'auto',
  'embarcacao': 'auto', 'embarcação': 'auto', 'lancha': 'auto', 'barco': 'auto',
  'aeronave': 'auto', 'aviao': 'auto', 'avião': 'auto',
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
  // ── Alternativos (só ativos financeiros — cripto, ouro, COE, FIPs) ─────────
  'cripto': 'alt', 'criptomoedas': 'alt', 'bitcoin': 'alt',
  'ouro': 'alt', 'coe': 'alt', 'fip': 'alt', 'fips': 'alt', 'private equity': 'alt',
  // ── Bens Móveis (não financeiro — achado 20/07/2026, separado de
  //    Alternativos pra não misturar bem físico com investimento) ────────────
  'bens moveis': 'bens', 'bens móveis': 'bens',
  'joias': 'bens', 'jóias': 'bens', 'joia': 'bens', 'jóia': 'bens',
  'obras de arte': 'bens', 'obra de arte': 'bens',
  'antiguidades': 'bens', 'objetos de valor': 'bens', 'colecionaveis': 'bens',
  'consorcio': 'bens', 'consórcio': 'bens', 'consorcio nao contemplado': 'bens',
  'outros bens': 'bens', 'outros': 'bens', 'outros bens e direitos': 'bens',
};

// ─── Utilitários de parse de CSV ───────────────────────────────────────────────

const _CATEGORIAS_CODIGO = {
  // MORADIA
  1:'Aluguel', 2:'Financiamento Imóvel', 3:'IPTU', 4:'Condomínio', 5:'Manutenção',
  6:'Energia', 7:'Água', 8:'Gás', 9:'Suprimentos', 10:'Outros Moradia',
  // ALIMENTAÇÃO
  11:'Supermercado', 12:'Restaurante', 13:'Café', 14:'Barzinho',
  // COMUNICAÇÃO
  15:'Celular', 16:'Internet', 17:'Streaming', 18:'Telefonia Fixa', 19:'TV a Cabo', 20:'Outros Comunicação',
  // SAÚDE E CUIDADOS
  21:'Academia', 22:'Assistência Médica', 23:'Cabelo e Unha', 24:'Cosméticos',
  25:'Dentista', 26:'Exames médicos', 27:'Farmácia', 28:'Médicos particular',
  29:'Suplementos', 30:'Outros Saúde',
  // VESTUÁRIO
  31:'Roupas', 32:'Acessórios', 33:'Outros Vestuário',
  // PET
  34:'Veterinário', 35:'Remédios', 36:'Alimentação', 37:'Outros Pet',
  // TRANSPORTE
  40:'Aplicativos', 41:'Combustível', 42:'Estacionamento', 43:'Financiamento',
  44:'IPVA', 45:'Licenciamento', 46:'Manutenção', 47:'Passagens',
  48:'Seguro', 49:'Táxi', 50:'Transporte Público', 51:'Outros Transporte',
  // EDUCAÇÃO
  52:'Mensalidades', 53:'Idiomas', 54:'Despesas Gerais', 55:'Cursos',
  56:'Livros e Revistas', 57:'FIES', 58:'Outros Educação',
  // LAZER
  60:'Cinema', 61:'Esportes', 62:'Shows', 63:'Viagens', 64:'Outros Lazer',
  // ARTIGOS RESIDÊNCIA
  70:'Cama, Mesa e Banho', 71:'Consertos', 72:'Eletrodomésticos', 73:'Móveis',
  74:'TV, Som e Informática', 75:'Utensílios e decoração', 76:'Outros Artigos',
  // OUTROS
  80:'Presentes', 81:'Doações', 82:'Cigarro', 83:'Outros',
  // FINANCEIRO
  90:'Juros Cartão de Crédito', 91:'Empréstimos', 92:'Outros Financeiro',
  // PROJETOS DE VIDA
  93:'Reserva Financeira', 94:'Aposentadoria', 95:'Casa Própria', 96:'Outros Projetos',
};

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
    const catNum = parseInt(catBruta, 10);
    const categoria = (!isNaN(catNum) && String(catNum) === catBruta.trim() && _CATEGORIAS_CODIGO[catNum])
      ? _CATEGORIAS_CODIGO[catNum]
      : catBruta;
    const item = { categoria: categoria || 'Sem categoria', tipo, valor };
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

    // ════ AUTOMÓVEIS (→ auto) — classe própria, achado 20/07/2026: não é
    //      "Alternativos" pra não colidir com a classe financeira ═══════════

    'automoveis': 'auto', 'automóveis': 'auto',
    'veiculos': 'auto', 'veículos': 'auto', 'veiculo': 'auto', 'veículo': 'auto',
    'automovel': 'auto', 'automóvel': 'auto', 'carro': 'auto',
    'motocicleta': 'auto', 'moto': 'auto',
    'caminhao': 'auto', 'caminhão': 'auto', 'onibus': 'auto', 'ônibus': 'auto',
    'embarcacao': 'auto', 'embarcação': 'auto', 'lancha': 'auto', 'barco': 'auto',
    'aeronave': 'auto', 'aviao': 'auto', 'avião': 'auto',

    // ════ BENS MÓVEIS (→ bens) — não financeiro ═══════════════════════════

    'bens moveis': 'bens', 'bens móveis': 'bens',
    'joias': 'bens', 'jóias': 'bens', 'joia': 'bens', 'jóia': 'bens',
    'obras de arte': 'bens', 'obra de arte': 'bens',
    'antiguidades': 'bens', 'objetos de valor': 'bens', 'colecionaveis': 'bens',
    'animais': 'bens', 'semoventes': 'bens', 'gado': 'bens',
    'benfeitoria': 'bens', 'benfeitorias': 'bens',
    'consorcio': 'bens', 'consórcio': 'bens', 'consorcio nao contemplado': 'bens',
    'outros bens': 'bens', 'outros': 'bens', 'outros bens e direitos': 'bens',

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

/** Dispara e-mail completo de Junho/2026 — todas as melhorias do mês. Admin only. */
export async function anunciarNovidadesJun2026Completo() {
  return call('anunciarNovidadesJun2026Completo')({});
}

/** Dispara e-mail de novidades Jun/2026 v3 — texto livre + CSV por mês. Admin only. */
export async function anunciarNovidadesJun2026v3() {
  return call('anunciarNovidadesJun2026v3')({});
}

/** Comunica nova aba Minha Jornada para mentoradas em processo. Admin only. */
export async function anunciarJornadaDashboard() {
  return call('anunciarJornadaDashboard')({});
}

/** Dispara e-mail de novidades Jul/2026 — faturas + jornada. Admin only. */
export async function anunciarNovidadesJul2026() {
  return call('anunciarNovidadesJul2026')({});
}

/** Dispara e-mail completo de Julho/2026 — todas as melhorias do mês. Admin only. */
export async function anunciarNovidadesJul2026Completo() {
  return call('anunciarNovidadesJul2026Completo')({});
}

/** Dispara e-mail completo de Agosto/2026 — todas as melhorias do mês. Admin only. */
export async function anunciarNovidadesAgo2026Completo() {
  return call('anunciarNovidadesAgo2026Completo')({});
}

/** Dispara e-mail do modo claro/escuro + aporte sem alocação (Ago/2026). Admin only. */
export async function anunciarModoClaroAgo2026() {
  return call('anunciarModoClaroAgo2026')({});
}

/**
 * Reenvia o resumo mensal de agosto/2026 com Despesas/Sobra corrigidas —
 * correção pontual (achado 01/09/2026), não faz parte do fluxo normal.
 * Admin only.
 */
export async function corrigirRelatorioAgosto2026() {
  return call('reemitirRelatorioMensal')({ mes: 8, ano: 2026 });
}

/** Dispara e-mail de balanço Jul/2026 — Detalhe, Planejamento e despesas fixas. Admin only. */
export async function anunciarBalancoJul2026() {
  return call('anunciarBalancoJul2026')({});
}

/** Dispara e-mail de múltiplas contas correntes — Jul/2026. Admin only. */
export async function anunciarMultiplasContasJul2026() {
  return call('anunciarMultiplasContasJul2026')({});
}

/** Dispara e-mail de importar extrato com IA no Orçamento — Jul/2026. Admin only. */
export async function anunciarRaioXJul2026() {
  return call('anunciarRaioXJul2026')({});
}

/** Dispara e-mail de importar Patrimônio com IA (IR, corretora, dívidas) — Jul/2026. Admin only. */
export async function anunciarPatrimonioIAJul2026() {
  return call('anunciarPatrimonioIAJul2026')({});
}

/** Marca/desmarca lição de casa no Notion. */
export async function marcarLicaoCasa({ blockId, checked, uid }) {
  return call('marcarLicaoCasa')({ blockId, checked, uid });
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

/**
 * Atualiza (ou remove, se limite <= 0) o limite de uma única categoria no mês.
 * Faz merge no servidor (transaction) — seguro mesmo com abas/dispositivos
 * diferentes editando limites ao mesmo tempo, ao contrário de saveCategoriasMes.
 * @param {number} mes
 * @param {number} ano
 * @param {string} nome
 * @param {number} limite
 * @returns {Promise<Array<{nome, limite}>>} lista completa e atualizada
 */
export async function upsertCategoriaLimite(mes, ano, nome, limite, mae) {
  const res = await call('upsertCategoriaLimite')({ uid: uidAtual(), mes, ano, nome, limite, mae: mae || null });
  return res?.categorias || [];
}

/**
 * Renomeia uma categoria do Planejamento do mês. Se o novo nome já existir,
 * o servidor soma os limites automaticamente. Retorna { categorias, mesclou, nomeDestino }.
 */
export async function renomearCategoriaLimite(mes, ano, nomeAntigo, nomeNovo) {
  return call('renomearCategoriaLimite')({ uid: uidAtual(), mes, ano, nomeAntigo, nomeNovo });
}

/**
 * Vincula (ou remove, se mae for null) uma categoria a uma categoria-mãe
 * GLOBALMENTE — não pertence a nenhum mês, ao contrário do campo `mae` de
 * upsertCategoriaLimite. Uma vez definido, vale pra todos os meses sem
 * precisar refazer (achado 05/08/2026).
 * @returns {Promise<Array<{nome, mae}>>} lista completa e atualizada
 */
export async function upsertCategoriaMaeGlobal(nome, mae) {
  const res = await call('upsertCategoriaMaeGlobal')({ uid: uidAtual(), nome, mae: mae || null });
  return res?.vinculos || [];
}

/**
 * Retorna todos os vínculos globais categoria → categoria-mãe da mentorada,
 * e se a migração de vínculos antigos (salvos por mês) já rodou pra essa
 * conta (`migrado`) — achado 05/08/2026.
 * @returns {Promise<{vinculos: Array<{nome, mae}>, migrado: boolean}>}
 */
export async function getCategoriasMaeGlobais() {
  const res = await call('getCategoriasMaeGlobais')({ uid: uidAtual() });
  return { vinculos: res?.vinculos || [], migrado: !!res?.migrado };
}

/**
 * Migração única: promove pro vínculo global qualquer `mae` que só existia
 * dentro de um mês específico (de antes do vínculo global existir) — sem
 * isso, quem já tinha configurado categoria-mãe em meses anteriores
 * continuaria precisando refazer o vínculo em cada mês novo (achado
 * 05/08/2026, Flávia: "isso vale pras categorias mães que foram criadas em
 * meses anteriores"). Idempotente — seguro chamar mais de uma vez.
 * @returns {Promise<{vinculos: Array<{nome, mae}>, adicionados: number}>}
 */
export async function migrarCategoriasMaeLegado() {
  const res = await call('migrarCategoriasMaeLegado')({ uid: uidAtual() });
  return { vinculos: res?.vinculos || [], adicionados: res?.adicionados || 0 };
}

/**
 * Retorna a renda planejada e o percentual planejado do mês (parte do mesmo
 * documento de planejamento, não sobrepõe getCategoriasMes).
 * @param {number} mes
 * @param {number} ano
 * @returns {Promise<{renda: number|null, percentual: number|null}>}
 */
export async function getPlanejamentoMeta(mes, ano) {
  const res = await call('getCategoriasMes')({ uid: uidAtual(), mes, ano });
  return { renda: res?.renda ?? null, percentual: res?.percentual ?? null };
}

/**
 * Salva a renda planejada e o percentual planejado do mês. Faz merge no
 * servidor (transaction) — não toca em `categorias`.
 * @param {number} mes
 * @param {number} ano
 * @param {number} renda
 * @param {number} percentual
 */
export async function savePlanejamentoMeta(mes, ano, renda, percentual) {
  return call('savePlanejamentoMeta')({ uid: uidAtual(), mes, ano, renda, percentual });
}

// ─── Contas correntes (múltiplas contas) ─────────────────────────────────────

/**
 * Lista as contas da mentorada — sempre inclui a principal (mesmo sem
 * nenhuma conta cadastrada, ela vem sintetizada pelo backend).
 * @returns {Promise<Array<{id, nome, ativa, principal}>>}
 */
export async function getContas() {
  const res = await call('getContas')({ uid: uidAtual() });
  return res?.contas || [];
}

/**
 * Cria (sem id) ou atualiza/renomeia (com id) uma conta.
 * @param {{id?: string, nome: string, ativa?: boolean}} conta
 */
export async function saveConta(conta) {
  return call('saveConta')({ uid: uidAtual(), ...conta });
}

/** Arquiva ou reativa uma conta secundária (nunca a principal). */
export async function arquivarConta(id, ativa) {
  return call('arquivarConta')({ uid: uidAtual(), id, ativa });
}

/** Exclui uma conta secundária permanentemente (nunca a principal). */
export async function deletarConta(id) {
  return call('deletarConta')({ uid: uidAtual(), id });
}

/**
 * Saldo inicial de cada conta num mês.
 * @returns {Promise<{[contaId: string]: number}>}
 */
export async function getSaldosConta(mes, ano) {
  const res = await call('getSaldosConta')({ uid: uidAtual(), mes, ano });
  return res?.saldos || {};
}

/** Atualiza o saldo inicial de UMA conta no mês (merge no servidor). */
export async function saveSaldoConta(mes, ano, contaId, valor) {
  return call('saveSaldoConta')({ uid: uidAtual(), mes, ano, contaId, valor });
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

// Puladas de despesa/receita fixa, sincronizadas no servidor (achado
// 30/07/2026: antes só em localStorage, não sincronizava entre PC/celular).
export async function getFixasPuladasServidor() {
  return call('getFixasPuladas')({ uid: uidAtual() });
}
export async function adicionarFixasPuladasServidor(chaves) {
  return call('adicionarFixasPuladas')({ uid: uidAtual(), chaves });
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
