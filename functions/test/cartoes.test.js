'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fns, auth, uidTeste } = require('./setup');

test('saveCartao — vínculo com conta', async (t) => {
  await t.test('sem contaId, salva com contaId null (conta principal implícita)', async () => {
    const uid = uidTeste();
    const res = await fns.saveCartao.run({
      data: { uid, cartao: { nome: 'Nubank', diaCorte: 10 } },
      auth: auth(uid),
    });
    const { id } = res;
    const cartoes = await fns.getCartoes.run({ data: { uid }, auth: auth(uid) });
    assert.equal(cartoes.find(c => c.id === id).contaId, null);
  });

  await t.test('com contaId, salva o vínculo', async () => {
    const uid = uidTeste();
    const res = await fns.saveCartao.run({
      data: { uid, cartao: { nome: 'XP Visa', diaCorte: 5, contaId: 'conta-secundaria' } },
      auth: auth(uid),
    });
    const cartoes = await fns.getCartoes.run({ data: { uid }, auth: auth(uid) });
    assert.equal(cartoes.find(c => c.id === res.id).contaId, 'conta-secundaria');
  });

  await t.test('editar cartão pra tirar o vínculo (volta pra principal) grava null', async () => {
    const uid = uidTeste();
    const criado = await fns.saveCartao.run({
      data: { uid, cartao: { nome: 'Bradesco', diaCorte: 15, contaId: 'conta-secundaria' } },
      auth: auth(uid),
    });
    await fns.saveCartao.run({
      data: { uid, cartao: { id: criado.id, nome: 'Bradesco', diaCorte: 15 } }, // sem contaId
      auth: auth(uid),
    });
    const cartoes = await fns.getCartoes.run({ data: { uid }, auth: auth(uid) });
    assert.equal(cartoes.find(c => c.id === criado.id).contaId, null);
  });
});
