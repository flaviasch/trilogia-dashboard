'use strict';

const { HttpsError } = require('firebase-functions/v2/https');

/**
 * Garante que a chamada tem autenticação. Lança unauthenticated caso contrário.
 */
function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login necessário.');
  }
  return request.auth;
}

/**
 * Garante que o chamador é admin verificando a Custom Claim { admin: true }
 * no token JWT. Lança permission-denied caso contrário.
 *
 * A claim é definida via scripts/set-admin-claim.js e embutida no token
 * pelo Firebase Auth automaticamente a cada login.
 */
function requireAdmin(request) {
  const auth = requireAuth(request);
  if (auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Acesso restrito a administradores.');
  }
  return auth;
}

/**
 * Garante que o chamador acessa apenas seus próprios dados — ou é admin.
 * Mentoradas só veem o próprio perfil; a Flávia vê qualquer um.
 *
 * @param {string} uidAlvo - UID do recurso sendo acessado
 */
function requireSelfOrAdmin(request, uidAlvo) {
  const auth    = requireAuth(request);
  const isAdmin = auth.token.admin === true;
  if (!isAdmin && auth.uid !== uidAlvo) {
    throw new HttpsError('permission-denied', 'Acesso negado.');
  }
  return auth;
}

/**
 * Busca o ID da planilha Google Sheets da mentorada no Firestore.
 * Documento: mentoradas/{uid}  →  { sheetId, nome, email, status, ... }
 */
async function getSheetId(db, uid) {
  const doc = await db.collection('mentoradas').doc(uid).get();
  if (!doc.exists) {
    throw new HttpsError('not-found', `Mentorada não encontrada: ${uid}`);
  }
  const sheetId = doc.data().sheetId;
  if (!sheetId) {
    throw new HttpsError('failed-precondition', 'Planilha ainda não configurada para esta mentorada.');
  }
  return sheetId;
}

/**
 * Garante acesso ao Dashboard PJ de `uidTitular` — libera sempre para a
 * titular (auth.uid === uidTitular) e para admin; para um usuário
 * secundário (custom claim `pjOwnerUid` === uidTitular), só libera se o doc
 * `contasPJ/{uidTitular}/usuariosSecundarios/{subUid}` existir, estiver
 * `ativo: true` e — quando `aba` for informado — a aba estiver em
 * `abasPermitidas`.
 *
 * 02/09/2026, projeto de acesso multiusuário do Dashboard PJ (caso
 * Isabela/funcionária): a claim só identifica QUEM é o dono da conta —
 * estável, segura de ler do JWT. A permissão em si (ativo/abas) é sempre
 * lida do Firestore, nunca confiada à claim, porque claims só atualizam no
 * próximo login/refresh de token — uma desativação feita agora pela
 * titular não pode ficar esperando o token expirar pra valer.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {import('firebase-functions/v2/https').CallableRequest} request
 * @param {string} uidTitular
 * @param {string} [aba] - chave da aba sendo acessada (ex: 'recebimentos').
 *   Omitido quando a function não é específica de uma aba (ex: getContaPJ).
 */
async function requireContaPJAccess(db, request, uidTitular, aba) {
  const auth = requireAuth(request);
  if (auth.token.admin === true) return auth;
  if (auth.uid === uidTitular) return auth;

  if (auth.token.pjOwnerUid === uidTitular) {
    const snap = await db
      .collection('contasPJ').doc(uidTitular)
      .collection('usuariosSecundarios').doc(auth.uid)
      .get();
    if (snap.exists) {
      const dados = snap.data();
      const abasOk = !aba || (Array.isArray(dados.abasPermitidas) && dados.abasPermitidas.includes(aba));
      if (dados.ativo === true && abasOk) return auth;
    }
  }

  throw new HttpsError('permission-denied', 'Acesso negado.');
}

module.exports = { requireAuth, requireAdmin, requireSelfOrAdmin, getSheetId, requireContaPJAccess };
