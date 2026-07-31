'use strict';
/**
 * verificar-fix-fatura.js
 * Só LEITURA — simula a nova lógica de getOrcamento (itensNext) contra os
 * dados reais de Flávia pra confirmar que o fix realmente fecha a lacuna
 * antes de fazer deploy da Cloud Function.
 */
const admin = require('firebase-admin');
const path  = require('path');
const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function sugerirFatura(dataCompra, diaCorte, diaVencimento) {
  const dia = parseInt(dataCompra.split('-')[2], 10);
  const d = new Date(dataCompra + 'T12:00:00');
  if (dia > diaCorte) d.setMonth(d.getMonth() + 1);
  if (!diaVencimento || diaVencimento <= diaCorte) d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  const email = 'flaviasch@gmail.com';
  const user = await admin.auth().getUserByEmail(email);
  const uid = user.uid;
  const col = db.collection('mentoradas').doc(uid).collection('orcamento');
  const cartoesSnap = await db.collection('mentoradas').doc(uid).collection('cartoes').get();
  const cartaoMap = {};
  cartoesSnap.forEach(d => cartaoMap[d.id] = d.data());

  const hojeStr = new Date().toISOString().slice(0, 10);
  const _abertaKeyPorCartao = {};
  function ehCicloAberto(item) {
    if (!item.cartao || !item.fatura || !item.cartaoId) return false;
    const c = cartaoMap[item.cartaoId];
    if (!c?.diaCorte) return false;
    if (!(item.cartaoId in _abertaKeyPorCartao)) {
      _abertaKeyPorCartao[item.cartaoId] = sugerirFatura(hojeStr, c.diaCorte, c.diaVencimento || 1);
    }
    return item.fatura === _abertaKeyPorCartao[item.cartaoId];
  }

  // Simula getOrcamento(7, 2026) ANTES e DEPOIS do fix
  const mes = 7, ano = 2026;
  const mesKey = '2026-07';
  const nextKey = '2026-08';
  const docSnap = await col.doc(mesKey).get();
  const nextSnap = await col.doc(nextKey).get();

  const itensMesRaw = docSnap.exists ? (docSnap.data().itens || []) : [];
  const itensNextRaw = nextSnap.exists ? (nextSnap.data().itens || []) : [];

  const itensNext = itensNextRaw.filter(item => item.cartao && item.fatura === nextKey && !ehCicloAberto(item));

  console.log(`ANTES do fix (só docSnap de julho), itens fatura=2026-08 cartaoId=Bradesco:`);
  const bradescoId = Object.keys(cartaoMap).find(id => cartaoMap[id].nome === 'Bradesco');
  const antesItens = itensMesRaw.filter(i => i.cartao && i.fatura === '2026-08' && i.cartaoId === bradescoId);
  const antesTotal = antesItens.reduce((s, i) => s + (i.tipo === 'receita' ? -i.valor : i.valor), 0);
  antesItens.forEach(i => console.log(`  ${i.tipo} | R$${i.valor} | ${i.descricao || i.categoria}`));
  console.log(`  TOTAL ANTES: R$${antesTotal}`);

  console.log(`\nDEPOIS do fix (docSnap julho + itensNext de agosto), mesmos itens:`);
  const depoisItensNext = itensNext.filter(i => i.cartaoId === bradescoId);
  const depoisTotal = antesTotal + depoisItensNext.reduce((s, i) => s + (i.tipo === 'receita' ? -i.valor : i.valor), 0);
  depoisItensNext.forEach(i => console.log(`  [emprestado de agosto] ${i.tipo} | R$${i.valor} | ${i.descricao || i.categoria}`));
  console.log(`  TOTAL DEPOIS: R$${depoisTotal}`);

  process.exit(0);
}

main().catch(err => { console.error('Erro:', err.message); process.exit(1); });
