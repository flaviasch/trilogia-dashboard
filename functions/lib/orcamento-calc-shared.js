/**
 * orcamento-calc-shared.js — cópia server-side (CommonJS) de
 * dashboard/js/orcamento-calc.js, usada por Cloud Functions que precisam do
 * MESMO cálculo de despesa/sobra que orcamento.html mostra em tela (ex:
 * notifDia1 / e-mail de resumo mensal).
 *
 * Por que uma cópia e não um import direto: o deploy do Cloud Functions
 * empacota só a pasta functions/ (ver firebase.json) — dashboard/js/ não
 * viaja junto. Mesmo padrão já usado por calcularScoreMes() em index.js.
 *
 * IMPORTANTE: cópia manual — qualquer mudança em js/orcamento-calc.js
 * (despesaCaixa/sobra/despesaComprometida/gruposFechadaCaixa) precisa ser
 * replicada aqui também, ou o e-mail volta a divergir do dashboard.
 * Sincronizada com js/orcamento-calc.js em 01/09/2026 (linha a linha, achado
 * 31/08/2026 incluso: gruposFechadaCaixa só aceita fatura NATIVA do mês em
 * cálculo).
 *
 * achado 01/09/2026, Flávia: e-mail de resumo mensal (notifDia1) somava
 * direto os itens brutos do Firestore (itens.filter(tipo==='despesa')), sem
 * passar pela lógica de ciclo de fatura nem pela reconciliação de itens
 * entre meses que getOrcamento já faz. Resultado: Despesas e Sobra do
 * e-mail divergiam ~R$10,5 mil do que o dashboard mostrava pro mesmo mês.
 */

// ─── Categoria de ajuste usada quando sobra uma diferença não identificada ───
const CATEGORIA_AJUSTE = 'Lançamentos não identificados — verificar';

// ─── Helpers de data/recorrência ──────────────────────────────────────────────

function isPendenteEfetivo(item, agora = new Date()) {
  if (item.confirmado) return false;
  if (!item.data) return false;
  if (item.pendente) return true;
  if (item.recorrenteId && !item.cartao) return true;
  const hoje = new Date(agora); hoje.setHours(0, 0, 0, 0);
  return new Date(item.data + 'T00:00:00') >= hoje;
}

