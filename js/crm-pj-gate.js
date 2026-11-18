// Link "CRM" no menu do Dashboard PJ (18/11/2026). Fica escondido e só
// aparece para as contas do teste (mesma lista de CRM_PJ_UIDS_TESTE em
// functions/index.js). Quando a Flávia liberar para todas, apagar a lista
// aqui e na função e deixar o link visível no HTML.
import { auth } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

export const CRM_PJ_UIDS_TESTE = [
  'SmbehlGYm5gmB2S5J2iZrTsPuqD2', // Lica Cukier
  'zHqnrTmtbsPJMis66kf4pplH3cl2', // Flávia (master)
  'j4HCspHe6oTNaGdP4DWh6LMEhCz1', // Flavia (teste)
  'tqrwd6BpreXKBJhNtKtjGEaBq712', // Luiza (teste)
];

function _viewAs() {
  try {
    return new URLSearchParams(window.location.search).get('viewAs') || localStorage.getItem('viewAsUid') || '';
  } catch { return ''; }
}

export function crmPJLiberado(uidAlvo) {
  return CRM_PJ_UIDS_TESTE.includes(uidAlvo);
}

onAuthStateChanged(auth, (user) => {
  const link = document.getElementById('navCrm');
  if (!link || !user) return;
  let subUser = false;
  try { subUser = !!localStorage.getItem('pjSubUserOwnerUid'); } catch {}
  if (subUser) return; // usuário secundário só vê Contas a Receber
  const viewAs = _viewAs();
  const alvo = viewAs || user.uid;
  if (!crmPJLiberado(alvo)) return;
  link.href = 'crm-pj.html' + (viewAs ? `?viewAs=${encodeURIComponent(viewAs)}` : '');
  link.style.display = '';
});
