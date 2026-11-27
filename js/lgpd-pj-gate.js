// Novo aceite da Política de Privacidade com IA no Dashboard PJ (27/11/2026).
// O modal de aceite PJ só existe em login-pj.html, que roda no login. Quem
// continua logada entra direto nas telas PJ e nunca passaria por ele. A partir
// de 12/12/2026, se a conta PJ não tem lgpdVersao = 2026-11-27, manda para o
// login-pj.html, que mostra o modal (sessão continua aberta, nada é apagado).
// Antes da vigência não faz nenhuma chamada. ?lgpdData=AAAA-MM-DD simula a data.
import { auth } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getContaPJ } from './api.js?v=90';
import { LGPD_VIGENCIA, lgpdHoje, precisaNovoAceiteLGPD } from './lgpd-versao.js?v=1';

const _paginaAtual = (window.location.pathname.split('/').pop() || '').toLowerCase();
const _ignorar = ['login-pj.html', 'onboarding-pj.html'].includes(_paginaAtual);

onAuthStateChanged(auth, async (user) => {
  if (!user || _ignorar) return;
  if (lgpdHoje() < LGPD_VIGENCIA) return;
  let viewAs = '', subUser = false;
  try {
    viewAs = new URLSearchParams(window.location.search).get('viewAs') || localStorage.getItem('viewAsUid') || '';
    subUser = !!localStorage.getItem('pjSubUserOwnerUid');
  } catch {}
  if (viewAs || subUser) return; // admin no "ver como" e usuário secundário não aceitam pela titular
  try {
    const conta = await getContaPJ(user.uid);
    if (conta && precisaNovoAceiteLGPD(conta.lgpdVersao)) {
      const q = new URLSearchParams(window.location.search).get('lgpdData');
      window.location.replace('login-pj.html' + (q ? `?lgpdData=${encodeURIComponent(q)}` : ''));
    }
  } catch { /* sem bloqueio se a leitura falhar */ }
});
