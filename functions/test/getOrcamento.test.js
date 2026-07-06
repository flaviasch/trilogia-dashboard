'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { fns, auth, uidTeste } = require('./setup');
const { _sugerirFatura } = require('../index')._test;

const db = admin.firestore();

// Usa a data real de hoje (mesma fonte que o backend usa via hoje()) em vez de
// fixar uma data — assim o teste continua válido em qualquer dia que rodar,
// sem precisar mockar Date.
function hojeStr() {
  return new Date().toISOString().split('T')[0];
}
function mesKeyDe(ano, mes) {
  return `${ano}-${String(mes).padStart(2, '0')}`;
}

test('getOrcamento — classificação de fatura aberta/fechada', async (t) => {
  await t.test('item cuja fatura bate com o ciclo aberto de hoje vem marcado _faturaAberta', async () => {
    const uid = uidTeste();
    const cartaoId = 'cartao-teste';
    const diaCorte = 2, diaVencimento = 10; // mesmo padrão da XP/Sem Parar (ver status_dashboard.md)
    await db.collection('mentoradas').doc(uid).collection('cartoes').doc(cartaoId)
      .set({ nome: 'Cartão Teste', diaCorte, diaVencimento, ativo: true });

    const openKey = _sugerirFatura(hojeStr(), diaCorte, diaVencimento);
    const [openAno, openMes] = openKey.split('-').map(Number);
    const fechadaMes = openMes === 1 ? 12 : openMes - 1;
    const fechadaAno = openMes === 1 ? openAno - 1 : openAno;
    const faturaFechada = mesKeyDe(fechadaAno, fechadaMes);

    const hoje = new Date();
    const mes = hoje.getMonth() + 1, ano = hoje.getFullYear();
    await db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKeyDe(ano, mes)).set({
      itens: [
        { categoria: 'Assinaturas', tipo: 'despesa', valor: 60, cartao: true, cartaoId, fatura: openKey, data: mesKeyDe(ano, mes) + '-03' },
        { categoria: 'Transporte', tipo: 'despesa', valor: 40, cartao: true, cartaoId, fatura: faturaFechada, data: mesKeyDe(ano, mes) + '-01' },
      ],
    });

    const itens = await fns.getOrcamento.run({ data: { uid, mes, ano }, auth: auth(uid) });

    const itemAberto  = itens.find(i => i.fatura === openKey);
    const itemFechado = itens.find(i => i.fatura === faturaFechada);
    assert.ok(itemAberto, 'item da fatura aberta deveria estar presente no resultado');
    assert.equal(itemAberto._faturaAberta, true);
    assert.ok(itemFechado, 'item da fatura fechada deveria estar presente no resultado');
    assert.equal(itemFechado._faturaAberta, undefined, 'item de fatura fechada não deve vir marcado como aberta');
  });

  await t.test('item sem cartaoId cadastrado nunca é marcado como fatura aberta', async () => {
    const uid = uidTeste();
    const hoje = new Date();
    const mes = hoje.getMonth() + 1, ano = hoje.getFullYear();
    await db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKeyDe(ano, mes)).set({
      itens: [
        { categoria: 'Outros', tipo: 'despesa', valor: 50, cartao: true, cartaoId: 'nao-existe', fatura: '2099-01', data: mesKeyDe(ano, mes) + '-01' },
      ],
    });

    const itens = await fns.getOrcamento.run({ data: { uid, mes, ano }, auth: auth(uid) });
    assert.equal(itens[0]._faturaAberta, undefined);
  });

  await t.test('item do mês anterior só "empresta" pro mês consultado se o vencimento da fatura cai nele', async () => {
    const uid = uidTeste();
    const hoje = new Date();
    const mes = hoje.getMonth() + 1, ano = hoje.getFullYear();
    const prevMes = mes === 1 ? 12 : mes - 1;
    const prevAno = mes === 1 ? ano - 1 : ano;
    const mesKeyAtual = mesKeyDe(ano, mes);

    // Item no mês anterior cuja fatura vence exatamente no mês consultado
    await db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKeyDe(prevAno, prevMes)).set({
      itens: [
        { categoria: 'Transporte', tipo: 'despesa', valor: 37.99, cartao: true, cartaoId: 'x', fatura: mesKeyAtual, data: mesKeyDe(prevAno, prevMes) + '-01' },
        { categoria: 'Assinaturas', tipo: 'despesa', valor: 15, cartao: true, cartaoId: 'x', fatura: mesKeyDe(prevAno, prevMes), data: mesKeyDe(prevAno, prevMes) + '-05' }, // fatura de outro mês — não deve emprestar
      ],
    });

    const itens = await fns.getOrcamento.run({ data: { uid, mes, ano }, auth: auth(uid) });
    assert.equal(itens.length, 1, 'só o item cuja fatura vence no mês consultado deve ser emprestado');
    assert.equal(itens[0]._sourceMes, prevMes);
    assert.equal(itens[0]._sourceAno, prevAno);
  });

  await t.test('achado 05/07/2026: item emprestado do mês anterior vem marcado _faturaAberta se essa fatura for a que está aberta hoje', async () => {
    const uid = uidTeste();
    const cartaoId = 'cartao-teste-2';
    const diaCorte = 30, diaVencimento = 10; // mesmo padrão do Bradesco (ver status_dashboard.md)
    await db.collection('mentoradas').doc(uid).collection('cartoes').doc(cartaoId)
      .set({ nome: 'Cartão Teste 2', diaCorte, diaVencimento, ativo: true });

    const openKey = _sugerirFatura(hojeStr(), diaCorte, diaVencimento);
    const [openAno, openMes] = openKey.split('-').map(Number);

    const hoje = new Date();
    const mesAtual = hoje.getMonth() + 1, anoAtual = hoje.getFullYear();

    // Compra feita neste mês, com fatura = openKey (é a que está aberta hoje pra esse cartão)
    await db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKeyDe(anoAtual, mesAtual)).set({
      itens: [
        { categoria: 'Pessoal', tipo: 'despesa', valor: 600, cartao: true, cartaoId, fatura: openKey, data: mesKeyDe(anoAtual, mesAtual) + '-28' },
      ],
    });

    // Consultando o mês da própria fatura aberta, o item vem emprestado —
    // sem o fix, ele apareceria "solto" (sem _faturaAberta), dando a
    // impressão de duplicata quando comparado com a mesma fatura vista a
    // partir do mês nativo (onde fica corretamente escondida da aba Detalhe).
    const itens = await fns.getOrcamento.run({ data: { uid, mes: openMes, ano: openAno }, auth: auth(uid) });
    assert.equal(itens.length, 1);
    assert.equal(itens[0]._sourceMes, mesAtual);
    assert.equal(itens[0]._faturaAberta, true, 'item emprestado cuja fatura é a aberta hoje deve vir marcado _faturaAberta');
  });

  await t.test('traduz categoria numérica (código do CSV do Raio-X) pro nome legível', async () => {
    const uid = uidTeste();
    const hoje = new Date();
    const mes = hoje.getMonth() + 1, ano = hoje.getFullYear();
    await db.collection('mentoradas').doc(uid).collection('orcamento').doc(mesKeyDe(ano, mes)).set({
      itens: [{ categoria: '1', tipo: 'despesa', valor: 1000, cartao: false, fatura: '', data: mesKeyDe(ano, mes) + '-01' }],
    });

    const itens = await fns.getOrcamento.run({ data: { uid, mes, ano }, auth: auth(uid) });
    assert.equal(itens[0].categoria, 'Aluguel');
  });

  await t.test('mês sem nenhum lançamento retorna array vazio', async () => {
    const uid = uidTeste();
    const itens = await fns.getOrcamento.run({ data: { uid, mes: 1, ano: 2099 }, auth: auth(uid) });
    assert.deepEqual(itens, []);
  });
});
