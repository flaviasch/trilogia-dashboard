// ─── Tema claro/escuro — Trilogia Dashboard ────────────────────────────────
// Preferência salva no localStorage do navegador. Padrão é escuro (como sempre foi).
const THEME_KEY = 'trilogia-theme';

function getSavedTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; }
  catch (e) { return 'dark'; }
}

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const btn = document.getElementById('btnTheme');
  if (btn) {
    btn.textContent = theme === 'light' ? '🌙' : '☀️';
    btn.title = theme === 'light' ? 'Mudar para tema escuro' : 'Mudar para tema claro';
  }
}

function toggleTheme() {
  const next = getSavedTheme() === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyTheme(next);
}

document.addEventListener('DOMContentLoaded', () => applyTheme(getSavedTheme()));
