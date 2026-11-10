// Tema 2026 (10/11/2026, em teste): liga a classe html.tema-novo, que ativa
// css/tema-2026.css. Só para a allowlist de teste, nunca no "ver como".
// O script do <head> de cada página lê a marca 'temaNovoTeste' (o uid de
// quem está na allowlist) para aplicar o tema já no primeiro desenho, sem
// piscar; aqui ela é confirmada ou removida assim que o login é conhecido.
import { auth } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const ALLOWLIST = ['flaviasch@gmail.com', 'flavia.schusciman@biginvest.com.br'];
// No painel admin não existe "ver como": é sempre a própria Flávia.
const EH_ADMIN = /\/admin\.html$/.test(location.pathname);

// "Ver como" de verdade = admin olhando OUTRA conta. Marca viewAsUid antiga
// com o próprio uid não conta (mesma regra de js/cel-nav.js).
function emVerComo(user) {
  if (EH_ADMIN) return false;
  try {
    if (new URLSearchParams(location.search).has('viewAs')) return true;
    const v = localStorage.getItem('viewAsUid');
    return !!v && !(user && v === user.uid);
  } catch (_) { return false; }
}

export function temaNovoAtivo(user = auth.currentUser) {
  return !!user && !emVerComo(user) && ALLOWLIST.includes((user.email || '').toLowerCase());
}

function aplicar(user) {
  const ativo = temaNovoAtivo(user);
  document.documentElement.classList.toggle('tema-novo', ativo);
  document.documentElement.classList.toggle('tema-admin', ativo && EH_ADMIN);
  // Marca da tela (ex.: tn-liberdade), para regras que usam nomes genéricos como .card
  const pg = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
  document.documentElement.classList.toggle('tn-' + pg, ativo);
  document.documentElement.classList.toggle('tn-pj', ativo && /-pj$/.test(pg));
  try {
    if (ativo) localStorage.setItem('temaNovoTeste', user.uid);
    else if (!emVerComo(user)) localStorage.removeItem('temaNovoTeste');
  } catch (_) {}
}

onAuthStateChanged(auth, aplicar);
