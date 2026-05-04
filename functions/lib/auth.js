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

module.exports = { requireAuth, requireAdmin, requireSelfOrAdmin, getSheetId };
