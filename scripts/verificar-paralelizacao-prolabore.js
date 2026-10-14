'use strict';
/**
 * verificar-paralelizacao-prolabore.js — SÓ CONSULTA, não grava nada.
 *
 * Compara a versão antiga (sequencial) e a nova (paralela) de
 * _calcularSugestaoSalarioPJ pra confirmar que o resultado é idêntico,
 * rodando contra os dados reais da Isabella pros 4 trimestres de 2026.
 */
const admin = require('firebase-admin');
const path = require('path');

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const UID = 'q2NmJFwb5zLS411sM6AJgjlhk2y1';
const PROLABORE_JANELA_MAX_MESES = 6;
const PROLABORE_REDUTOR_PADRAO = 20;

function _primeiroMesDoTrimestrePJ(trimestre) { return (trimestre - 1) * 3 + 1; }

function _ocorrenciaDespesaPJ(desp, mesX, anoX) {
  const prefixoX = `${anoX}-${String(mesX).padStart(2, '0')}`;
  if (desp.tipo === 'unica') {
    if (!desp.data || !desp.data.startsWith(prefixoX)) return null;
    return { mesAno: prefixoX, dataVenc: desp.data, sufixo: '' };
  }
  const inicioM = desp.mesInicio || 1;
  const inicioA = desp.anoInicio || 0;
  const mesesDesdeInicio = (anoX - inicioA) * 12 + (mesX - inicioM);
  if (mesesDesdeInicio < 0) return null;
  const dataVenc = `${prefixoX}-${String(desp.diaVencimento).padStart(2, '0')}`;
  if (desp.tipo === 'parcelada') {
    const n = desp.numeroParcelas || 1;
    if (mesesDesdeInicio >= n) return null;
    return { mesAno: prefixoX, dataVenc, sufixo: ` (${mesesDesdeInicio + 1}/${n})` };
  }
  if (desp.mesesRestantes != null && mesesDesdeInicio >= desp.mesesRestantes) return null;
  return { mesAno: prefixoX, dataVenc, sufixo: '' };
}

async function _calcularDRESimplificado(uid, mes, ano) {
  const notasSnap = await db.collection('notasEmitidas').where('uid', '==', uid).where('mes', '==', mes).where('ano', '==', ano).get();
  const receitaBruta = notasSnap.docs.filter(d => !d.data().legado).reduce((s, d) => s + (d.data().valor || 0), 0);
  const impSnap = await db.collection('impostosPrevistos').where('uid', '==', uid).where('mes', '==', mes).where('ano', '==', ano).get();
  const impostos = impSnap.docs.reduce((s, d) => {
    const imp = d.data();
    if (imp.trimestre && !imp.referenciaTrimestral) return s;
    return s + (imp.valor || 0);
  }, 0);
  const receitaLiquida = receitaBruta - impostos;
  const despesasSnap = await db.collection('despesasPJ').where('uid', '==', uid).where('ativo', '==', true).get();
  const despesasOperacionais = despesasSnap.docs.reduce((s, d) => {
    const desp = d.data();
    const oc = _ocorrenciaDespesaPJ(desp, mes, ano);
    return oc ? s + (desp.valor || 0) : s;
  }, 0);
  const lucroLiquido = receitaLiquida - despesasOperacionais;
  const arredonda = v => Math.round(v * 100) / 100;
  return { receitaBruta: arredonda(receitaBruta), impostos: arredonda(impostos), receitaLiquida: arredonda(receitaLiquida), despesasOperacionais: arredonda(despesasOperacionais), lucroLiquido: arredonda(lucroLiquido) };
}

