'use strict';

/**
 * Conta das reservas com rendimento (27/11/2026). Usada pela TrilogIA
 * (lib/trilogia.js) e pelo Fechamento Mensal (lib/fechamento.js), para os dois
 * darem sempre o mesmo número.
 *
 * Regras da Flávia:
 *  - Dividir o que falta pelo aporte ignora o rendimento e está errado.
 *  - O prazo é a data-meta cadastrada na tela de Reservas.
 *  - O rendimento é a taxa real do perfil de investidor, a mesma do Mapa da
 *    Liberdade (liberdade.html, 22/07/2026): 4% / 5% / 6% ao ano acima da
 *    inflação. Sem perfil cadastrado, moderado.
 */

const TAXA_ANUAL_POR_PERFIL = { conservador: 4, moderado: 5, arrojado: 6 };
const NOMES_MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** { perfil: 'moderado'|..|null, taxaAnual, i (mensal) } */
function taxaDoPerfil(perfil) {
  const chave = String(perfil || '').toLowerCase();
  const p = TAXA_ANUAL_POR_PERFIL[chave] ? chave : null;
  const taxaAnual = TAXA_ANUAL_POR_PERFIL[p || 'moderado'];
  return { perfil: p, taxaAnual, i: Math.pow(1 + taxaAnual / 100, 1 / 12) - 1 };
}

/** Meses entre duas datas 'AAAA-MM' ou 'AAAA-MM-DD' (só ano e mês contam). */
function mesesEntre(deISO, ateISO) {
  const m = (x) => { const r = /^(\d{4})-(\d{2})/.exec(String(x || '')); return r ? { a: Number(r[1]), m: Number(r[2]) } : null; };
  const d = m(deISO), t = m(ateISO);
  if (!d || !t) return null;
  return (t.a - d.a) * 12 + (t.m - d.m);
}

/** 'AAAA-MM' → 'março de 2040' */
function nomeMesAno(iso) {
  const r = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  return r ? `${NOMES_MESES[Number(r[2]) - 1]} de ${r[1]}` : null;
}

/** Valor na data: saldo rendendo n meses + aportes mensais a partir do mês k. */
function valorNaData(pv, pmt, i, n, k = 0) {
  const nAp = Math.max(0, n - Math.max(0, k));
  if (i === 0) return pv + pmt * nAp;
  return pv * Math.pow(1 + i, n) + pmt * (Math.pow(1 + i, nAp) - 1) / i;
}

/** Aporte mensal que faz chegar à meta na data. */
function aporteNecessario(pv, meta, i, n, k = 0) {
  const nAp = Math.max(0, n - Math.max(0, k));
  if (nAp <= 0) return null;
  const falta = meta - pv * (i === 0 ? 1 : Math.pow(1 + i, n));
  if (falta <= 0) return 0;
  return i === 0 ? falta / nAp : falta * i / (Math.pow(1 + i, nAp) - 1);
}

/** Meses para chegar à meta com o saldo rendendo e aportes mensais. null se não chega. */
function mesesComRendimento(acumulado, meta, aporte, i) {
  const pv = Math.max(0, Number(acumulado) || 0), fv = Number(meta) || 0, pmt = Math.max(0, Number(aporte) || 0);
  i = Math.max(0, Number(i) || 0);
  if (pv >= fv) return 0;
  if (i === 0) return pmt > 0 ? Math.max(1, Math.ceil((fv - pv) / pmt)) : null;
  const den = pv * i + pmt;
  if (den <= 0) return null;
  const n = Math.log((fv * i + pmt) / den) / Math.log(1 + i);
  return Number.isFinite(n) ? Math.max(1, Math.ceil(n)) : null;
}

/**
 * Situação de uma reserva na data-meta.
 * Retorna { semDataMeta } | { dataMetaPassou, dataMeta } |
 *         { dataMeta, meses, previsto, suficiente, faltaria, aporteNecessario }
 */
function situacaoNaData(r, { i, hojeISO }) {
  const meta = Number(r.meta) || 0, acumulado = Number(r.acumulado) || 0, aporte = Number(r.aporte) || 0;
  const n = mesesEntre(hojeISO, r.dataMeta);
  if (n == null) return { semDataMeta: true };
  const dataMeta = nomeMesAno(r.dataMeta);
  if (n <= 0) return { dataMetaPassou: true, dataMeta };
  const k = r.dataInicioAporte ? Math.max(0, mesesEntre(hojeISO, r.dataInicioAporte) || 0) : 0;
  const previsto = valorNaData(acumulado, aporte, i, n, k);
  const suficiente = previsto >= meta - 0.5;
  const nec = suficiente ? null : aporteNecessario(acumulado, meta, i, n, k);
  return { dataMeta, meses: n, previsto, suficiente, faltaria: suficiente ? 0 : meta - previsto, aporteNecessario: nec };
}

module.exports = {
  TAXA_ANUAL_POR_PERFIL,
  taxaDoPerfil,
  mesesEntre,
  nomeMesAno,
  valorNaData,
  aporteNecessario,
  mesesComRendimento,
  situacaoNaData,
};
