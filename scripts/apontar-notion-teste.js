/**
 * apontar-notion-teste.js
 * Script Node.js de uso único para fazer a Conta Teste Smoke "pegar emprestado"
 * a página do Notion de uma mentorada real, só pra você ver como a Jornada fica
 * com dados de verdade (a conta de teste não tem encontro nenhum no Notion).
 *
 * Não altera nada da mentorada real — só escreve o campo `notionPageId` no
 * documento da CONTA DE TESTE, fazendo ela ler (read-only) a mesma página.
 *
 * COMO USAR:
 *   1. Precisa do mesmo scripts/serviceAccountKey.json que o smoke-test.js já usa.
 *   2. Ache o notionPageId da mentorada real: mais fácil é abrir a página dela no
 *      Notion e copiar o ID de 32 caracteres (com ou sem hífens) do final da URL.
 *   3. Rode:
 *      node apontar-notion-teste.js <notionPageId>
 *
 *      Pra reverter depois (volta a conta de teste a não ter Jornada nenhuma):
 *      node apontar-notion-teste.js --limpar
 *
 * IMPORTANTE: reverta depois de testar (rode --limpar). Deixar apontado pra
 * sempre significa que quem logar na Conta Teste Smoke continua vendo o
 * histórico de encontros de uma mentorada real.
 */

'use strict';

require('dotenv').config();
const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

const keyPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(keyPath)) {
  console.error('\n❌ Arquivo não encontrado: scripts/serviceAccountKey.json');
  console.error('   Baixe em: Firebase Console → Configurações → Contas de serviço\n');
  process.exit(1);
}

const SMOKE_TEST_UID = process.env.SMOKE_TEST_UID;
if (!SMOKE_TEST_UID) {
  console.error('\n❌ Falta SMOKE_TEST_UID em scripts/.env (mesmo usado pelo smoke-test.js).\n');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
const db = admin.firestore();

const args    = process.argv.slice(2);
const limpar  = args.includes('--limpar');
const pageIdBruto = args.find(a => !a.startsWith('--'));

async function main() {
  const ref = db.collection('mentoradas').doc(SMOKE_TEST_UID);

  if (limpar) {
    await ref.update({ notionPageId: null });
    console.log('\n✅ Conta Teste Smoke voltou a não ter Jornada nenhuma (notionPageId limpo).\n');
    process.exit(0);
  }

  if (!pageIdBruto) {
    console.error('\nUso: node apontar-notion-teste.js <notionPageId>');
    console.error('     node apontar-notion-teste.js --limpar\n');
    process.exit(1);
  }

  // Aceita ID com ou sem hífens, ou colado direto da URL do Notion
  const pageId = pageIdBruto.replace(/-/g, '').match(/[0-9a-f]{32}/i)?.[0];
  if (!pageId) {
    console.error('\n❌ Não reconheci um ID de página do Notion nesse argumento.\n');
    process.exit(1);
  }
  const pageIdFormatado = `${pageId.slice(0,8)}-${pageId.slice(8,12)}-${pageId.slice(12,16)}-${pageId.slice(16,20)}-${pageId.slice(20)}`;

  await ref.update({ notionPageId: pageIdFormatado });
  console.log(`\n✅ Conta Teste Smoke agora lê a página: ${pageIdFormatado}`);
  console.log('   Logue com a conta de teste em "Minha Jornada" pra ver.');
  console.log('\n⚠️  Lembre de reverter depois: node apontar-notion-teste.js --limpar\n');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Erro inesperado:', err.message, '\n');
  process.exit(1);
});
