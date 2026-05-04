import { auth } from './firebase-config.js';
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

/**
 * Garante que o usuário está autenticado.
 * Se não estiver, redireciona para login.html.
 * Retorna uma Promise que resolve com o objeto user quando autenticado.
 */
export function requireAuth() {
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
 * Faz logout e redireciona para login.html.
 */
export async function logout() {
  await signOut(auth);
  window.location.href = 'login.html';
}

/**
 * Escuta mudanças de autenticação sem redirecionar.
 * Útil para atualizar a UI quando o token expira.
 */
export function onAuth(callback) {
  return onAuthStateChanged(auth, callback);
}
