'use strict';
/**
 * faxina-eventos-achatados.js
 *
 * Item 5.4, Bloco 3 (opcional) — limpeza dos campos achatados antigos
 * "eventos.<nome>" que o registrarEvento gravava antes do fix de 08/09/2026
 * (achado: set()+merge trata chave com ponto literalmente, então o doc
 * ganhava campos de topo tipo "eventos.aporte_registrado" em vez de um mapa
 * eventos:{}). getAnalytics já soma os dois formatos na leitura — esta
 * faxina é só arrumação, sem urgência, sem efeito visível pra ninguém.
 *
 * O que faz, por doc em mentoradas/{uid}/analytics/{geral|YYYY-MM}:
 *   1. Faz backup local (JSON) de TODOS os docs lidos, antes de qualquer escrita.
 *   2. Pra quem tem campo achatado "eventos.<nome>": soma esse valor ao mapa
 *      eventos:{} (mesma lógica de _normalizarAnalytics do functions/index.js)
 *      e regrava o doc só com o mapa aninhado — os campos achatados somem.
 *   3. Idempotente: doc sem campo achatado é ignorado (nada a fazer).
 *
 * Modo padrão = DRY RUN (só mostra o que faria, não escreve nada).
 * Uso:
 *   node faxina-eventos-achatados.js            → dry run
 *   node faxina-eventos-achatados.js --apply     → aplica de verdade
 * (precisa do scripts/serviceAccountKey.json, mesmo usado pelos outros
 * scripts de admin do projeto)
 */

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const APLICAR = process.argv.includes('--apply');

// Idêntica a _normalizarAnalytics em functions/index.js — mesma regra usada
// hoje em produção pra ler os dois formatos, só que aqui grava o resultado.
function normalizarAnalytics(data) {
  if (!data) return data;
  const eventos = { ...(data.eventos && typeof data.eventos === 'object' ? data.eventos : {}) };
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'eventos') continue;
    if (k.startsWith('eventos.') && typeof v === 'number') {
      const nome = k.slice(8);
      eventos[nome] = (eventos[nome] || 0) + v;
    } else {
      out[k] = v;
    }
  }
  out.eventos = eventos;
  return out;
}

function temCampoAchatado(data) {
  return Object.keys(data || {}).some(k => k.startsWith('eventos.'));
}

async function main() {
  console.log(APLICAR ? '=== MODO APLICAR (vai escrever no Firestore) ===' : '=== MODO DRY RUN (só mostra, não escreve nada) ===');

  const mentoradasSnap = await db.collection('mentoradas').get();
  console.log(`mentoradas: ${mentoradasSnap.size} documento(s)`);

  const backup = []; // todo doc lido, pra restaurar se precisar
  const paraMigrar = []; // { ref, uid, docId, antes, depois }

  for (const mDoc of mentoradasSnap.docs) {
    const uid = mDoc.id;
    const analyticsSnap = await db.collection('mentoradas').doc(uid).collection('analytics').get();
    for (const aDoc of analyticsSnap.docs) {
      const data = aDoc.data();
      backup.push({ uid, docId: aDoc.id, data });
      if (temCampoAchatado(data)) {
        paraMigrar.push({ ref: aDoc.ref, uid, docId: aDoc.id, antes: data, depois: normalizarAnalytics(data) });
      }
    }
  }

  // Backup sempre, mesmo em dry run — barato e documenta o estado real.
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const arquivoBackup = path.join(__dirname, `backup-analytics-${timestamp}.json`);
  fs.writeFileSync(arquivoBackup, JSON.stringify(backup, null, 2));
  console.log(`Backup salvo em: ${arquivoBackup} (${backup.length} doc(s) de analytics)`);

  if (paraMigrar.length === 0) {
    console.log('Nenhum doc com campo achatado "eventos.<nome>" — nada a fazer. Faxina já está limpa.');
    return;
  }

  console.log(`\n${paraMigrar.length} doc(s) com campo achatado, de ${new Set(paraMigrar.map(m => m.uid)).size} mentorada(s) diferente(s):\n`);
  for (const m of paraMigrar) {
    const achatados = Object.keys(m.antes).filter(k => k.startsWith('eventos.'));
    console.log(`  mentoradas/${m.uid}/analytics/${m.docId} — ${achatados.length} campo(s) achatado(s): ${achatados.join(', ')}`);
    console.log(`    eventos (depois da faxina): ${JSON.stringify(m.depois.eventos)}`);
  }

  if (!APLICAR) {
    console.log('\nDry run — nada foi escrito. Rode com --apply pra aplicar de verdade.');
    return;
  }

  console.log('\nAplicando...');
  let ok = 0;
  for (const m of paraMigrar) {
    await m.ref.set(m.depois); // overwrite completo — já contém tudo, sem os campos achatados
    ok++;
  }
  console.log(`Pronto: ${ok} doc(s) migrado(s). Backup de segurança em ${arquivoBackup}.`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
