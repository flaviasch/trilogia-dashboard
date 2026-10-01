'use strict';
/**
 * testar-recalcular-faturas-pf.js — SÓ CONSULTA, não grava nada.
 *
 * Replica a lógica de recalcularFaturasCartaoPF (modo simulação, aplicar=false)
 * pra rodar contra dados reais antes de confiar na function recém-escrita.
 *
 * Uso: node testar-recalcular-faturas-pf.js <email>
 */
const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const auth = admin.auth();

function _sugerirFatura(dataCompra, diaCorte, diaVencimento) {
  const [anoStr, mesStr, diaStr] = dataCompra.split('-');
  let ano = parseInt(anoStr, 10);
  let mes = parseInt(mesStr, 10);
  const dia = parseInt(diaStr, 10);
  const avancarMes = () => { mes += 1; if (mes > 12) { mes = 1; ano += 1; } };
  if (dia > diaCorte) avancarMes();
  if (!diaVencimento || diaVencimento <= diaCorte) avancarMes();
  return `${ano}-${String(mes).padStart(2, '0')}`;
}

(async () => {
  const email = process.argv[2] || 'flaviasch@gmail.com';
  const user = await auth.getUserByEmail(email);
  const uid = user.uid;
  console.log(`UID: ${uid} (${email})\n`);

  const cartoesSnap = await db.collection('mentoradas').doc(uid).collection('cartoes').get();
  if (cartoesSnap.empty) { console.log('Nenhum cartão cadastrado.'); process.exit(0); }

  for (const cartaoDoc of cartoesSnap.docs) {
    const cartao = cartaoDoc.data();
    console.log(`=== Cartão "${cartao.nome}" (${cartaoDoc.id}) — diaCorte=${cartao.diaCorte} diaVencimento=${cartao.diaVencimento} ===`);
    if (!cartao.diaCorte) { console.log('  (sem diaCorte, pulando)\n'); continue; }

    const orcamentoCol = db.collection('mentoradas').doc(uid).collection('orcamento');
    const docsSnap = await orcamentoCol.get();

    let totalItensCartao = 0;
    const propostas = [];
    docsSnap.forEach(doc => {
      const itens = doc.data().itens || [];
      itens.forEach(item => {
        if (!item || !item.cartao || item.cartaoId !== cartaoDoc.id || !item.data) return;
        totalItensCartao++;
        const faturaCorreta = _sugerirFatura(item.data, cartao.diaCorte, cartao.diaVencimento || 1);
        if (faturaCorreta === item.fatura) return;
        propostas.push({
          docOrigem: doc.id,
          descricao: item.descricao || item.categoria || 'Item',
          parcela: (item.parcelaAtual && item.parcelasTotal) ? `${item.parcelaAtual}/${item.parcelasTotal}` : null,
          valor: item.valor,
          data: item.data,
          faturaAntiga: item.fatura || '(sem fatura)',
          faturaNova: faturaCorreta,
        });
      });
    });

    console.log(`  Total de itens desse cartão encontrados: ${totalItensCartao}`);
    console.log(`  Propostas de correção: ${propostas.length}`);
    propostas.slice(0, 10).forEach(p => {
      console.log(`    [doc ${p.docOrigem}] ${p.descricao}${p.parcela ? ' ('+p.parcela+')' : ''} — R$${p.valor} em ${p.data}: ${p.faturaAntiga} -> ${p.faturaNova}`);
    });
    if (propostas.length > 10) console.log(`    ... e mais ${propostas.length - 10}`);
    console.log('');
  }
  process.exit(0);
})().catch(e => { console.error('Erro:', e); process.exit(1); });
