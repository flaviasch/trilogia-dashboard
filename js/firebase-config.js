import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFunctions }   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

const firebaseConfig = {
  apiKey:            "AIzaSyCbgekmh90OPhr7DZJsVS-GXAYMOqtZ3Ds",
  authDomain:        "trilogia-dashboard.firebaseapp.com",
  projectId:         "trilogia-dashboard",
  storageBucket:     "trilogia-dashboard.firebasestorage.app",
  messagingSenderId: "175437497741",
  appId:             "1:175437497741:web:59aa773c374c4eceb429c4"
};

const app = initializeApp(firebaseConfig);

export const auth      = getAuth(app);
export const functions = getFunctions(app, 'southamerica-east1');

// Limpeza de dados locais no logout (auditoria de segurança 19/10/2026).
// Todas as páginas importam este módulo, então o gancho cobre qualquer caminho
// de signOut (botão, token expirado, conta PJ desativada). Remove cache de
// respostas financeiras, SMS bancário pendente e o "ver como" do admin.
const PREFIXOS_LOCAIS = ['dash_v1_', 'pcache_v1_'];
const CHAVES_LOCAIS   = ['sms_pendentes', 'viewAsUid', 'celModoTeste', 'temaNovoTeste'];
export function limparDadosLocais() {
  try {
    const remover = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (CHAVES_LOCAIS.includes(k) || PREFIXOS_LOCAIS.some(p => k.startsWith(p)))) remover.push(k);
    }
    remover.forEach(k => localStorage.removeItem(k));
  } catch (_) { /* armazenamento indisponível: nada a limpar */ }
}
onAuthStateChanged(auth, (user) => { if (!user) limparDadosLocais(); });

// Para desenvolvimento local com o emulador, descomente:
// import { connectAuthEmulator }      from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
// import { connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
// connectAuthEmulator(auth, 'http://localhost:9099');
// connectFunctionsEmulator(functions, 'localhost', 5001);
