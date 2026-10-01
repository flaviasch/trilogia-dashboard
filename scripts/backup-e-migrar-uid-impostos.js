'use strict';
/**
 * backup-e-migrar-uid-impostos.js
 *
 * Passo 2 do plano de ação da auditoria de 24/07/2026 (retrofit multi-tenant
 * do módulo Impostos, pré-requisito antes de expor essas coleções ao
 * Dashboard PJ): faz backup local (JSON) de tributosConfig, notasEmitidas e
 * impostosPrevistos, e depois adiciona o campo `uid` a cada documento que
 * ainda não tiver — atribuindo o uid da própria Flávia (conta admin), já que
 * até hoje esses dados são só o uso interno dela mesma como PJ da Trilogia
 * Financeira.
 *
 * Idempotente: se rodar de novo, documentos que já têm `uid` são ignorados
 * (não sobrescreve).
 *
 * Uso: node backup-e-migrar-uid-impostos.js
 * (precisa do scripts/serviceAccountKey.json, mesmo usado pelos outros
 * scripts de admin do projeto)
 */

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

const COLECOES = ['tributosConfig', 'notasEmitidas', 'impostosPrevistos'];
const EMAIL_ADMIN = 'flaviasch@gmail.com';

async function main() {
  // 1. Descobre o uid da conta admin
  const user = await admin.auth().getUserByEmail(EMAIL_ADMIN);
  const uidAdmin = user.uid;
  console.log(`Uid da conta admin (${EMAIL_ADMIN}): ${uidAdmin}`);

  // 2. Backup local em JSON, com timestamp, antes de qualquer escrita
  const backup = {};
  for (const colecao of COLECOES) {
    const snap = await db.collection(colecao).get();
    backup[colecao] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const arquivoBackup = path.join(__dirname, `backup-impostos-${timestamp}.json`);
  fs.writeFileSync(arquivoBackup, JSON.stringify(backup, null, 2));
  console.log(`Backup salvo em: ${arquivoBackup}`);
  for (const colecao of COLECOES) {
    console.log(`  ${colecao}: ${backup[colecao].length} documento(s)`);
  }

  // 3. Migração: adiciona uid aos documentos que ainda não têm
  let totalMigrados = 0;
  for (const colecao of COLECOES) {
    const snap = await db.collection(colecao).get();
    const semUid = snap.docs.filter(d => !d.data().uid);
    if (!semUid.length) {
      console.log(`${colecao}: nenhum documento sem uid, nada a migrar.`);
      continue;
    }
    const batch = db.batch();
    semUid.forEach(d => batch.update(d.ref, { uid: uidAdmin }));
    await batch.commit();
    console.log(`${colecao}: ${semUid.length} documento(s) migrado(s) com uid=${uidAdmin}.`);
    totalMigrados += semUid.length;
  }

  console.log(`\n✅ Concluído: ${totalMigrados} documento(s) migrado(s) no total.`);
  console.log(`Guarde o arquivo de backup (${path.basename(arquivoBackup)}) até confirmar que o retrofit está funcionando em produção.`);
  process.exit(0);
}

main().catch(err => { console.error('❌ Erro:', err); process.exit(1); });
