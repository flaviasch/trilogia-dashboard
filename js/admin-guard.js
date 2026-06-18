/**
 * admin-guard.js
 * Utilitários de autenticação e autorização para o frontend.
 *
 * Uso típico em admin.html:
 *
 *   import { exigirAdmin } from './js/admin-guard.js';
 *   const user = await exigirAdmin(); // redireciona se não for admin
 */

import { auth } from './firebase-config.js';
import {
  onAuthStateChanged,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// ─── Verificar claim no token ──────────────────────────────────────────────────

/**
 * Retorna true se o usuário logado tiver a Custom Claim { admin: true }.
 * Força refresh do token para garantir que claims recentes sejam lidas.
 *
 * @param {boolean} forcarRefresh - se true, descarta o cache do token (padrão: false)
 */
export async function isAdmin(forcarRefresh = false) {
  const user = auth.currentUser;
  if (!user) return false;
  const token = await user.getIdTokenResult(forcarRefresh);
  return token.claims.admin === true;
}

// ─── Guards ────────────────────────────────────────────────────────────────────

/**
 * Garante que o usuário está logado.
 * Se não estiver, redireciona para login.html e retorna null.
 *
 * @returns {Promise<import('firebase/auth').User>}
 */
export function exigirAuth() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, (user) => {
      if (!user) {
        window.location.href = 'login.html';
        return;
      }
      resolve(user);
    });
  });
}

/**
 * Garante que o usuário está logado E tem claim admin === true.
 * Se não estiver logado → redireciona para login.html.
 * Se logado mas não for admin → retorna null (cabe ao caller mostrar tela de acesso negado).
 *
 * @returns {Promise<import('firebase/auth').User | null>}
 */
export async function exigirAdmin() {
  const user = await exigirAuth();

  // Verifica com refresh para pegar claims recém-atribuídas
  const adminOk = await isAdmin(false);
  if (!adminOk) {
    // Tenta uma vez com refresh forçado (caso a claim tenha sido setada recentemente)
    const adminOkRefresh = await isAdmin(true);
    if (!adminOkRefresh) return null;
  }

  return user;
}

/**
 * Faz logout e redireciona para login.html.
 */
export async function logout() {
  const uid = auth.currentUser?.uid;
  if (uid) localStorage.removeItem(`dash_v1_${uid}`);
  localStorage.removeItem('viewAsUid');
  await signOut(auth);
  window.location.href = 'login.html';
}

// ─── Refresh automático de token ───────────────────────────────────────────────

/**
 * Força o refresh do token ID.
 * Útil logo após o script set-admin-claim.js ser executado:
 * o usuário pode clicar em "Recarregar permissões" sem precisar fazer logout.
 *
 * @returns {Promise<boolean>} - true se agora é admin, false caso contrário
 */
export async function refreshAdmin() {
  const user = auth.currentUser;
  if (!user) return false;
  return isAdmin(true);
}
