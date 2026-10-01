/**
 * smoke-test.js
 * Teste de fumaça pós-deploy — chama as 5 funções mais críticas do Dashboard
 * (getDashboardHome, getOrcamento, saveOrcamento, getReservas, getPatrimonio)
 * usando uma conta de teste dedicada, e avisa por e-mail (via Cloud Function
 * smokeTestAlerta → alertarErro) se alguma delas falhar.
 *
 * Substitui a verificação manual de "abrir em aba anônima e testar login"
 * depois de cada deploy.
 *
 * COMO USAR (configuração, uma vez só):
 *
 *   1. Baixe a chave de serviço do Firebase Console, se ainda não tiver:
 *      Configurações do projeto → Contas de serviço → Gerar nova chave privada
 *      Salve como "serviceAccountKey.json" nesta pasta (scripts/) — já está
 *      no .gitignore, não sobe ao Git. Mesmo arquivo que set-admin-claim.js
 *      já usa, pode reaproveitar o mesmo.
 *
 *   2. Tenha uma conta de teste dedicada no Dashboard (NUNCA usar conta de
 *      mentorada real). Se ainda não tiver, cria pelo admin.html normalmente
 *      (ex: nome "Conta Teste Smoke") e pega o UID dela no Firebase Console
 *      → Authentication, ou na aba Mentoradas do admin.html.
 *
 *   3. Copia scripts/.env.example para scripts/.env e preenche:
 *      SMOKE_TEST_UID=<uid da conta de teste>
 *      SMOKE_TEST_TOKEN=<mesmo valor do secret SMOKE_TEST_TOKEN no Firebase>
 *      (gera o token com: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
 *      e salva com: firebase functions:secrets:set SMOKE_TEST_TOKEN)
 *
 *   4. Instala as dependências (uma vez):
 *      npm install
 *
 * COMO RODAR (depois de cada deploy):
 *      node smoke-test.js
 *
 * O script nunca toca em dado de mentorada real — saveOrcamento é testado
 * contra um mês fictício (janeiro/2099) que nunca aparece pra ninguém, e usa
 * permitirReducao pra não travar em reruns.
 *
 * Autenticação: usa firebase-admin (serviceAccountKey.json) só pra gerar um
 * custom token pra conta de teste — nenhuma senha de usuária fica salva em
 * lugar nenhum, nem local nem no código.
 */

'use strict';

require('dotenv').config();
const path  = require('path');
const fs    = require('fs');
const admin = require('firebase-admin');
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithCustomToken } = require('firebase/auth');
const { getFunctions, httpsCallable }    = require('firebase/functions');

// ─── Config ────────────────────────────────────────────────────────────────

const SMOKE_TEST_UID   = process.env.SMOKE_TEST_UID;
const SMOKE_TEST_TOKEN = process.env.SMOKE_TEST_TOKEN;
const ALERT_URL = 'https://southamerica-east1-trilogia-dashboard.cloudfunctions.net/smokeTestAlerta';

if (!SMOKE_TEST_UID || !SMOKE_TEST_TOKEN) {
  console.error('\n❌ Faltam variáveis em scripts/.env: SMOKE_TEST_UID e/ou SMOKE_TEST_TOKEN.');
  console.error('   Copia scripts/.env.example pra scripts/.env e preenche.\n');
  process.exit(1);
}

const keyPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(keyPath)) {
  console.error('\n❌ Arquivo não encontrado: scripts/serviceAccountKey.json');
  console.error('   Baixe em: Firebase Console → Configurações → Contas de serviço\n');
  process.exit(1);
}

// Config pública do Firebase Web SDK (mesma do dashboard/js/firebase-config.js
// — é a apiKey do app web, não é secreta, identifica só o projeto).
const firebaseConfig = {
  apiKey:            'AIzaSyCbgekmh90OPhr7DZJsVS-GXAYMOqtZ3Ds',
  authDomain:        'trilogia-dashboard.firebaseapp.com',
  projectId:         'trilogia-dashboard',
  storageBucket:     'trilogia-dashboard.firebasestorage.app',
  messagingSenderId: '175437497741',
  appId:             '1:175437497741:web:59aa773c374c4eceb429c4',
};

// ─── Inicialização ─────────────────────────────────────────────────────────

admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });

const clientApp  = initializeApp(firebaseConfig);
const clientAuth = getAuth(clientApp);
const functions  = getFunctions(clientApp, 'southamerica-east1');

// Mês/ano fictício — nunca colide com lançamento real de ninguém.
const MES_TESTE  = 1;
const ANO_TESTE  = 2099;
const ITEM_TESTE = [{ categoria: 'Smoke Test', tipo: 'despesa', valor: 1, origem: 'manual' }];

// ─── Execução dos testes ───────────────────────────────────────────────────

async function rodarTeste(nome, fn) {
  try {
    await fn();
    console.log(`✅ ${nome}`);
    return { funcao: nome, ok: true };
  } catch (err) {
    console.error(`❌ ${nome}: ${err.message}`);
    return { funcao: nome, ok: false, erro: err.message };
  }
}

async function main() {
  console.log(`\n🔥 Smoke test — ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n`);

  // Autentica como a conta de teste via custom token — sem senha em lugar nenhum.
  const customToken = await admin.auth().createCustomToken(SMOKE_TEST_UID);
  await signInWithCustomToken(clientAuth, customToken);
  console.log(`Autenticado como conta de teste (${SMOKE_TEST_UID}).\n`);

  const chamar = (nomeFuncao, dados) => httpsCallable(functions, nomeFuncao)(dados);

  const resultados = [];
  resultados.push(await rodarTeste('getDashboardHome', () =>
    chamar('getDashboardHome', { uid: SMOKE_TEST_UID })));
  resultados.push(await rodarTeste('getOrcamento', () =>
    chamar('getOrcamento', { uid: SMOKE_TEST_UID, mes: MES_TESTE, ano: ANO_TESTE })));
  resultados.push(await rodarTeste('saveOrcamento', () =>
    chamar('saveOrcamento', { uid: SMOKE_TEST_UID, mes: MES_TESTE, ano: ANO_TESTE, itens: ITEM_TESTE, permitirReducao: true })));
  resultados.push(await rodarTeste('getReservas', () =>
    chamar('getReservas', { uid: SMOKE_TEST_UID })));
  resultados.push(await rodarTeste('getPatrimonio', () =>
    chamar('getPatrimonio', { uid: SMOKE_TEST_UID })));

  const ok = resultados.every(r => r.ok);
  console.log(`\n${ok ? '✅ Tudo passou.' : '❌ Alguma função falhou — avisando por e-mail.'}\n`);

  try {
    await fetch(ALERT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Smoke-Test-Token': SMOKE_TEST_TOKEN },
      body:    JSON.stringify({ token: SMOKE_TEST_TOKEN, ok, resultados }),
    });
  } catch (err) {
    console.error('⚠️  Não consegui avisar a Cloud Function (mas o teste rodou):', err.message);
  }

  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error('\n❌ Erro inesperado no smoke test:', err.message, '\n');
  process.exit(1);
});
