// Tema 2026: liga a classe html.tema-novo, que ativa css/tema-2026.css.
// Testado só com a Flávia (10/11/2026) e liberado para todas no mesmo dia,
// a pedido dela. Vale para qualquer conta logada, inclusive no "ver como"
// (o admin vê a tela igual à aluna). O script do <head> de cada página lê a
// marca 'temaNovoTeste' para aplicar o tema já no primeiro desenho, sem
// piscar; aqui ela é gravada ou removida assim que o login é conhecido.
import { auth } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const EH_ADMIN = /\/admin\.html$/.test(location.pathname);

export function temaNovoAtivo(user = auth.currentUser) {
  return !!user;
}

function aplicar(user) {
  const ativo = temaNovoAtivo(user);
  const h = document.documentElement;
  h.classList.toggle('tema-novo', ativo);
  h.classList.toggle('tema-admin', ativo && EH_ADMIN);
  // Marca da tela (ex.: tn-liberdade), para regras que usam nomes genéricos como .card
  const pg = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
  h.classList.toggle('tn-' + pg, ativo);
  h.classList.toggle('tn-pj', ativo && /-pj$/.test(pg));
  try {
    if (ativo) localStorage.setItem('temaNovoTeste', '1');
    else localStorage.removeItem('temaNovoTeste');
  } catch (_) {}
}

onAuthStateChanged(auth, aplicar);
