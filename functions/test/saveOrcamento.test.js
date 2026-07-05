'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { fns, auth, uidTeste } = require('./setup');

const MES = 7, ANO = 2026;
const db = admin.firestore();

function despesa(categoria, valor, extra = {}) {
  return { categoria, tipo: 'despesa', valor, data: '2026-07-10', descricao: '', cartao: false, fatura: '', ...extra };
}
function receita(categoria, valor) {
  return { categoria, tipo: 'receita', valor, data: '', descricao: '', cartao: false, fatura: '' };
}

test('saveOrcamento', async (t) => {
  await t.test('salva itens normalmente quando não há nada gravado antes', async () => {
    const uid = uidTeste();
    const itens = [despesa('Moradia', 1680), receita('Salário', 21800)];
    const res = await fns.saveOrcamento.run({ data: { uid, mes: MES, ano: ANO, itens }, auth: auth(uid) });
    assert.equal(res.ok, true);

    const snap = await db.collection('mentoradas').doc(uid).collection('orcamento').doc('2026-07').get();
    assert.equal(snap.data().itens.length, 2);
  });

  await t.test('achado 04/07/2026: bloqueia salvamento que apagaria todos os itens de um tipo', async () => {
    const uid = uidTeste();
    // Estado inicial: 3 despesas + 1 receita
    await fns.saveOrcamento.run({
      data: { uid, mes: MES, ano: ANO, itens: [despesa('Moradia', 1680), despesa('Outros', 378), despesa('Saúde', 2530), receita('Salário', 21800)] },
      auth: auth(uid),
    });

    // Tenta salvar sem nenhuma receita (perderia o tipo inteiro)
    await assert.rejects(
      fns.saveOrcamento.run({
        data: { uid, mes: MES, ano: ANO, itens: [despesa('Moradia', 1680), despesa('Outros', 378), despesa('Saúde', 2530)] },
        auth: auth(uid),
      }),
      /failed-precondition/
    );

    // Confirma que o dado original permanece intacto no Firestore
    const snap = await db.collection('mentoradas').doc(uid).collection('orcamento').doc('2026-07').get();
    assert.equal(snap.data().itens.length, 4);
  });

  await t.test('bloqueia encolhimento maior que 50% mesmo sem perder um tipo inteiro', async () => {
    const uid = uidTeste();
    const muitos = Array.from({ length: 10 }, (_, i) => despesa(`Categoria ${i}`, 100));
    await fns.saveOrcamento.run({ data: { uid, mes: MES, ano: ANO, itens: muitos }, auth: auth(uid) });

    await assert.rejects(
      fns.saveOrcamento.run({ data: { uid, mes: MES, ano: ANO, itens: muitos.slice(0, 3) }, auth: auth(uid) }),
      /failed-precondition/
    );
  });

  await t.test('permitirReducao=true autoriza a mesma redução que seria bloqueada', async () => {
    const uid = uidTeste();
    const muitos = Array.from({ length: 10 }, (_, i) => despesa(`Categoria ${i}`, 100));
    await fns.saveOrcamento.run({ data: { uid, mes: MES, ano: ANO, itens: muitos }, auth: auth(uid) });

    const res = await fns.saveOrcamento.run({
      data: { uid, mes: MES, ano: ANO, itens: muitos.slice(0, 3), permitirReducao: true },
      auth: auth(uid),
    });
    assert.equal(res.ok, true);

    const snap = await db.collection('mentoradas').doc(uid).collection('orcamento').doc('2026-07').get();
    assert.equal(snap.data().itens.length, 3);
  });

  await t.test('guarda a versão anterior antes de sobrescrever', async () => {
    const uid = uidTeste();
    await fns.saveOrcamento.run({ data: { uid, mes: MES, ano: ANO, itens: [despesa('Moradia', 1680)] }, auth: auth(uid) });
    await fns.saveOrcamento.run({ data: { uid, mes: MES, ano: ANO, itens: [despesa('Moradia', 1680), despesa('Outros', 378)] }, auth: auth(uid) });

    const versoesSnap = await db.collection('mentoradas').doc(uid).collection('orcamento').doc('2026-07').collection('versoes').get();
    assert.equal(versoesSnap.size, 1, 'deveria ter guardado 1 versão (o estado antes da 2ª chamada)');
    assert.equal(versoesSnap.docs[0].data().itens.length, 1);
  });

  await t.test('achado 04/07/2026: nunca persiste _sourceMes, _sourceAno ou _faturaAberta de volta', async () => {
    const uid = uidTeste();
    const itemComVazamento = {
      ...despesa('Assinaturas', 60),
      _sourceMes: 6, _sourceAno: 2026, // simula item "emprestado" que o frontend não deveria reenviar aqui
      _faturaAberta: true, // simula campo computado na leitura que não deveria voltar pro banco
    };
    await fns.saveOrcamento.run({ data: { uid, mes: MES, ano: ANO, itens: [itemComVazamento] }, auth: auth(uid) });

    const snap = await db.collection('mentoradas').doc(uid).collection('orcamento').doc('2026-07').get();
    const salvo = snap.data().itens[0];
    assert.equal(salvo._sourceMes, undefined);
    assert.equal(salvo._sourceAno, undefined);
    assert.equal(salvo._faturaAberta, undefined);
  });

  await t.test('rejeita item com tipo inválido', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.saveOrcamento.run({ data: { uid, mes: MES, ano: ANO, itens: [{ categoria: 'X', tipo: 'invalido', valor: 10 }] }, auth: auth(uid) }),
      /invalid-argument/
    );
  });

  await t.test('rejeita valor negativo', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.saveOrcamento.run({ data: { uid, mes: MES, ano: ANO, itens: [despesa('X', -10)] }, auth: auth(uid) }),
      /invalid-argument/
    );
  });
});
