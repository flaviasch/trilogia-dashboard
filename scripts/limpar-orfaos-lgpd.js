'use strict';
/**
 * limpar-orfaos-lgpd.js
 *
 * Limpeza pontual (auditoria de segurança 01/10/2026, achado Alto LGPD):
 * até essa data, deletarMentorada apagava só 6 subcoleções fixas de
 * mentoradas/{uid} (orcamento, reservas, perfil, historico, planejamento,
 * scores). As outras (patrimonio, cartoes, contas, saldosConta, recorrentes,
 * faturaEstados, analytics, categoriasAprendidas, decisoesFinanceiras,
 * materiaisJornada, config, contratos...) ficaram órfãs no Firestore, e
 * dado de Dashboard PJ do mesmo uid também não era apagado. O fix em
 * functions/index.js resolve daqui pra frente; este script limpa o que já
 * ficou pra trás, para cada uid registrado em mentoradas_deletadas.
 *
 * Trava de segurança: só mexe num uid se o doc mentoradas/{uid} NÃO existe
 * e a conta Auth também NÃO existe. Qualquer uid que falhe nisso é pulado
 * e listado.
 *
 * Não faz backup local de propósito: o objetivo é eliminar o dado (LGPD).
 * O export semanal do Firestore (backupFirestore) ainda guarda cópias
 * antigas até a regra de retenção do bucket apagar.
 *
 * Uso (dentro de scripts/):
 *   node limpar-orfaos-lgpd.js              (dry-run: só lista, não apaga)
 *   node limpar-orfaos-lgpd.js --confirmar  (apaga de verdade)
 * Precisa do scripts/serviceAccountKey.json, como os outros scripts.
 */

const admin = require('firebase-admin');
const path  = require('path');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const CONFIRMAR = process.argv.includes('--confirmar');

const COLECOES_PJ = ['notasEmitidas', 'despesasPJ', 'reservasPJ', 'cartoesPJ', 'faturaEstadosPJ',
                     'tributosConfig', 'impostosPrevistos', 'outrasEntradasPJ'];

async function contarDocs(ref) {
  const snap = await ref.count().get();
  return snap.data().count;
}

async function authExiste(uid) {
  try { await admin.auth().getUser(uid); return true; }
  catch (err) { if (err.code === 'auth/user-not-found') return false; throw err; }
}

async function main() {
  console.log(CONFIRMAR ? '*** MODO CONFIRMAR: vai apagar ***\n' : 'Dry-run (nada é apagado). Use --confirmar para apagar.\n');

  const deletadas = await db.collection('mentoradas_deletadas').get();
  console.log(`Registros em mentoradas_deletadas: ${deletadas.size}\n`);

  let totalOrfaos = 0;
  const pulados = [];

  for (const reg of deletadas.docs) {
    const uid  = reg.id;
    const nome = reg.data().nome || '(sem nome)';

    const mentRef = db.collection('mentoradas').doc(uid);
    if ((await mentRef.get()).exists || await authExiste(uid)) {
      pulados.push(`${nome} (${uid}): doc ou conta Auth ainda existe`);
      continue;
    }

    const achados = [];
    for (const sub of await mentRef.listCollections()) {
      const n = await contarDocs(sub);
      if (n) achados.push(`mentoradas/${uid}/${sub.id}: ${n}`);
    }
    for (const nomeColecao of COLECOES_PJ) {
      const n = await contarDocs(db.collection(nomeColecao).where('uid', '==', uid));
      if (n) achados.push(`${nomeColecao}: ${n}`);
    }
    const contaPJRef = db.collection('contasPJ').doc(uid);
    const contaPJExiste = (await contaPJRef.get()).exists;
    if (contaPJExiste) achados.push('contasPJ (doc principal)');
    for (const sub of await contaPJRef.listCollections()) {
      const n = await contarDocs(sub);
      if (n) achados.push(`contasPJ/${uid}/${sub.id}: ${n}`);
    }
    const proLaboreRef = db.collection('proLaborePJ').doc(uid);
    if ((await proLaboreRef.get()).exists) achados.push('proLaborePJ (doc principal)');
    for (const sub of await proLaboreRef.listCollections()) {
      const n = await contarDocs(sub);
      if (n) achados.push(`proLaborePJ/${uid}/${sub.id}: ${n}`);
    }

    if (!achados.length) continue;
    totalOrfaos++;
    console.log(`${nome} (${uid})`);
    achados.forEach(a => console.log(`   ${a}`));

    if (CONFIRMAR) {
      await db.recursiveDelete(mentRef);
      for (const nomeColecao of COLECOES_PJ) {
        const snap = await db.collection(nomeColecao).where('uid', '==', uid).get();
        for (const doc of snap.docs) await db.recursiveDelete(doc.ref);
      }
      await db.recursiveDelete(contaPJRef);
      await db.recursiveDelete(proLaboreRef);
      await reg.ref.update({ orfaosLimposEm: admin.firestore.FieldValue.serverTimestamp() });
      console.log('   -> apagado');
    }
    console.log('');
  }

  console.log(`uids com dado órfão: ${totalOrfaos}`);
  if (pulados.length) {
    console.log(`\nPulados (${pulados.length}), conferir à mão:`);
    pulados.forEach(p => console.log(`   ${p}`));
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
