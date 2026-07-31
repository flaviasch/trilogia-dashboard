'use strict';
/**
 * diagnosticar-pendentes.js
 * Só LEITURA — investiga por que itens já tratados continuam aparecendo
 * como pendentes no orçamento (achado 30/07/2026, Flávia: "tudo que
 * aparece como pendente já foi tratado há vários dias").
 *
 * Uso: node diagnosticar-pendentes.js [email] [mes] [ano]
 * Ex:  node diagnosticar-pendentes.js flaviasch@gmail.com 7 2026
 */

const admin = require('firebase-admin');
const path  = require('path');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Mesma lógica de js/orcamento-calc.js — replicada aqui só pra diagnóstico.
function isPendenteEfetivo(item, agora = new Date()) {
  if (item.confirmado) return false;
  if (!item.data) return false;
  if (item.pendente) return true;
  if (item.recorrenteId && !item.cartao) return true;
  const hoje = new Date(agora); hoje.setHours(0, 0, 0, 0);
  return new Date(item.data + 'T00:00:00') >= hoje;
}

async function main() {
  const email = process.argv[2] || 'flaviasch@gmail.com';
  const agora = new Date();
  const mes = Number(process.argv[3]) || (agora.getMonth() + 1);
  const ano = Number(process.argv[4]) || agora.getFullYear();
  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;

  const user = await admin.auth().getUserByEmail(email);
  const uid = user.uid;
  console.log(`UID: ${uid} — mês ${mesKey}\n`);

  const docSnap = await db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKey).get();
  if (!docSnap.exists) { console.log('Nenhum orçamento salvo pra esse mês.'); process.exit(0); }

  const itens = docSnap.data().itens || [];
  console.log(`Total de itens no mês: ${itens.length}\n`);

  const pendentes = itens
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => (item.tipo === 'despesa' || item.tipo === 'receita') && isPendenteEfetivo(item, agora));

  console.log(`Itens classificados como PENDENTES agora: ${pendentes.length}\n`);
  pendentes.forEach(({ item, idx }) => {
    console.log(`[${idx}] ${item.tipo} | ${item.categoria || item.nome || '(sem nome)'} | R$${item.valor} | data=${item.data} | confirmado=${!!item.confirmado} | pendente=${!!item.pendente} | recorrenteId=${item.recorrenteId || '-'} | cartao=${!!item.cartao} | parcelamentoId=${item.parcelamentoId || '-'}`);
  });

  // Duplicatas: mesmo recorrenteId aparecendo mais de uma vez ainda não confirmado.
  const porRecorrente = {};
  itens.forEach((item, idx) => {
    if (!item.recorrenteId) return;
    porRecorrente[item.recorrenteId] = porRecorrente[item.recorrenteId] || [];
    porRecorrente[item.recorrenteId].push({ idx, ...item });
  });
  console.log('\n--- Grupos por recorrenteId (>1 ocorrência no mês) ---');
  Object.entries(porRecorrente).forEach(([recId, ocorrencias]) => {
    if (ocorrencias.length > 1) {
      console.log(`recorrenteId=${recId}: ${ocorrencias.length} ocorrências`);
      ocorrencias.forEach(o => console.log(`   [${o.idx}] data=${o.data} confirmado=${!!o.confirmado} pendente=${!!o.pendente}`));
    }
  });

  process.exit(0);
}

main().catch(err => { console.error('Erro:', err.message); process.exit(1); });
