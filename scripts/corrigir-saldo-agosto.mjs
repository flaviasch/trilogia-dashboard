// corrigir-saldo-agosto.mjs
// Recalcula o saldoFinal REAL de julho/2026 (usando o mesmo modulo de calculo
// de producao, js/orcamento-calc.js, ja com os fixes de hoje) e corrige o
// valor congelado em saldosConta/2026-08 se estiver desatualizado.
'use strict';

globalThis.localStorage = (() => {
  let store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();

import admin from 'firebase-admin';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { calcularAgregadosOrcamento } from '../js/orcamento-calc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Mesma logica client-side de sugerirFatura/_ehCicloAberto, replicada aqui
// so pra simular o getOrcamento fixo sem chamar a Cloud Function via HTTP.
function sugerirFatura(dataCompra, diaCorte, diaVencimento) {
  const dia = parseInt(dataCompra.split('-')[2], 10);
  const d = new Date(dataCompra + 'T12:00:00');
  if (dia > diaCorte) d.setMonth(d.getMonth() + 1);
  if (!diaVencimento || diaVencimento <= diaCorte) d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function buscarOrcamentoComoBackend(uid, mes, ano, cartaoMap) {
  const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
  const prevMes = mes === 1 ? 12 : mes - 1;
  const prevAno = mes === 1 ? ano - 1 : ano;
  const prevKey = `${prevAno}-${String(prevMes).padStart(2, '0')}`;
  const nextMes = mes === 12 ? 1 : mes + 1;
  const nextAno = mes === 12 ? ano + 1 : ano;
  const nextKey = `${nextAno}-${String(nextMes).padStart(2, '0')}`;

  const col = db.collection('mentoradas').doc(uid).collection('orcamento');
  const [docSnap, prevSnap, nextSnap] = await Promise.all([col.doc(mesKey).get(), col.doc(prevKey).get(), col.doc(nextKey).get()]);

  const hojeStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const _abertaKeyPorCartao = {};
  function ehCicloAberto(item) {
    if (!item.cartao || !item.fatura || !item.cartaoId) return false;
    const c = cartaoMap[item.cartaoId];
    if (!c?.diaCorte) return false;
    if (!(item.cartaoId in _abertaKeyPorCartao)) _abertaKeyPorCartao[item.cartaoId] = sugerirFatura(hojeStr, c.diaCorte, c.diaVencimento || 1);
    return item.fatura === _abertaKeyPorCartao[item.cartaoId];
  }

  const todosItensMes = docSnap.exists ? (docSnap.data().itens || []) : [];
  const itensFaturaAberta = todosItensMes.filter(ehCicloAberto).map(i => ({ ...i, _faturaAberta: true }));
  const itensMes = todosItensMes.filter(i => !ehCicloAberto(i));
  const itensPrev = (prevSnap.exists ? prevSnap.data().itens || [] : [])
    .filter(i => i.cartao && i.fatura === mesKey)
    .map(i => ({ ...i, _sourceMes: prevMes, _sourceAno: prevAno, ...(ehCicloAberto(i) ? { _faturaAberta: true } : {}) }));
  const itensNext = (nextSnap.exists ? nextSnap.data().itens || [] : [])
    .filter(i => i.cartao && i.fatura === nextKey && !ehCicloAberto(i))
    .map(i => ({ ...i, _sourceMes: nextMes, _sourceAno: nextAno }));

  return [...itensMes, ...itensPrev, ...itensNext, ...itensFaturaAberta];
}

async function main() {
  const email = 'flaviasch@gmail.com';
  const user = await admin.auth().getUserByEmail(email);
  const uid = user.uid;

  const cartoesSnap = await db.collection('mentoradas').doc(uid).collection('cartoes').get();
  const cartaoMap = {};
  cartoesSnap.forEach(d => cartaoMap[d.id] = d.data());
  const cartoes = cartoesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const faturaEstadosSnap = await db.collection('mentoradas').doc(uid).collection('faturaEstados').get();
  const faturaEstados = {};
  faturaEstadosSnap.forEach(d => faturaEstados[d.id] = d.data());

  const recorrentesSnap = await db.collection('mentoradas').doc(uid).collection('recorrentes').get();
  const recorrentes = recorrentesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const contaDoc = await db.collection('mentoradas').doc(uid).get();
  const fixasPuladas = contaDoc.data().fixasPuladas || [];

  const itensJulho = await buscarOrcamentoComoBackend(uid, 7, 2026, cartaoMap);
  const saldoItem = itensJulho.find(i => i.tipo === 'receita' && i.categoria === '__saldo_conta__');
  const data = {
    periodo: { mes: 7, ano: 2026 },
    saldoConta: saldoItem ? saldoItem.valor : 0,
    receitas: itensJulho.filter(i => i.tipo === 'receita' && i.categoria !== '__saldo_conta__'),
    despesas: itensJulho.filter(i => i.tipo === 'despesa'),
    aportes: itensJulho.filter(i => i.tipo === 'aporte'),
    transferencias: itensJulho.filter(i => i.tipo === 'transferencia'),
  };

  // Saldo de abertura de julho: o que ja estiver congelado em saldosConta/2026-07
  const saldosJulhoSnap = await db.collection('mentoradas').doc(uid).collection('saldosConta').doc('2026-07').get();
  const saldoAberturaJulho = saldosJulhoSnap.exists ? (saldosJulhoSnap.data().saldos?.principal ?? 0) : 0;
  data.saldoConta = saldoAberturaJulho;

  const agregados = calcularAgregadosOrcamento({
    data, cartoes, faturaEstados, recorrentes, fixasPuladas, contaId: 'principal',
  });

  console.log('Saldo de abertura de julho (congelado):', saldoAberturaJulho);
  console.log('Saldo final de julho RECALCULADO (com os fixes de hoje):', agregados.saldoFinal);

  const saldosAgostoRef = db.collection('mentoradas').doc(uid).collection('saldosConta').doc('2026-08');
  const saldosAgostoSnap = await saldosAgostoRef.get();
  const atual = saldosAgostoSnap.exists ? saldosAgostoSnap.data().saldos?.principal : undefined;
  console.log('Saldo de abertura de agosto ATUAL (congelado):', atual);

  if (Math.abs((atual ?? 0) - agregados.saldoFinal) < 0.01) {
    console.log('Já está correto, nada a fazer.');
  } else {
    await saldosAgostoRef.set({ saldos: { ...(saldosAgostoSnap.data()?.saldos || {}), principal: agregados.saldoFinal } }, { merge: true });
    console.log(`✅ Corrigido: saldo de abertura de agosto atualizado de ${atual} para ${agregados.saldoFinal}`);
  }

  process.exit(0);
}

main().catch(err => { console.error('Erro:', err); process.exit(1); });
