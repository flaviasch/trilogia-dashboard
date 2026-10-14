'use strict';
/**
 * verificar-dre-paralelo.js — SÓ CONSULTA, não grava nada.
 *
 * Confirma que a versão paralelizada de _calcularDRESimplificado (feita
 * direto por Flávia em 14/08/2026) bate com o valor conhecido de sessões
 * anteriores desta mesma consulta (Isabella, Agosto/2026).
 */
const admin = require('firebase-admin');
const path = require('path');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const UID = 'q2NmJFwb5zLS411sM6AJgjlhk2y1';

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

async function calcularNovo(uid, mes, ano) {
  const [notasSnap, impSnap, despesasSnap] = await Promise.all([
    db.collection('notasEmitidas').where('uid', '==', uid).where('mes', '==', mes).where('ano', '==', ano).get(),
    db.collection('impostosPrevistos').where('uid', '==', uid).where('mes', '==', mes).where('ano', '==', ano).get(),
    db.collection('despesasPJ').where('uid', '==', uid).where('ativo', '==', true).get(),
  ]);
  const receitaBruta = notasSnap.docs.filter(d => !d.data().legado).reduce((s, d) => s + (d.data().valor || 0), 0);
  const impostos = impSnap.docs.reduce((s, d) => {
    const imp = d.data();
    if (imp.trimestre && !imp.referenciaTrimestral) return s;
    return s + (imp.valor || 0);
  }, 0);
  const receitaLiquida = receitaBruta - impostos;
  const despesasOperacionais = despesasSnap.docs.reduce((s, d) => {
    const desp = d.data();
    const oc = _ocorrenciaDespesaPJ(desp, mes, ano);
    return oc ? s + (desp.valor || 0) : s;
  }, 0);
  const lucroLiquido = receitaLiquida - despesasOperacionais;
  const arredonda = v => Math.round(v * 100) / 100;
  return { receitaBruta: arredonda(receitaBruta), impostos: arredonda(impostos), receitaLiquida: arredonda(receitaLiquida), despesasOperacionais: arredonda(despesasOperacionais), lucroLiquido: arredonda(lucroLiquido) };
}

(async () => {
  const r = await calcularNovo(UID, 8, 2026);
  console.log('Ago/2026:', JSON.stringify(r));
  const esperado = { receitaBruta: 7646.11, impostos: 0, receitaLiquida: 7646.11, despesasOperacionais: 0, lucroLiquido: 7646.11 };
  const bateu = JSON.stringify(r) === JSON.stringify(esperado);
  console.log(bateu ? '✅ Bate com o valor conhecido de sessões anteriores.' : `❌ DIVERGENTE — esperado ${JSON.stringify(esperado)}`);
  process.exit(0);
})();
