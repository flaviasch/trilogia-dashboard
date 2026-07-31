'use strict';
/**
 * remover-ajuste-fantasma.js
 * Remove a receita "Ajuste de fatura" (R$1.047, cartao Bradesco, fatura
 * 2026-08) do orcamento de agosto/2026 de Flávia — ela tentou apagar pela
 * tela várias vezes e o item voltava ao atualizar (achado 30/07/2026).
 *
 * Uso: node remover-ajuste-fantasma.js
 */

const admin = require('firebase-admin');
const path  = require('path');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  const email = 'flaviasch@gmail.com';
  const mesKey = '2026-08';

  const user = await admin.auth().getUserByEmail(email);
  const uid = user.uid;
  const ref = db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKey);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error(`Sem orcamento em ${mesKey}`);
    const itens = snap.data().itens || [];
    const alvo = itens.findIndex(i =>
      i.tipo === 'receita' && i.origem === 'ajuste' && i.cartaoId === '8zxs6ubcqMewTulVE7lN' &&
      i.fatura === '2026-08' && Math.abs(i.valor - 1047) < 0.01
    );
    if (alvo === -1) throw new Error('Item não encontrado — pode já ter sido removido.');
    console.log('Removendo item:', JSON.stringify(itens[alvo]));
    const novosItens = itens.slice(0, alvo).concat(itens.slice(alvo + 1));
    tx.set(ref, { itens: novosItens }, { merge: true });
  });

  console.log('✅ Removido com sucesso.');
  process.exit(0);
}

main().catch(err => { console.error('❌ Erro:', err.message); process.exit(1); });
