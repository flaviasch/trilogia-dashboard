'use strict';
/**
 * diagnosticar-faturas.js
 * Só LEITURA — investiga 3 relatos de Flávia (30/07/2026):
 * (1) saldo inicial de agosto em -270 mesmo com julho "zerado";
 * (2) fatura Bradesco Setembro R$1.410 aparecendo em Aberta indevidamente;
 * (3) ajuste de R$1.047 na fatura fechada de julho criou uma receita
 *     vinculada que não é possível apagar de vez (reaparece ao atualizar).
 *
 * Uso: node diagnosticar-faturas.js [email] [anoBase]
 */

const admin = require('firebase-admin');
const path  = require('path');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  const email = process.argv[2] || 'flaviasch@gmail.com';
  const ano = Number(process.argv[3]) || 2026;

  const user = await admin.auth().getUserByEmail(email);
  const uid = user.uid;
  console.log(`UID: ${uid}\n`);

  const mesesChave = [`${ano}-07`, `${ano}-08`, `${ano}-09`];
  const orcRef = db.collection('mentoradas').doc(uid).collection('orcamento');

  const docs = {};
  for (const chave of mesesChave) {
    const snap = await orcRef.doc(chave).get();
    docs[chave] = snap.exists ? snap.data() : null;
  }

  // ── 1) Saldo de conta (rollover mês a mês) ──
  console.log('=== saldosConta (mentoradas/{uid}/saldosConta) ===');
  const saldosSnap = await db.collection('mentoradas').doc(uid).collection('saldosConta').get();
  saldosSnap.forEach(d => {
    if (mesesChave.some(m => d.id.startsWith(m))) console.log(`${d.id}:`, JSON.stringify(d.data()));
  });

  console.log('\n=== Item "__saldo_conta__" em cada mes (se existir) ===');
  mesesChave.forEach(chave => {
    const itens = docs[chave]?.itens || [];
    const saldoItem = itens.filter(i => i.categoria === '__saldo_conta__');
    console.log(`${chave}:`, saldoItem.length ? JSON.stringify(saldoItem) : '(nenhum)');
  });

  // ── 2) Faturas Bradesco: itens marcados cartao+fatura, e faturaEstados ──
  console.log('\n=== faturaEstados (mentoradas/{uid}/faturaEstados) ===');
  const faturaEstadosSnap = await db.collection('mentoradas').doc(uid).collection('faturaEstados').get();
  faturaEstadosSnap.forEach(d => {
    if (d.id.toLowerCase().includes('bradesco') || mesesChave.some(m => d.id.includes(m))) {
      console.log(`${d.id}:`, JSON.stringify(d.data()));
    }
  });

  console.log('\n=== Cartões cadastrados ===');
  const cartoesSnap = await db.collection('mentoradas').doc(uid).collection('cartoes').get();
  cartoesSnap.forEach(d => console.log(`${d.id}:`, JSON.stringify(d.data())));

  console.log('\n=== Itens de despesa/receita com cartao:true, por mes ===');
  mesesChave.forEach(chave => {
    const itens = docs[chave]?.itens || [];
    const doCartao = itens.filter(i => i.cartao);
    console.log(`\n--- ${chave} (${doCartao.length} itens de cartao) ---`);
    doCartao.forEach((i, idx) => {
      console.log(`  [${idx}] ${i.tipo} | ${i.categoria} | R$${i.valor} | data=${i.data} | fatura=${i.fatura} | cartaoId=${i.cartaoId} | origem=${i.origem || '-'} | descricao=${i.descricao || '-'}`);
    });
  });

  console.log('\n=== Itens "Ajuste de fatura" em QUALQUER mes (origem:ajuste) ===');
  mesesChave.forEach(chave => {
    const itens = docs[chave]?.itens || [];
    const ajustes = itens.filter(i => i.origem === 'ajuste');
    if (ajustes.length) {
      console.log(`${chave}:`);
      ajustes.forEach((i, idx) => console.log(`  [${idx}] ${i.tipo} | R$${i.valor} | data=${i.data} | fatura=${i.fatura} | cartaoId=${i.cartaoId}`));
    }
  });

  process.exit(0);
}

main().catch(err => { console.error('Erro:', err.message); process.exit(1); });
