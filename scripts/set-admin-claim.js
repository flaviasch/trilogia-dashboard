/**
 * set-admin-claim.js
 * Script Node.js de uso único para definir (ou remover) a Custom Claim
 * { admin: true } na conta Firebase de um usuário.
 *
 * COMO USAR:
 *   1. Baixe a chave de serviço do Firebase Console:
 *      Configurações do projeto → Contas de serviço → Gerar nova chave privada
 *      Salve como "serviceAccountKey.json" na pasta scripts/ (não suba ao Git).
 *
 *   2. Instale a dependência:
 *      npm install firebase-admin
 *
 *   3. Execute passando o e-mail da usuária:
 *      node set-admin-claim.js flaviasch@gmail.com
 *
 *      Para remover o acesso admin:
 *      node set-admin-claim.js flaviasch@gmail.com --remover
 *
 * IMPORTANTE: após executar, a usuária deve fazer logout e login novamente
 * para o token ser atualizado com a nova claim.
 */

'use strict';

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

// ─── Carregar credenciais ──────────────────────────────────────────────────────

const keyPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(keyPath)) {
  console.error('\n❌ Arquivo não encontrado: scripts/serviceAccountKey.json');
  console.error('   Baixe em: Firebase Console → Configurações → Contas de serviço\n');
  process.exit(1);
}

const serviceAccount = require(keyPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ─── Argumentos ────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const email   = args[0];
const remover = args.includes('--remover');

if (!email) {
  console.error('\nUso: node set-admin-claim.js <email> [--remover]\n');
  process.exit(1);
}

// ─── Executar ──────────────────────────────────────────────────────────────────

async function main() {
  let user;

  // Buscar usuária pelo e-mail
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      console.error(`\n❌ Nenhuma conta encontrada com o e-mail: ${email}`);
      console.error('   Verifique se a usuária já fez login ao menos uma vez.\n');
    } else {
      console.error('\n❌ Erro ao buscar usuária:', err.message, '\n');
    }
    process.exit(1);
  }

  const uid          = user.uid;
  const claimsAtuais = user.customClaims || {};
  const novasClaims  = remover
    ? { ...claimsAtuais, admin: false }
    : { ...claimsAtuais, admin: true };

  // Definir as claims
  await admin.auth().setCustomUserClaims(uid, novasClaims);

  // Confirmar lendo de volta
  const userAtualizado = await admin.auth().getUser(uid);
  const claimsFinais   = userAtualizado.customClaims || {};

  if (remover) {
    console.log(`\n✅ Acesso admin REMOVIDO para: ${email}`);
  } else {
    console.log(`\n✅ Acesso admin CONCEDIDO para: ${email}`);
  }

  console.log(`   UID: ${uid}`);
  console.log(`   Claims atuais: ${JSON.stringify(claimsFinais)}`);
  console.log('\n⚠️  A usuária precisa fazer logout e login novamente para o token ser atualizado.\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Erro inesperado:', err.message, '\n');
  process.exit(1);
});
