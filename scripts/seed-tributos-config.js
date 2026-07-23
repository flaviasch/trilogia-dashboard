'use strict';
/**
 * seed-tributos-config.js
 * Cadastra os 5 tributos recorrentes (Lucro Presumido, Serviços) na
 * coleção tributosConfig, com as aliquotas efetivas confirmadas por Flavia:
 *   IRPJ 4,80% | CSLL 2,88% | PIS 0,65% | COFINS 3,00% | ISS-SP 5,00%
 *
 * Periodicidade (achado 23/07/2026, separacao pedida pela Flavia):
 * - ISS/PIS/COFINS: 'mensal' de verdade -- 1 provisao por competencia,
 *   vencimento no mes seguinte.
 * - IRPJ/CSLL: 'trimestral' -- Lucro Presumido apura e paga por TRIMESTRE,
 *   nao por mes. Continuam gerando a linha mensal de referencia (mesmo
 *   calculo de sempre, sobre a nota do mes) E, alem dela, uma linha extra
 *   de provisao trimestral que soma as notas dos 3 meses do trimestre, com
 *   vencimento automatico no ultimo dia util do mes seguinte ao trimestre
 *   (ver _regerarProvisaoTrimestral em functions/index.js).
 *
 * IMPORTANTE (limitacoes conhecidas, nao automatizadas):
 * - "Ultimo dia util" so considera fins de semana, nao feriados nacionais/
 *   municipais -- confere a data quando o vencimento cair perto de feriado.
 * - Adicional de IRPJ (10% sobre base que exceder R$60mil/trimestre) NAO
 *   esta incluido - so relevante se o faturamento trimestral for alto.
 * - "Taxa de Fiscalizacao de Estabelecimentos" NAO foi incluida aqui por
 *   nao ter o valor fixo anual confirmado - cadastre manualmente pela tela
 *   "Configurar tributos" quando tiver o boleto em maos.
 *
 * Uso: node seed-tributos-config.js
 * (precisa do scripts/serviceAccountKey.json, mesmo usado pelos outros
 * scripts de admin do projeto)
 */

const admin = require('firebase-admin');
const path  = require('path');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

const TRIBUTOS = [
  { nome: 'DAM ISS (São Paulo)', tipo: 'percentual', percentual: 5.00, diaVencimento: 10, defasagemMeses: 1, periodicidade: 'mensal', ordem: 0 },
  { nome: 'DARF PIS',            tipo: 'percentual', percentual: 0.65, diaVencimento: 25, defasagemMeses: 1, periodicidade: 'mensal', ordem: 1 },
  { nome: 'DARF COFINS',         tipo: 'percentual', percentual: 3.00, diaVencimento: 25, defasagemMeses: 1, periodicidade: 'mensal', ordem: 2 },
  { nome: 'DARF IRPJ (Lucro Presumido)', nomesAntigos: ['DARF IRPJ (provisão mensal, Lucro Presumido)'], tipo: 'percentual', percentual: 4.80, diaVencimento: 28, defasagemMeses: 1, periodicidade: 'trimestral', ordem: 3 },
  { nome: 'DARF CSLL (Lucro Presumido)', nomesAntigos: ['DARF CSLL (provisão mensal, Lucro Presumido)'], tipo: 'percentual', percentual: 2.88, diaVencimento: 28, defasagemMeses: 1, periodicidade: 'trimestral', ordem: 4 },
];

async function main() {
  const col = db.collection('tributosConfig');

  const existentesSnap = await col.get();
  const existentesPorNome = new Map(existentesSnap.docs.map(d => [d.data().nome, d.id]));

  const batch = db.batch();
  let novos = 0, atualizados = 0;

  for (const trib of TRIBUTOS) {
    const dados = {
      nome: trib.nome,
      tipo: trib.tipo,
      percentual: trib.percentual,
      valorFixo: null,
      diaVencimento: trib.diaVencimento,
      defasagemMeses: trib.defasagemMeses,
      periodicidade: trib.periodicidade,
      ativo: true,
      ordem: trib.ordem,
    };
    // Tenta pelo nome atual e, se não achar (ex: renomeado nesta versão do
    // script), tenta pelos nomes antigos — evita duplicar o tributo em vez
    // de atualizar o existente.
    const idExistente = existentesPorNome.get(trib.nome)
      ?? (trib.nomesAntigos || []).map(n => existentesPorNome.get(n)).find(Boolean);
    if (idExistente) {
      batch.set(col.doc(idExistente), dados, { merge: true });
      atualizados++;
    } else {
      batch.set(col.doc(), dados);
      novos++;
    }
  }

  await batch.commit();
  console.log(`✅ Concluído: ${novos} tributo(s) criado(s), ${atualizados} atualizado(s).`);
  console.log('Lembrete: "Taxa de Fiscalização de Estabelecimentos" não foi cadastrada — adicione manualmente pela tela quando tiver o valor.');
  process.exit(0);
}

main().catch(err => { console.error('❌ Erro:', err); process.exit(1); });
