// Barra de baixo única do modo celular simplificado (10/11/2026, em teste).
// Pedido da Flávia: no celular, os mesmos 4 botões (Início, Orçamento, Metas,
// Mais) em todas as telas; o "Mais" reúne o que saiu da barra. Só para a
// allowlist de teste, nunca no "ver como". O Orçamento tem a sua própria
// (#celBottomNav em orcamento.html) com o mesmo desenho e a mesma lista.
import { auth } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const ALLOWLIST = ['flaviasch@gmail.com', 'flavia.schusciman@biginvest.com.br'];
const mq = window.matchMedia('(max-width: 767px)');

function emVerComo() {
  try {
    return !!localStorage.getItem('viewAsUid') || new URLSearchParams(location.search).has('viewAs');
  } catch (_) { return false; }
}

export function celNavAtivo(user = auth.currentUser) {
  return !!user && mq.matches && !emVerComo() && ALLOWLIST.includes((user.email || '').toLowerCase());
}

const ICONES = {
  inicio: '<svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  orcamento: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M16 13h2"/><path d="M2 10h20"/></svg>',
  metas: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
  mais: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>',
};

// Lista do "Mais", igual em todas as telas. Itens do Orçamento abrem
// orcamento.html?cel=... (tratado lá).
export function itensMais() {
  const clube = document.getElementById('linkClube');
  const temClube = !!clube && getComputedStyle(clube).display !== 'none';
  return [
    ['💳 Faturas do cartão', 'orcamento.html?cel=faturas'],
    ['📊 Gráficos', 'orcamento.html?cel=graficos'],
    ['📅 Análise do ano', 'orcamento.html?cel=anual'],
    ['🧾 Orçamento completo', 'orcamento.html?cel=completo'],
    ['💰 Patrimônio', 'patrimonio.html'],
    ['🧭 Jornada', 'jornada.html'],
    ['👤 Perfil de investidor', 'perfil.html'],
    ...(temClube ? [['⭐ Clube', 'clube.html']] : []),
    ['❓ Ajuda', 'ajuda.html'],
  ];
}

export function abrirMais(itens = itensMais()) {
  const fundo = document.createElement('div');
  fundo.className = 'celnav-fundo';
  fundo.innerHTML = `<div class="celnav-sheet"><div class="celnav-tit">Mais</div>${itens.map(([r, h]) => `<a href="${h}">${r}</a>`).join('')}</div>`;
  fundo.addEventListener('click', e => { if (e.target === fundo) fundo.remove(); });
  document.body.appendChild(fundo);
}

function estilos() {
  if (document.getElementById('celnav-css')) return;
  const s = document.createElement('style');
  s.id = 'celnav-css';
  s.textContent = `
    body.cel-nav-global .bottom-nav { display: none !important; }
    body.cel-nav-global { padding-bottom: 64px; }
    #celNavGlobal { position: fixed; bottom: 0; left: 0; right: 0; z-index: 150; display: flex; height: 60px;
      background: var(--navy, #0D2B45); border-top: 1px solid var(--border, rgba(255,255,255,.08)); justify-content: space-around; align-items: stretch; }
    #celNavGlobal a, #celNavGlobal button { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
      background: none; border: none; color: var(--text-muted, #8a9bb0); font-size: 10px; font-weight: 500; text-decoration: none; font-family: inherit; cursor: pointer; }
    #celNavGlobal .ativo { color: var(--gold, #CFAE65); }
    #celNavGlobal svg { width: 22px; height: 22px; stroke: currentColor; fill: none; stroke-width: 1.7; }
    .celnav-fundo { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 1200; display: flex; align-items: flex-end; }
    .celnav-sheet { background: var(--navy, #0D2B45); width: 100%; border-radius: 18px 18px 0 0; padding: 16px 16px 24px; border-top: 1px solid var(--border, rgba(255,255,255,.08)); }
    .celnav-tit { font-size: 12px; color: var(--text-secondary, #b7c3d0); margin: 0 8px 4px; }
    .celnav-sheet a { display: block; padding: 14px 8px; border-bottom: 1px solid var(--border, rgba(255,255,255,.08)); color: var(--white, #F4F1EA); font-size: 15px; text-decoration: none; }`;
  document.head.appendChild(s);
}

function montar() {
  if (document.getElementById('celNavGlobal')) return;
  estilos();
  const pag = location.pathname.split('/').pop() || 'index.html';
  const ativo = pag === 'index.html' ? 'inicio' : pag === 'reservas.html' ? 'metas' : 'mais';
  const nav = document.createElement('nav');
  nav.id = 'celNavGlobal';
  nav.innerHTML = `
    <a href="index.html?home=1" class="${ativo === 'inicio' ? 'ativo' : ''}">${ICONES.inicio}Início</a>
    <a href="orcamento.html">${ICONES.orcamento}Orçamento</a>
    <a href="reservas.html" class="${ativo === 'metas' ? 'ativo' : ''}">${ICONES.metas}Metas</a>
    <button type="button" class="${ativo === 'mais' ? 'ativo' : ''}">${ICONES.mais}Mais</button>`;
  nav.querySelector('button').addEventListener('click', () => abrirMais());
  document.body.appendChild(nav);
}

// Marca no aparelho que esta pessoa usa o modo celular: os scripts no <head>
// das telas leem isso para esconder a barra antiga e abrir direto no
// Orçamento, antes do login ser conferido (evita a home piscar).
export function marcarModoTeste(user = auth.currentUser) {
  if (!user || emVerComo()) return;
  try {
    if (ALLOWLIST.includes((user.email || '').toLowerCase())) localStorage.setItem('celModoTeste', '1');
    else localStorage.removeItem('celModoTeste');
  } catch (_) {}
}

function aplicar() {
  marcarModoTeste();
  const on = celNavAtivo();
  document.body.classList.toggle('cel-nav-global', on);
  if (on) montar();
  else document.getElementById('celNavGlobal')?.remove();
}

// orcamento.html tem a própria barra: este arquivo só monta nas outras telas.
if (!/orcamento\.html$/.test(location.pathname)) {
  onAuthStateChanged(auth, () => aplicar());
  mq.addEventListener?.('change', aplicar);
}
