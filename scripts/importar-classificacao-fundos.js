'use strict';
/**
 * importar-classificacao-fundos.js
 *
 * Importa/atualiza a coleção `classificacaoOficialFundos` (Firestore) a partir
 * de um JSON com a classificação oficial (CVM + Anbima) de fundos por CNPJ —
 * hoje extraído da planilha "Guia-Previdência.xlsm" (aba "Prev Mercado",
 * dados de mercado da XP), fonte da Flávia como assessora.
 *
 * Achado 12/08/2026: a IA de categorização de patrimônio (categorizarPatrimonioIA)
 * erra fundos reais (ex: Kinea IPCA Dinâmico saiu como "Multimercado" quando o
 * registro oficial CVM/Anbima diz "Renda Fixa"). Em vez de depender só do
 * "conhecimento" da IA sobre cada gestora, cruza com essa base oficial por
 * CNPJ quando disponível no documento importado.
 *
 * Essa base é hoje uma EXPORTAÇÃO manual (não uma API viva) — precisa ser
 * reimportada de tempos em tempos conforme a Flávia atualizar a planilha.
 * Fica em scripts/dados/classificacao-fundos-prev.json (gerado à parte, fora
 * deste script, a partir do Excel — ver histórico do projeto).
 *
 * Uso:
 *   node importar-classificacao-fundos.js [caminho-do-json]
 *   (default: dados/classificacao-fundos-prev.json)
 *
 * (precisa do scripts/serviceAccountKey.json, mesmo usado pelos outros
 * scripts de admin do projeto)
 */

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const CAMINHO_JSON = process.argv[2] || path.join(__dirname, 'dados', 'classificacao-fundos-prev.json');

async function main() {
  if (!fs.existsSync(CAMINHO_JSON)) {
    console.error(`Arquivo não encontrado: ${CAMINHO_JSON}`);
    process.exit(1);
  }
  const dados = JSON.parse(fs.readFileSync(CAMINHO_JSON, 'utf-8'));
  const cnpjs = Object.keys(dados);
  console.log(`${cnpjs.length} fundos no arquivo. Gravando em lotes de 400...`);

  const col = db.collection('classificacaoOficialFundos');
  const agora = admin.firestore.FieldValue.serverTimestamp();
  let gravados = 0;

  for (let i = 0; i < cnpjs.length; i += 400) {
    const lote = cnpjs.slice(i, i + 400);
    const batch = db.batch();
    lote.forEach(cnpj => {
      const item = dados[cnpj];
      batch.set(col.doc(cnpj), {
        nome: item.nome || '',
        gestora: item.gestora || '',
        classeCvm: item.classeCvm || '',
        classeAnbima: item.classeAnbima || '',
        atualizadoEm: agora,
      });
    });
    await batch.commit();
    gravados += lote.length;
    console.log(`  ${gravados}/${cnpjs.length}`);
  }

  console.log(`\n✅ ${gravados} fundos gravados em classificacaoOficialFundos.`);
  process.exit(0);
}

main().catch(err => { console.error('❌ Erro:', err); process.exit(1); });
