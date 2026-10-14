'use strict';
/**
 * verificar-projecao-fixas-cartao.js — SÓ CONSULTA, não grava nada.
 *
 * Replica a lógica nova de projeção virtual de despesas fixas de cartão na
 * fatura aberta (renderFaturas, orcamento.html) pra validar contra o dado
 * real da Márcia antes de considerar o fix pronto.
 */
const admin = require('firebase-admin');
const path = require('path');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const UID = process.argv[2] || '8SQTfVAgvqWbGNtYT31i60h2jTG2';

function sugerirFatura(dataCompra, diaCorte, diaVencimento) {
  const [anoStr, mesStr, diaStr] = dataCompra.split('-');
  let ano = parseInt(anoStr, 10), mes = parseInt(mesStr, 10);
  const dia = parseInt(diaStr, 10);
  const avancarMes = () => { mes += 1; if (mes > 12) { mes = 1; ano += 1; } };
  if (dia > diaCorte) avancarMes();
  if (!diaVencimento || diaVencimento <= diaCorte) avancarMes();
  return `${ano}-${String(mes).padStart(2, '0')}`;
}
function diasEsperadosRecorrente(r, mes, ano) {
  if (r.anoInicio != null && r.mesInicio != null) {
    const antesDoInicio = ano < r.anoInicio || (ano === r.anoInicio && mes < r.mesInicio);
    if (antesDoInicio) return [];
  }
  return [r.dia]; // só mensal, igual ao fix
}
function diasFaltantesRecorrente(r, despesasArr, mes, ano) {
  const esperados = diasEsperadosRecorrente(r, mes, ano);
  const ocupados = new Set((despesasArr || [])
    .filter(d => d.recorrenteId === r.id || (!d.recorrenteId && d.categoria === r.categoria))
    .map(d => parseInt((d.data || '').split('-')[2], 10)).filter(d => !isNaN(d)));
  return esperados.filter(d => !ocupados.has(d));
}

(async () => {
  const cartoesSnap = await db.collection('mentoradas').doc(UID).collection('cartoes').get();
  const recSnap = await db.collection('mentoradas').doc(UID).collection('recorrentes').get();
  const recorrentes = recSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const hoje = new Date();
  const dataHoje = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
  console.log(`Hoje (servidor): ${dataHoje}\n`);

  for (const cDoc of cartoesSnap.docs) {
    const c = { id: cDoc.id, ...cDoc.data() };
    if (!c.ativo || !c.diaCorte) continue;
    const key = sugerirFatura(dataHoje, c.diaCorte, c.diaVencimento || 1);
    const [keyAno, keyMes] = key.split('-').map(Number);
    console.log(`=== Cartão "${c.nome}" — fatura aberta: ${key} ===`);

    // Itens já materializados nessa fatura (varre orcamento inteiro, igual getOrcamento faria via prev/next)
    const orcSnap = await db.collection('mentoradas').doc(UID).collection('orcamento').get();
    const jaNaFatura = [];
    orcSnap.forEach(doc => {
      (doc.data().itens || []).forEach(it => {
        if (it && it.cartao && it.cartaoId === c.id && it.fatura === key) jaNaFatura.push(it);
      });
    });
    console.log(`  Já materializados: ${jaNaFatura.length}`);

    const virtuais = [];
    recorrentes
      .filter(r => r.ativo && r.cartao && r.cartaoId === c.id && (r.tipo || 'despesa') === 'despesa' && (r.frequencia || 'mensal') === 'mensal')
      .forEach(r => {
        for (let back = 0; back <= 2; back++) {
          let mCand = keyMes - back, aCand = keyAno;
          while (mCand < 1) { mCand += 12; aCand -= 1; }
          const diaTeste = Math.min(r.dia || 1, 28);
          const dataTeste = `${aCand}-${String(mCand).padStart(2, '0')}-${String(diaTeste).padStart(2, '0')}`;
          if (sugerirFatura(dataTeste, c.diaCorte, c.diaVencimento || 1) !== key) continue;
          diasFaltantesRecorrente(r, jaNaFatura.concat(virtuais), mCand, aCand).forEach(dia => {
            virtuais.push({
              descricao: r.descricao, valor: r.valor,
              data: `${aCand}-${String(mCand).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
              recorrenteId: r.id,
            });
          });
          break;
        }
      });
    console.log(`  Virtuais projetados: ${virtuais.length}`);
    virtuais.forEach(v => console.log(`    [virtual] ${v.descricao} — R$${v.valor} em ${v.data}`));
    console.log('');
  }
  process.exit(0);
})().catch(e => { console.error('Erro:', e); process.exit(1); });
