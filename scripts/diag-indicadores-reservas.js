'use strict';
/**
 * diag-indicadores-reservas.js — SÓ CONSULTA, não grava nada.
 *
 * Replica a lógica de getIndicadoresReservasPJ (functions/index.js) pra
 * rodar localmente contra os dados reais da Isabella e ver se a function
 * quebra ou produz valor inválido, sem precisar logar no navegador.
 *
 * Uso: node diag-indicadores-reservas.js [uid] [mes] [ano]
 */
const admin = require('firebase-admin');
const path = require('path');

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const UID = process.argv[2] || 'q2NmJFwb5zLS411sM6AJgjlhk2y1';
const MES = Number(process.argv[3]) || (new Date().getMonth() + 1);
const ANO = Number(process.argv[4]) || new Date().getFullYear();

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

async function _calcularPMR(uid) {
  const snap = await db.collectionGroup('recebimentos').where('uid', '==', uid).get();
  const confirmados = snap.docs.map(d => d.data()).filter(r => r.dataRecebimento && r.dataEmissaoNota);
  if (confirmados.length < 3) return { valor: null, n: confirmados.length };
  let somaDiasPonderada = 0, somaValor = 0;
  for (const r of confirmados) {
    const dias = (new Date(r.dataRecebimento) - new Date(r.dataEmissaoNota)) / 86_400_000;
    if (dias < 0) continue;
    somaDiasPonderada += dias * r.valorLiquido;
    somaValor += r.valorLiquido;
  }
  if (somaValor === 0) return { valor: null, n: confirmados.length };
  return { valor: Math.round(somaDiasPonderada / somaValor), n: confirmados.length };
}

async function _calcularPMP(uid) {
  const despesasSnap = await db.collection('despesasPJ').where('uid', '==', uid).get();
  const despesasPorId = {};
  despesasSnap.docs.forEach(d => { despesasPorId[d.id] = d.data(); });
  const pagSnap = await db.collectionGroup('pagamentos').where('uid', '==', uid).get();
  let somaDiasPonderada = 0, somaValor = 0, validos = 0;
  for (const d of pagSnap.docs) {
    const pagamento = d.data();
    if (pagamento.cancelado || !pagamento.dataPagamento) continue;
    const despesaId = d.ref.parent.parent.id;
    const desp = despesasPorId[despesaId];
    if (!desp) continue;
    const [anoStr, mesStr] = d.id.split('-');
    const oc = _ocorrenciaDespesaPJ(desp, Number(mesStr), Number(anoStr));
    if (!oc) continue;
    const dias = (new Date(pagamento.dataPagamento) - new Date(oc.dataVenc)) / 86_400_000;
    somaDiasPonderada += dias * (desp.valor || 0);
    somaValor += (desp.valor || 0);
    validos++;
  }
  if (validos < 3 || somaValor === 0) return { valor: null, validos };
  return { valor: Math.round(somaDiasPonderada / somaValor), validos };
}

(async () => {
  console.log(`Diagnosticando getIndicadoresReservasPJ pra uid=${UID}, mes=${MES}, ano=${ANO}\n`);
  try {
    const [dre, pmrR, pmpR, contaSnap, despesasSnap] = await Promise.all([
      _calcularDRESimplificado(UID, MES, ANO),
      _calcularPMR(UID),
      _calcularPMP(UID),
      db.collection('contasPJ').doc(UID).get(),
      db.collection('despesasPJ').where('uid', '==', UID).where('ativo', '==', true).get(),
    ]);

    console.log('DRE simplificado:', JSON.stringify(dre, null, 2));
    console.log('PMR:', JSON.stringify(pmrR));
    console.log('PMP:', JSON.stringify(pmpR));

    const despesaOperacionalMensal = despesasSnap.docs.reduce((s, d) => {
      const desp = d.data();
      const oc = _ocorrenciaDespesaPJ(desp, MES, ANO);
      return oc ? s + (desp.valor || 0) : s;
    }, 0);
    console.log('\ndespesaOperacionalMensal (todas ativo:true, não só tipo fixa):', despesaOperacionalMensal);
    console.log('Total despesas ativo:true no uid:', despesasSnap.docs.length);
    const porTipo = {};
    despesasSnap.docs.forEach(d => { const t = d.data().tipo; porTipo[t] = (porTipo[t] || 0) + 1; });
    console.log('Por tipo:', porTipo);

    const pmr = pmrR.valor ?? 30;
    const pmp = pmpR.valor ?? 30;
    const cicloFinanceiro = pmr - pmp;
    const capitalDeGiroBruto = (despesaOperacionalMensal / 30) * cicloFinanceiro;
    const capitalDeGiro = Math.max(0, capitalDeGiroBruto);
    const autofinanciado = capitalDeGiroBruto <= 0;

    const conta = contaSnap.exists ? contaSnap.data() : {};
    const reservaMinimaCaixa = typeof conta.reservaMinimaCaixa === 'number' ? conta.reservaMinimaCaixa : 0;
    const retiradaSugerida = dre.lucroLiquido - reservaMinimaCaixa;

    const resultado = {
      despesaOperacionalMensal: Math.round(despesaOperacionalMensal * 100) / 100,
      lucroLiquido: dre.lucroLiquido,
      pmr, pmp, cicloFinanceiro,
      pmrCalculado: pmrR.valor !== null, pmpCalculado: pmpR.valor !== null,
      capitalDeGiro: Math.round(capitalDeGiro * 100) / 100, autofinanciado,
      reservaMinimaCaixa: Math.round(reservaMinimaCaixa * 100) / 100,
      retiradaSugerida: Math.round(retiradaSugerida * 100) / 100,
    };
    console.log('\n=== Resultado final (o que o frontend receberia) ===');
    console.log(JSON.stringify(resultado, null, 2));

    console.log('\nconta.exists:', contaSnap.exists, '| conta bruta:', JSON.stringify(conta));

    for (const [k, v] of Object.entries(resultado)) {
      if (typeof v === 'number' && !Number.isFinite(v)) console.log(`⚠️  CAMPO INVÁLIDO: ${k} = ${v}`);
    }
  } catch (e) {
    console.error('\n❌ EXCEÇÃO — a function real lançaria erro aqui:', e);
  }
  process.exit(0);
})();
