'use strict';

// Aponta o Admin SDK pro emulador do Firestore ANTES de exigir index.js —
// precisa ser a primeira coisa a rodar em qualquer arquivo de teste de
// integração. Nunca roda contra o Firestore de produção.
// "demo-*" é o prefixo reconhecido pelo Firebase Emulator Suite pra projeto
// de teste — não existe de verdade, não precisa de credencial, e o SDK
// bloqueia qualquer tentativa de sair do emulador pra produção com esse ID.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-test';

const fns = require('../index');

/** Contexto de autenticação falso pro .run() das Cloud Functions v2. */
function auth(uid, isAdmin = false) {
  return { uid, token: { admin: isAdmin } };
}

/** UID único por teste — evita qualquer colisão entre casos de teste. */
function uidTeste(prefixo = 'test') {
  return `${prefixo}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { fns, auth, uidTeste };