function normCat(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

function diasSemanaNoMes(ano, mes, diaSemana) {
  const dias = [];
  const total = new Date(ano, mes, 0).getDate();
  for (let d = 1; d <= total; d++) {
    if (new Date(ano, mes - 1, d).getDay() === diaSemana) dias.push(d);
  }
  return dias;
}

function diasEsperadosRecorrente(r, mes, ano) {
  if (r.anoInicio != null && r.mesInicio != null) {
    const antesDoInicio = ano < r.anoInicio || (ano === r.anoInicio && mes < r.mesInicio);
    if (antesDoInicio) return [];
  }
  const freq = r.frequencia || 'mensal';
  if (freq === 'semanal')   return diasSemanaNoMes(ano, mes, r.dia);
  if (freq === 'quinzenal') return [r.dia, r.dia + 14].filter(d => d >= 1 && d <= 31);
  return [r.dia];
}

function diasFaltantesRecorrente(r, despesasArr, mes, ano) {
  const esperados = diasEsperadosRecorrente(r, mes, ano);
  const ocupados = new Set(
    (despesasArr || [])
      .filter(d => d.recorrenteId === r.id || (!d.recorrenteId && d.categoria === r.categoria))
      .map(d => parseInt((d.data || '').split('-')[2], 10))
      .filter(d => !isNaN(d))
  );
  return esperados.filter(d => !ocupados.has(d));
}

// ─── Despesas fixas puladas — sem localStorage no server. Quem chamar (ex:
// notifDia1) deve passar fixasPuladas:[] explicitamente; getFixasPuladas()
// aqui só existe pra este módulo ficar espelho 1:1 do original e os testes
// client-side rodarem sem adaptação contra esta cópia.
function chaveFixaPulada(recorrenteId, ano, mes, dia) {
  return `${recorrenteId}_${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}
function getFixasPuladas() {
  try {
    if (typeof localStorage === 'undefined') return [];
    return JSON.parse(localStorage.getItem('_fixasPuladas') || '[]');
  } catch (_) { return []; }
}
function addFixaPulada(chave) {
  const atuais = getFixasPuladas();
  if (!atuais.includes(chave)) atuais.push(chave);
  const hoje = new Date();
  const limiteAntigo = new Date(hoje.getFullYear(), hoje.getMonth() - 2, 1);
  const filtradas = atuais.filter(c => {
    const m = c.match(/_(\d{4})-(\d{2})-\d{2}$/);
    if (!m) return true;
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1);
    return d >= limiteAntigo;
  });
  if (typeof localStorage !== 'undefined') localStorage.setItem('_fixasPuladas', JSON.stringify(filtradas));
  return filtradas;
}

// ─── Múltiplas contas ──────────────────────────────────────────────────────────

const CONTA_PRINCIPAL_ID = 'principal';

function pertenceAConta(item, contaId) {
  if (contaId == null) return true;
  return (item.contaId || CONTA_PRINCIPAL_ID) === contaId;
}

// ─── Agregação principal ───────────────────────────────────────────────────────

function calcularAgregadosOrcamento({
  data,
  cartoes = [],
  faturaEstados = {},
  recorrentes = [],
  fixasPuladas = null,
  agora = new Date(),
  contaId = null,
}) {
  const _contaFatura = d => faturaEstados[`${d.cartaoId}_${d.fatura}`]?.contaId || CONTA_PRINCIPAL_ID;
  const _pertenceItemDespesa = d => (d.cartao && d.fatura)
    ? (contaId == null || _contaFatura(d) === contaId)
    : pertenceAConta(d, contaId);
  data = {
    ...data,
    receitas: data.receitas.filter(r => pertenceAConta(r, contaId)),
    despesas: data.despesas.filter(_pertenceItemDespesa),
    aportes: (data.aportes || []).filter(a => pertenceAConta(a, contaId)),
    transferencias: (data.transferencias || []).filter(t => pertenceAConta(t, contaId)),
  };
  recorrentes = (recorrentes || []).filter(r => pertenceAConta(r, contaId));

  const { mes, ano } = data.periodo;
  const periodoTotal = ano * 12 + mes;
  const agoraTotal   = agora.getFullYear() * 12 + agora.getMonth() + 1;
  const ehFuturo = periodoTotal > agoraTotal;

  const saldoConta = data.saldoConta || 0;
  const totalReceita = data.receitas.filter(r => !isPendenteEfetivo(r, agora)).reduce((s, r) => s + r.valor, 0);
  let receitaComprometida = data.receitas.reduce((s, r) => s + r.valor, 0);

  const _openKeyPorCartao = {};
  (cartoes || []).forEach(c => {
    if (!c.diaCorte) return;
    const dia = agora.getDate();
    const d = new Date(agora.getFullYear(), agora.getMonth(), 1);
    if (dia > c.diaCorte) d.setMonth(d.getMonth() + 1);
    if (!c.diaVencimento || c.diaVencimento <= c.diaCorte) d.setMonth(d.getMonth() + 1);
    _openKeyPorCartao[c.id] = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const _periodoNumCalc = key => {
    const [a, m] = (key || '').split('-').map(Number);
    return (a || 0) * 12 + (m || 0);
  };
  const _faturaJaAbriu = (cartaoId, fatura) => {
    const aberta = _openKeyPorCartao[cartaoId];
    return !aberta || _periodoNumCalc(fatura) < _periodoNumCalc(aberta);
  };
  const gruposFechadaCaixa = {};
  data.despesas.forEach(d => {
    if (d.cartao && d.fatura && !d._faturaAberta && _periodoNumCalc(d.fatura) === periodoTotal && _faturaJaAbriu(d.cartaoId, d.fatura)) {
      const key = `${d.cartaoId}_${d.fatura}`;
      gruposFechadaCaixa[key] = (gruposFechadaCaixa[key] || 0) + d.valor;
    }
  });
  (data.receitas || []).forEach(r => {
    if (r.cartao && r.fatura && !r._faturaAberta && _periodoNumCalc(r.fatura) === periodoTotal && _faturaJaAbriu(r.cartaoId, r.fatura)) {
      const key = `${r.cartaoId}_${r.fatura}`;
      gruposFechadaCaixa[key] = (gruposFechadaCaixa[key] || 0) - r.valor;
    }
  });
  Object.entries(faturaEstados).forEach(([key, fe]) => {
    if (key in gruposFechadaCaixa) return;
    if (fe.ajusteTotal == null) return;
    if (contaId != null && (fe.contaId || CONTA_PRINCIPAL_ID) !== contaId) return;
    const [cartaoId, faturaKey] = key.split('_');
    if (_periodoNumCalc(faturaKey) !== periodoTotal) return;
    if (cartoes.some(c => c.id === cartaoId && c.ativo)) gruposFechadaCaixa[key] = 0;
  });
  let totalFaturas    = 0; // fatura fechada ainda não confirmada como paga ("a vencer")
  let totalCartaoPago = 0; // fatura fechada já confirmada (total ou parte paga)
  Object.entries(gruposFechadaCaixa).forEach(([key, total]) => {
    const fe = faturaEstados[key];
    const totalAjustado = fe?.ajusteTotal ?? total;
    if (fe?.estado === 'paga_total') totalCartaoPago += totalAjustado;
    else if (fe?.estado === 'paga_parcial') totalCartaoPago += fe.valorPago || 0;
    else totalFaturas += totalAjustado;
  });
  const totalCartaoCaixa = ehFuturo
    ? Object.values(gruposFechadaCaixa).reduce((s, v) => s + v, 0)
    : totalCartaoPago;

  const despesasPendentes = data.despesas.filter(d => isPendenteEfetivo(d, agora) && !(d.cartao && d.fatura));
  const totalPendente = despesasPendentes.reduce((s, d) => s + d.valor, 0);

  const puladas = fixasPuladas ?? getFixasPuladas();
  const fixasVirtuais = [];
  (recorrentes || []).filter(r => r.ativo && !r.cartao && (r.tipo || 'despesa') === 'despesa').forEach(r => {
    diasFaltantesRecorrente(r, data.despesas, mes, ano).forEach(dia => {
      if (puladas.includes(chaveFixaPulada(r.id, ano, mes, dia))) return;
      fixasVirtuais.push({ recorrenteId: r.id, categoria: r.categoria, descricao: r.descricao || '', valor: r.valor, dia });
    });
  });
  const totalFixasVirtuais = fixasVirtuais.reduce((s, v) => s + v.valor, 0);

  const fixasVirtuaisReceita = [];
  (recorrentes || []).filter(r => r.ativo && !r.cartao && r.tipo === 'receita').forEach(r => {
    diasFaltantesRecorrente(r, data.receitas, mes, ano).forEach(dia => {
      if (puladas.includes(chaveFixaPulada(r.id, ano, mes, dia))) return;
      fixasVirtuaisReceita.push({ recorrenteId: r.id, categoria: r.categoria, descricao: r.descricao || '', valor: r.valor, dia });
    });
  });
  const totalFixasVirtuaisReceita = fixasVirtuaisReceita.reduce((s, v) => s + v.valor, 0);
  receitaComprometida += totalFixasVirtuaisReceita;

  const receitasPendentes = data.receitas.filter(r => isPendenteEfetivo(r, agora) && !(r.cartao && r.fatura));
  const totalReceitaPendente = receitasPendentes.reduce((s, r) => s + r.valor, 0);

  const contaComoCaixa = d => ehFuturo || !isPendenteEfetivo(d, agora);
  const despesaCaixa = data.despesas.filter(d => contaComoCaixa(d) && !d._faturaAberta && !(d.cartao && d.fatura)).reduce((s, d) => s + d.valor, 0) + totalCartaoCaixa;

  const _mesKeyAtualComprometido = `${ano}-${String(mes).padStart(2, '0')}`;
  const totalComprometidoMes = data.despesas.filter(d => !d._faturaAberta || d.fatura === _mesKeyAtualComprometido).reduce((s, d) => s + d.valor, 0);
  const despesaComprometida = despesaCaixa + totalPendente + (ehFuturo ? 0 : totalFaturas) + totalFixasVirtuais;
  const diffNaoIdentificadoMes = ehFuturo ? 0 : (totalComprometidoMes - despesaComprometida);

  const sobra = saldoConta + totalReceita - despesaCaixa;
  const sobraPct = (saldoConta + totalReceita) > 0 ? (sobra / (saldoConta + totalReceita)) * 100 : 0;
  const totalAp = (data.aportes || []).reduce((s, a) => s + a.valor, 0);
  const totalTransferenciaLiquida = (data.transferencias || [])
    .reduce((s, t) => s + (t.direcao === 'entrada' ? t.valor : -t.valor), 0);
  const saldoFinal = sobra - totalAp + totalTransferenciaLiquida;

  return {
    ehFuturo, saldoConta, totalReceita, receitaComprometida,
    gruposFechadaCaixa, totalFaturas, totalCartaoPago, totalCartaoCaixa,
    despesasPendentes, totalPendente,
    fixasVirtuais, totalFixasVirtuais,
    fixasVirtuaisReceita, totalFixasVirtuaisReceita,
    receitasPendentes, totalReceitaPendente,
    despesaCaixa, despesaComprometida, totalComprometidoMes,
    diffNaoIdentificadoMes,
    sobra, sobraPct, totalAp, totalTransferenciaLiquida, saldoFinal,
  };
}

function calcularNaoPlanejado({ renda = null, percentual = null, categorias = [] }) {
  const temMeta = renda != null && percentual != null;
  const totalPlanejado = temMeta ? renda * (percentual / 100) : null;
  const somaLimites = (categorias || []).reduce((s, c) => s + (c.limite || 0), 0);
  const folga = temMeta ? Math.max(0, totalPlanejado - somaLimites) : null;
  const sobreAlocado = temMeta && somaLimites > totalPlanejado;
  return { temMeta, totalPlanejado, somaLimites, folga, sobreAlocado };
}

function calcularAjuste(diffNaoIdentificadoMes, jaExplicadoPor = 0) {
  const valorAjuste = -diffNaoIdentificadoMes - jaExplicadoPor;
  return { temAjuste: Math.abs(valorAjuste) > 1, valorAjuste };
}

module.exports = {
  CONTA_PRINCIPAL_ID,
  CATEGORIA_AJUSTE,
  pertenceAConta,
  isPendenteEfetivo,
  normCat,
  diasSemanaNoMes,
  diasEsperadosRecorrente,
  diasFaltantesRecorrente,
  chaveFixaPulada,
  getFixasPuladas,
  addFixaPulada,
  calcularAgregadosOrcamento,
  calcularAjuste,
  calcularNaoPlanejado,
};
