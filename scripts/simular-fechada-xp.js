'use strict';
// Só LEITURA — simula getOrcamento + a lógica de Faturas Fechadas do
// frontend pra descobrir por que a fatura paga da XP (jul/2026, R$9.458)
// sumiu da aba Fechadas depois do fix da duplicação Aberta/Fechada.
const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function _sugerirFatura(dataCompra, diaCorte, diaVencimento) {
  const [anoStr, mesStr, diaStr] = dataCompra.split('-');
  let ano = parseInt(anoStr, 10);
  let mes = parseInt(mesStr, 10);
  const dia = parseInt(diaStr, 10);
  const avancarMes = () => { mes += 1; if (mes > 12) { mes = 1; ano += 1; } };
  if (dia > diaCorte) avancarMes();
  if (!diaVencimento || diaVencimento <= diaCorte) avancarMes();
  return `${ano}-${String(mes).padStart(2, '0')}`;
}

async function main() {
  const email = process.argv[2] || 'flaviasch@gmail.com';
  const hojeStr = '2026-08-02';
  const user = await admin.auth().getUserByEmail(email);
  const uid = user.uid;

  const cartoesSnap = await db.collection('mentoradas').doc(uid).collection('cartoes').get();
  const cartaoMap = {};
  cartoesSnap.forEach(d => { cartaoMap[d.id] = d.data(); });

  const faturaEstadosSnap = await db.collection('mentoradas').doc(uid).collection('faturaEstados').get();
  const faturaEstados = {};
  faturaEstadosSnap.forEach(d => { faturaEstados[d.id] = d.data(); });

  const orcRef = db.collection('mentoradas').doc(uid).collection('orcamento');
  const docsCache = {};
  async function getDoc(key) {
    if (!(key in docsCache)) {
      const snap = await orcRef.doc(key).get();
      docsCache[key] = snap.exists ? snap.data() : null;
    }
    return docsCache[key];
  }

  const _abertaKeyPorCartao = {};
  const _ehCicloAberto = item => {
    if (!item.cartao || !item.fatura || !item.cartaoId) return false;
    const c = cartaoMap[item.cartaoId];
    if (!c?.diaCorte) return false;
    if (!(item.cartaoId in _abertaKeyPorCartao)) {
      _abertaKeyPorCartao[item.cartaoId] = _sugerirFatura(hojeStr, c.diaCorte, c.diaVencimento || 1);
    }
    return item.fatura === _abertaKeyPorCartao[item.cartaoId];
  };

  async function simularGetOrcamento(mes, ano) {
    const mesKey = `${ano}-${String(mes).padStart(2, '0')}`;
    const prevMes = mes === 1 ? 12 : mes - 1;
    const prevAno = mes === 1 ? ano - 1 : ano;
    const prevKey = `${prevAno}-${String(prevMes).padStart(2, '0')}`;
    const nextMes = mes === 12 ? 1 : mes + 1;
    const nextAno = mes === 12 ? ano + 1 : ano;
    const nextKey = `${nextAno}-${String(nextMes).padStart(2, '0')}`;

    const docData = await getDoc(mesKey);
    const prevData = await getDoc(prevKey);
    const nextData = await getDoc(nextKey);

    const todosItensMes = (docData?.itens || []);
    const itensFaturaAberta = todosItensMes.filter(i => _ehCicloAberto(i)).map(i => ({ ...i, _faturaAberta: true }));
    const itensMes = todosItensMes.filter(i => !_ehCicloAberto(i));
    const itensPrev = (prevData?.itens || [])
      .filter(i => i.cartao && i.fatura && i.fatura === mesKey)
      .map(i => ({ ...i, _sourceMes: prevMes, _sourceAno: prevAno, ...(_ehCicloAberto(i) ? { _faturaAberta: true } : {}) }));
    const itensNext = (nextData?.itens || [])
      .filter(i => i.cartao && i.fatura === nextKey && !_ehCicloAberto(i))
      .map(i => ({ ...i, _sourceMes: nextMes, _sourceAno: nextAno }));

    return [...itensMes, ...itensPrev, ...itensNext, ...itensFaturaAberta];
  }

  // _openKey do frontend (baseado em hoje, não no mês visualizado)
  const _openKey = {};
  Object.entries(cartaoMap).forEach(([id, c]) => {
    if (c.diaCorte) _openKey[id] = _sugerirFatura(hojeStr, c.diaCorte, c.diaVencimento || 1);
  });
  const _periodoNum = key => {
    const [a, m] = (key || '').split('-').map(Number);
    return (a || 0) * 12 + (m || 0);
  };

  for (const [mes, ano] of [[7, 2026], [8, 2026], [9, 2026]]) {
    const despesas = await simularGetOrcamento(mes, ano);
    const gruposFechada = {};
    despesas.filter(d => d.cartao).forEach(d => {
      const aberta = _openKey[d.cartaoId];
      if (d.fatura !== aberta && (!aberta || _periodoNum(d.fatura) <= _periodoNum(aberta))) {
        const key = `${d.cartaoId || ''}_${d.fatura || ''}`;
        (gruposFechada[key] ||= []).push(d);
      }
    });
    const temXPJulhoAntes = Object.keys(gruposFechada).includes('SAZGWUhaa9zWR1Cf3lsV_2026-07');
    // backfill (novo, com check de jaFechou)
    const gruposFechadaNovo = { ...gruposFechada };
    Object.entries(faturaEstados).forEach(([key, fe]) => {
      if (key in gruposFechadaNovo) return;
      if (fe?.ajusteTotal == null) return;
      const [cartaoId, faturaKey] = key.split('_');
      const aberta = _openKey[cartaoId];
      const jaFechou = faturaKey !== aberta && (!aberta || _periodoNum(faturaKey) <= _periodoNum(aberta));
      if (!jaFechou) return;
      gruposFechadaNovo[key] = [];
    });
    // backfill (antigo, sem check)
    const gruposFechadaAntigo = { ...gruposFechada };
    Object.entries(faturaEstados).forEach(([key, fe]) => {
      if (key in gruposFechadaAntigo) return;
      if (fe?.ajusteTotal == null) return;
      const cartaoId = key.split('_')[0];
      gruposFechadaAntigo[key] = [];
    });

    // regra mais recente: só 1 fatura por cartão (a que fechou por último)
    const gruposFechadaUnico = { ...gruposFechada };
    const alvoPorCartao = {};
    Object.entries(cartaoMap).forEach(([id]) => {
      const aberta = _openKey[id];
      if (!aberta) return;
      let [aAno, aMes] = aberta.split('-').map(Number);
      aMes -= 1; if (aMes < 1) { aMes = 12; aAno -= 1; }
      alvoPorCartao[id] = `${aAno}-${String(aMes).padStart(2,'0')}`;
    });
    Object.keys(gruposFechadaUnico).forEach(key => {
      const [cartaoId, faturaKey] = key.split('_');
      if (alvoPorCartao[cartaoId] && faturaKey !== alvoPorCartao[cartaoId]) delete gruposFechadaUnico[key];
    });
    Object.entries(faturaEstados).forEach(([key, fe]) => {
      if (key in gruposFechadaUnico) return;
      const [cartaoId, faturaKey] = key.split('_');
      if (alvoPorCartao[cartaoId] !== faturaKey) return;
      gruposFechadaUnico[key] = [];
    });

    console.log(`\n=== Visto de ${ano}-${String(mes).padStart(2,'0')} ===`);
    console.log('despesas com cartao=true, quantas:', despesas.filter(d=>d.cartao).length);
    console.log('XP_2026-07 direto do loop de itens (antes do backfill)?', temXPJulhoAntes);
    console.log('XP_2026-07 no resultado final (código NOVO)?', 'SAZGWUhaa9zWR1Cf3lsV_2026-07' in gruposFechadaNovo);
    console.log('XP_2026-07 no resultado final (código ANTIGO)?', 'SAZGWUhaa9zWR1Cf3lsV_2026-07' in gruposFechadaAntigo);
    console.log('Chaves em Fechada (novo):', Object.keys(gruposFechadaNovo));
    console.log('Chaves em Fechada (regra: 1 por cartão, a mais recente):', Object.keys(gruposFechadaUnico));
    Object.entries(gruposFechadaUnico).forEach(([key, itens]) => {
      const fe = faturaEstados[key] || {};
      const totalCalcItens = itens.reduce((s,d)=>s+(d.tipo==='receita'?-d.valor:d.valor),0);
      const totalCalc = (itens.length || fe.ajusteTotal!=null) ? totalCalcItens : (fe.valorPago||0)+(fe.rollover||0);
      const totalDisplay = fe.ajusteTotal ?? totalCalc;
      console.log(`  ${key}: itens em vista=${itens.length}, totalCalc=${totalCalc}, totalDisplay=${totalDisplay}, estado=${fe.estado||'-'}`);
    });
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
