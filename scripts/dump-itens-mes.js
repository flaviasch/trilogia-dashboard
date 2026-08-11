'use strict';
/**
 * dump-itens-mes.js
 * Só LEITURA — despeja TODOS os itens crus de um mês (sem nenhum filtro de
 * conta/categoria/fatura), pra investigar item que devia aparecer na UI mas
 * não aparece em lugar nenhum. Útil quando o diagnóstico por categoria+dia
 * (diagnosticar-fixa.js) pode ter batido em outro item por engano.
 *
 * Uso: node dump-itens-mes.js [email] [mes] [ano] [termo de busca opcional]
 * Ex:  node dump-itens-mes.js flaviasch@gmail.com 9 2026 social
 */

const admin = require('firebase-admin');
const path  = require('path');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  const email  = process.argv[2] || 'flaviasch@gmail.com';
  const mes    = Number(process.argv[3]) || (new Date().getMonth() + 1);
  const ano    = Number(process.argv[4]) || new Date().getFullYear();
  const termo  = (process.argv[5] || '').toLowerCase();
  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;

  const user = await admin.auth().getUserByEmail(email);
  const uid = user.uid;
  console.log(`UID: ${uid} — mês ${mesKey}${termo ? ` — filtrando por "${termo}"` : ''}\n`);

  const [contasSnap, docSnap] = await Promise.all([
    db.collection('mentoradas').doc(uid).collection('contas').get(),
    db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKey).get(),
  ]);
  const contas = contasSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log(`Contas cadastradas: ${contas.map(c => `${c.id}${c.nome ? ` (${c.nome})` : ''}${c.principal ? ' [principal]' : ''}`).join(', ') || '(nenhuma — só a principal implícita)'}\n`);

  if (!docSnap.exists) { console.log(`Nenhum documento salvo pra ${mesKey}.`); process.exit(0); }

  const itens = docSnap.data().itens || [];
  console.log(`Total de itens no documento: ${itens.length}\n`);

  const filtrados = termo
    ? itens.map((it, idx) => ({ it, idx })).filter(({ it }) =>
        (it.categoria || '').toLowerCase().includes(termo) || (it.descricao || '').toLowerCase().includes(termo))
    : itens.map((it, idx) => ({ it, idx }));

  console.log(`Itens ${termo ? 'batendo o filtro' : 'no total'}: ${filtrados.length}\n`);
  filtrados.forEach(({ it, idx }) => {
    console.log(`[${idx}] ${JSON.stringify(it, null, 2)}`);
  });

  process.exit(0);
}

main().catch(err => { console.error('Erro:', err.message); process.exit(1); });