// ── Versão ANTIGA (sequencial) ──
async function calcularAntigo(uid, trimestre, ano) {
  const primeiroMes = _primeiroMesDoTrimestrePJ(trimestre);
  const meses = [];
  let cursorMes = primeiroMes, cursorAno = ano;
  for (let i = 0; i < PROLABORE_JANELA_MAX_MESES; i++) {
    cursorMes--; if (cursorMes < 1) { cursorMes = 12; cursorAno--; }
    const notasSnap = await db.collection('notasEmitidas')
      .where('uid', '==', uid).where('mes', '==', cursorMes).where('ano', '==', cursorAno).limit(1).get();
    if (notasSnap.empty) break;
    const dre = await _calcularDRESimplificado(uid, cursorMes, cursorAno);
    meses.unshift({ mes: cursorMes, ano: cursorAno, lucroLiquido: dre.lucroLiquido });
  }
  const mediaUsada = meses.length ? Math.round((meses.reduce((s, m) => s + m.lucroLiquido, 0) / meses.length) * 100) / 100 : 0;
  const valor = Math.max(0, Math.round(mediaUsada * (1 - PROLABORE_REDUTOR_PADRAO / 100) * 100) / 100);
  return { valor, baseCalculo: { meses, mediaUsada, redutorPercentual: PROLABORE_REDUTOR_PADRAO } };
}

// ── Versão NOVA (paralela) — cópia exata do que foi aplicado em functions/index.js ──
async function calcularNovo(uid, trimestre, ano) {
  const primeiroMes = _primeiroMesDoTrimestrePJ(trimestre);
  const candidatos = [];
  let cursorMes = primeiroMes, cursorAno = ano;
  for (let i = 0; i < PROLABORE_JANELA_MAX_MESES; i++) {
    cursorMes--; if (cursorMes < 1) { cursorMes = 12; cursorAno--; }
    candidatos.push({ mes: cursorMes, ano: cursorAno });
  }
  const temNotaPorCandidato = await Promise.all(candidatos.map(c =>
    db.collection('notasEmitidas').where('uid', '==', uid).where('mes', '==', c.mes).where('ano', '==', c.ano).limit(1).get()
      .then(snap => !snap.empty)
  ));
  const candidatosValidos = [];
  for (let i = 0; i < candidatos.length; i++) {
    if (!temNotaPorCandidato[i]) break;
    candidatosValidos.push(candidatos[i]);
  }
  const dres = await Promise.all(candidatosValidos.map(c => _calcularDRESimplificado(uid, c.mes, c.ano)));
  const meses = candidatosValidos
    .map((c, i) => ({ mes: c.mes, ano: c.ano, lucroLiquido: dres[i].lucroLiquido }))
    .reverse();
  const mediaUsada = meses.length ? Math.round((meses.reduce((s, m) => s + m.lucroLiquido, 0) / meses.length) * 100) / 100 : 0;
  const valor = Math.max(0, Math.round(mediaUsada * (1 - PROLABORE_REDUTOR_PADRAO / 100) * 100) / 100);
  return { valor, baseCalculo: { meses, mediaUsada, redutorPercentual: PROLABORE_REDUTOR_PADRAO } };
}

(async () => {
  let tudoIgual = true;
  for (const trimestre of [1, 2, 3, 4]) {
    for (const ano of [2026, 2027]) {
      const t0a = Date.now();
      const antigo = await calcularAntigo(UID, trimestre, ano);
      const tempoAntigo = Date.now() - t0a;
      const t0n = Date.now();
      const novo = await calcularNovo(UID, trimestre, ano);
      const tempoNovo = Date.now() - t0n;

      const igual = JSON.stringify(antigo) === JSON.stringify(novo);
      if (!igual) tudoIgual = false;
      console.log(`Trimestre ${trimestre}/${ano}: ${igual ? '✅ IDÊNTICO' : '❌ DIFERENTE'} | antigo=${tempoAntigo}ms novo=${tempoNovo}ms | meses=${antigo.baseCalculo.meses.length} valor=${antigo.valor}`);
      if (!igual) {
        console.log('  antigo:', JSON.stringify(antigo));
        console.log('  novo:  ', JSON.stringify(novo));
      }
    }
  }
  console.log(tudoIgual ? '\n✅ Todos os cenários bateram idêntico.' : '\n❌ Divergência encontrada — revisar.');
  process.exit(0);
})();
