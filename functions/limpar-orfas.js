'use strict';
/**
 * Script único: remove cobranças cujo uidMentorada não existe mais no Firestore.
 * Rodar: node functions/limpar-orfas.js
 */
process.env.GOOGLE_CLOUD_PROJECT = 'trilogia-dashboard';
const admin = require('firebase-admin');

admin.initializeApp({ projectId: 'trilogia-dashboard' });
const db = admin.firestore();

async function main() {
  const cobsSnap = await db.collection('cobrancas').get();
  console.log(`Total de cobranças: ${cobsSnap.size}`);

  const batch = db.batch();
  let deletadas = 0;

  for (const doc of cobsSnap.docs) {
    const uid = doc.data().uidMentorada;
    if (!uid) continue;
    const mDoc = await db.collection('mentoradas').doc(uid).get();
    if (!mDoc.exists) {
      console.log(`Órfã: ${doc.id} | aluna: ${doc.data().nomeAluna} | uid: ${uid}`);
      batch.delete(doc.ref);
      deletadas++;
    }
  }

  if (deletadas === 0) {
    console.log('Nenhuma cobrança órfã encontrada.');
  } else {
    await batch.commit();
    console.log(`✅ ${deletadas} cobrança(s) órfã(s) removidas.`);
  }
  process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
