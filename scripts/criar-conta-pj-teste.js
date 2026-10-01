'use strict';
/**
 * criar-conta-pj-teste.js
 * Cria (ou reaproveita, se já existir) uma conta no Firebase Auth pra testar
 * o Dashboard PJ ponta a ponta, antes de existir produto de verdade no
 * Kiwify (fase Venda, ainda não construída). Não cria nenhum documento em
 * `contasPJ` — isso acontece via onboarding-pj.html, na primeira vez que a
 * conta loga em login-pj.html.
 *
 * Se o e-mail já existir no projeto (ex: já é mentorada PF), reaproveita o
 * mesmo uid — é exatamente o comportamento pedido por Flávia em 24/07/2026:
 * mesmo e-mail/senha serve pra PF e PJ, a separação é de dado (coleção
 * `contasPJ` != `mentoradas`), não de login.
 *
 * Uso: node criar-conta-pj-teste.js email@teste.com "Nome da pessoa"
 */

const admin = require('firebase-admin');
const path  = require('path');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function main() {
  const email = process.argv[2];
  const nome  = process.argv[3] || email;
  if (!email) {
    console.error('Uso: node criar-conta-pj-teste.js email@teste.com "Nome"');
    process.exit(1);
  }

  let user;
  let jaExistia = true;
  try {
    user = await admin.auth().getUserByEmail(email);
    console.log(`Conta já existe (uid: ${user.uid}) — reaproveitando pra teste PJ.`);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;
    jaExistia = false;
    const senha = Math.random().toString(36).slice(-8) + 'Aa1!';
    user = await admin.auth().createUser({ email, password: senha, displayName: nome });
    console.log(`Conta nova criada (uid: ${user.uid}).`);
  }

  if (!jaExistia) {
    const link = await admin.auth().generatePasswordResetLink(email, {
      url: 'https://dashboard.flaviaschusciman.com/login-pj.html',
    });
    console.log(`\nLink pra definir senha (envie manualmente pra pessoa de teste):\n${link}\n`);
  } else {
    console.log(`\nConta já tinha senha — usa a mesma senha da conta PF pra logar em login-pj.html.\n`);
  }

  console.log(`Próximo passo: logar em login-pj.html com ${email}. Como ainda não existe`);
  console.log(`documento em "contasPJ" pra esse uid, cai direto em onboarding-pj.html.`);
  process.exit(0);
}

main().catch(err => { console.error('❌ Erro:', err); process.exit(1); });
