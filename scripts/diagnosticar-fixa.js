'use strict';
/**
 * diagnosticar-fixa.js
 * Só LEITURA — investiga por que uma despesa/receita fixa não aparece como
 * pendente/virtual num mês específico. Cobre as 3 causas mais prováveis:
 *   1. recorrente inativa (ou mesesRestantes zerou)
 *   2. mesInicio/anoInicio bloqueando o mês em questão
 *   3. o dia já está marcado como "pulado" (fixasPuladas) pra esse mês
 *   4. já existe um lançamento real pra esse dia (materializado ou importado)
 *
 * Uso: node diagnosticar-fixa.js [email] "<termo de busca>" [mes] [ano]
 * Ex:  node diagnosticar-fixa.js flaviasch@gmail.com "social media" 9 2026
 */

const admin = require('firebase-admin');
const path  = require('path');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function diasEsperadosRecorrente(r, mes, ano) {
  if (r.anoInicio != null && r.mesInicio != null) {
    const antesDoInicio = ano < r.anoInicio || (ano === r.anoInicio && mes < r.mesInicio);
    if (antesDoInicio) return [];
  }
  const freq = r.frequencia || 'mensal';
  if (freq === 'semanal') {
    const dias = [];
    const total = new Date(ano, mes, 0).getDate();
    for (let d = 1; d <= total; d++) if (new Date(ano, mes - 1, d).getDay() === r.dia) dias.push(d);
    return dias;
  }
  if (freq === 'quinzenal') return [r.dia, r.dia + 14].filter(d => d >= 1 && d <= 31);
  return [r.dia];
}

async function main() {
  const email  = process.argv[2] || 'flaviasch@gmail.com';
  const termo  = (process.argv[3] || '').toLowerCase();
  const agora  = new Date();
  const mes    = Number(process.argv[4]) || (agora.getMonth() + 1);
  const ano    = Number(process.argv[5]) || agora.getFullYear();
  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;

  if (!termo) { console.log('Informe um termo de busca (categoria ou descrição). Ex: node diagnosticar-fixa.js flaviasch@gmail.com "social media" 9 2026'); process.exit(1); }

  const user = await admin.auth().getUserByEmail(email);
  const uid = user.uid;
  console.log(`UID: ${uid} — buscando "${termo}" — mês alvo ${mesKey}\n`);

  const recSnap = await db.collection('mentoradas').doc(uid).collection('recorrentes').get();
  const recs = recSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(r => (r.descricao || '').toLowerCase().includes(termo) || (r.categoria || '').toLowerCase().includes(termo));

  if (!recs.length) { console.log('Nenhuma recorrente encontrada com esse termo.'); process.exit(0); }

  const mentSnap = await db.collection('mentoradas').doc(uid).get();
  const fixasPuladas = mentSnap.exists ? (mentSnap.data().fixasPuladas || []) : [];

  const orcSnap = await db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKey).get();
  const itensMes = orcSnap.exists ? (orcSnap.data().itens || []) : [];

  for (const r of recs) {
    console.log(`\n=== Recorrente "${r.descricao || r.categoria}" (id ${r.id}) ===`);
    console.log(`tipo=${r.tipo || 'despesa'} ativo=${!!r.ativo} cartao=${!!r.cartao} frequencia=${r.frequencia || 'mensal'} dia=${r.dia}`);
    console.log(`mesInicio/anoInicio=${r.mesInicio ?? '-'}/${r.anoInicio ?? '-'} mesesRestantes=${r.mesesRestantes ?? '(sem limite)'}`);

    if (!r.ativo) { console.log('>>> CAUSA: recorrente está INATIVA. Não gera projeção em nenhum mês.'); continue; }
    if (r.cartao) { console.log('>>> É de cartão — não entra na projeção de "Saldo Projetado"/Detalhe (lança junto com a fatura).'); continue; }

    const dias = diasEsperadosRecorrente(r, mes, ano);
    if (!dias.length) { console.log(`>>> CAUSA: diasEsperadosRecorrente retornou vazio pro mês ${mesKey} — provavelmente mesInicio/anoInicio bloqueando (recorrente só começa depois desse mês).`); continue; }
    console.log(`Dias esperados em ${mesKey}: ${dias.join(', ')}`);

    for (const dia of dias) {
      const chave = `${r.id}_${mesKey}-${String(dia).padStart(2, '0')}`;
      const pulada = fixasPuladas.includes(chave);
      const ocupado = itensMes.find(i => i.recorrenteId === r.id
        ? parseInt((i.data || '').split('-')[2], 10) === dia
        : (!i.recorrenteId && i.categoria === r.categoria && parseInt((i.data || '').split('-')[2], 10) === dia));

      console.log(`  dia ${dia}: chavePulada="${chave}" pulada=${pulada} | já lançado=${!!ocupado}${ocupado ? ` (confirmado=${!!ocupado.confirmado} pendente=${!!ocupado.pendente} recorrenteId=${ocupado.recorrenteId || '(sem vínculo — bateu só por categoria+dia)'})` : ''}`);
      if (pulada) console.log('  >>> CAUSA: esse dia está marcado como "pulado" — por isso não aparece como virtual/pendente. Use "+ Adicionar" manual se quiser lançar mesmo assim, ou remova a chave da lista fixasPuladas.');
      if (ocupado && !pulada) console.log('  >>> Já existe lançamento pra esse dia — não deveria aparecer como virtual mesmo (é o comportamento esperado, já foi tratado).');
      if (!pulada && !ocupado) console.log('  >>> Nada bloqueando — deveria estar aparecendo como virtual (✓ Lançar / ⏭ Pular) no Saldo Projetado/Detalhe desse mês. Se não está, pode ser cache do navegador — testa um hard refresh.');
    }
  }

  process.exit(0);
}

main().catch(err => { console.error('Erro:', err.message); process.exit(1); });
