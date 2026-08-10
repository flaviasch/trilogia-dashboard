'use strict';
/**
 * limpar-impostos-orfaos.js
 *
 * Limpeza pontual (achado 09/08/2026, Flávia: excluiu tributos duplicados
 * em "Configurar tributos", deu F5, a duplicidade continuou aparecendo na
 * Provisão do mês): deleteTributoConfig nunca apagou as linhas de
 * impostosPrevistos já geradas por aquele tributo — elas ficam órfãs
 * (tributoId aponta pra um doc que não existe mais em tributosConfig).
 * O fix em functions/index.js (deleteTributoConfig agora limpa as órfãs
 * não-pagas na hora) resolve daqui pra frente; este script limpa o que já
 * ficou pra trás.
 *
 * Faz backup local (JSON) antes de qualquer exclusão. Só apaga linhas
 * órfãs com pago:false — linhas órfãs já PAGAS são histórico real de
 * pagamento e são listadas separadamente pra você revisar à mão (nunca
 * apagadas automaticamente).
 *
 * Uso:
 *   node limpar-impostos-orfaos.js            (dry-run — só lista, não apaga)
 *   node limpar-impostos-orfaos.js --confirmar (apaga de verdade)
 * (precisa do scripts/serviceAccountKey.json, mesmo usado pelos outros
 * scripts de admin do projeto)
 */

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

const EMAIL_ADMIN = process.argv.find(a => a.includes('@')) || 'flaviasch@gmail.com';
const CONFIRMAR = process.argv.includes('--confirmar');

function fmtBRL(v) {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function main() {
  const user = await admin.auth().getUserByEmail(EMAIL_ADMIN);
  const uid = user.uid;
  console.log(`Conta: ${EMAIL_ADMIN} (uid ${uid})`);

  const [tributosSnap, impostosSnap] = await Promise.all([
    db.collection('tributosConfig').where('uid', '==', uid).get(),
    db.collection('impostosPrevistos').where('uid', '==', uid).get(),
  ]);

  const idsAtivos = new Set(tributosSnap.docs.map(d => d.id));
  console.log(`tributosConfig ativos: ${idsAtivos.size}`);
  console.log(`impostosPrevistos no total: ${impostosSnap.size}`);

  const orfas = impostosSnap.docs.filter(d => !idsAtivos.has(d.data().tributoId));
  const orfasNaoPagas = orfas.filter(d => !d.data().pago);
  const orfasPagas    = orfas.filter(d => d.data().pago);

  console.log(`\nLinhas órfãs (tributo já excluído): ${orfas.length}`);
  console.log(`  não pagas (serão removidas): ${orfasNaoPagas.length}`);
  console.log(`  JÁ PAGAS (nunca removidas automaticamente): ${orfasPagas.length}`);

  if (orfasNaoPagas.length) {
    console.log('\n— Não pagas, candidatas à remoção —');
    orfasNaoPagas.forEach(d => {
      const i = d.data();
      console.log(`  [${d.id}] ${i.tributoNome} — ${i.trimestre ? `${i.trimestre}º tri/${i.ano}` : `${i.mes}/${i.ano}`} — ${fmtBRL(i.valor)}`);
    });
  }
  if (orfasPagas.length) {
    console.log('\n— JÁ PAGAS, órfãs mas preservadas (revise à mão se quiser apagar) —');
    orfasPagas.forEach(d => {
      const i = d.data();
      console.log(`  [${d.id}] ${i.tributoNome} — ${i.trimestre ? `${i.trimestre}º tri/${i.ano}` : `${i.mes}/${i.ano}`} — ${fmtBRL(i.valor)}`);
    });
  }

  if (!orfasNaoPagas.length) {
    console.log('\nNada a remover.');
    process.exit(0);
  }

  if (!CONFIRMAR) {
    console.log(`\nDry-run — nada foi apagado. Rode de novo com --confirmar pra remover as ${orfasNaoPagas.length} linha(s) não pagas listadas acima.`);
    process.exit(0);
  }

  // Backup antes de apagar
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const arquivoBackup = path.join(__dirname, `backup-impostos-orfaos-${timestamp}.json`);
  fs.writeFileSync(arquivoBackup, JSON.stringify(orfasNaoPagas.map(d => ({ id: d.id, ...d.data() })), null, 2));
  console.log(`Backup das linhas removidas salvo em: ${arquivoBackup}`);

  const batch = db.batch();
  orfasNaoPagas.forEach(d => batch.delete(d.ref));
  await batch.commit();
  console.log(`\n✅ ${orfasNaoPagas.length} linha(s) órfã(s) removida(s).`);
  process.exit(0);
}

main().catch(err => { console.error('❌ Erro:', err); process.exit(1); });
