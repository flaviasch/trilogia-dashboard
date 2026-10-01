'use strict';
/**
 * criar-perfil-admin.js
 * Cria o documento mentoradas/{uid} para a conta admin da Flávia,
 * permitindo que ela acesse o Dashboard como usuária.
 *
 * Uso: node criar-perfil-admin.js
 */

const admin = require('firebase-admin');
const path  = require('path');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

async function main() {
  const email = 'flaviasch@gmail.com';

  // 1. Buscar UID da conta admin
  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (err) {
    console.error(`❌ Conta não encontrada para ${email}:`, err.message);
    process.exit(1);
  }

  const uid = user.uid;
  console.log(`✔ UID encontrado: ${uid}`);

  // 2. Verificar se documento já existe
  const docRef = db.collection('mentoradas').doc(uid);
  const snap   = await docRef.get();

  if (snap.exists) {
    console.log('⚠️  Documento já existe. Dados atuais:');
    console.log(JSON.stringify(snap.data(), null, 2));
    console.log('\nAtualizando apenas flags de assinatura...');
    await docRef.update({
      assinaturaDashboard: true,
      assinaturaClube:     true,
      produto:             'combo',
    });
    console.log('✅ Flags atualizadas.');
    process.exit(0);
  }

  // 3. Criar documento
  const hoje = new Date().toISOString().slice(0, 7); // ex: "2026-06"
  await docRef.set({
    nome:                'Flávia Schusciman',
    email,
    inicio:              hoje,
    perfil:              'Admin',
    produto:             'combo',
    valorMensal:         null,
    formaPagamento:      null,
    dataExpiracao:       null,
    status:              'ativa',
    sheetId:             null,
    nota:                '',
    ultimoAcesso:        null,
    totalAcessos:        0,
    lgpdAceite:          true,
    lgpdAceiteData:      admin.firestore.FieldValue.serverTimestamp(),
    assinaturaDashboard: true,
    assinaturaClube:     true,
    criadoEm:            admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`✅ Documento criado em mentoradas/${uid}`);
  console.log('   Produto: combo (Dashboard + Clube)');
  console.log('   Agora você pode acessar o Dashboard como usuária ao fazer login.');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Erro inesperado:', err.message);
  process.exit(1);
});
