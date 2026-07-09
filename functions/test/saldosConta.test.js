'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fns, auth, uidTeste } = require('./setup');

const MES = 7, ANO = 2026;

test('getSaldosConta', async (t) => {
  await t.test('mês sem nenhum saldo salvo retorna objeto vazio', async () => {
    const uid = uidTeste();
    const res = await fns.getSaldosConta.run({ data: { uid, mes: MES, ano: ANO }, auth: auth(uid) });
    assert.deepEqual(res.saldos, {});
  });

  await t.test('rejeita chamada sem autenticação', async () => {
    const uid = uidTeste();
    await assert.rejects(fns.getSaldosConta.run({ data: { uid, mes: MES, ano: ANO } }), { code: 'unauthenticated' });
  });
});

test('saveSaldoConta', async (t) => {
  await t.test('salva o saldo da conta principal', async () => {
    const uid = uidTeste();
    await fns.saveSaldoConta.run({ data: { uid, mes: MES, ano: ANO, contaId: 'principal', valor: 2000 }, auth: auth(uid) });
    const res = await fns.getSaldosConta.run({ data: { uid, mes: MES, ano: ANO }, auth: auth(uid) });
    assert.deepEqual(res.saldos, { principal: 2000 });
  });

  await t.test('salvar saldo de uma conta não apaga o saldo de outra já salva no mesmo mês', async () => {
    const uid = uidTeste();
    await fns.saveSaldoConta.run({ data: { uid, mes: MES, ano: ANO, contaId: 'principal', valor: 2000 }, auth: auth(uid) });
    await fns.saveSaldoConta.run({ data: { uid, mes: MES, ano: ANO, contaId: 'conta-secundaria', valor: 500 }, auth: auth(uid) });

    const res = await fns.getSaldosConta.run({ data: { uid, mes: MES, ano: ANO }, auth: auth(uid) });
    assert.deepEqual(res.saldos, { principal: 2000, 'conta-secundaria': 500 });
  });

  await t.test('atualizar o saldo de uma conta sobrescreve só ela', async () => {
    const uid = uidTeste();
    await fns.saveSaldoConta.run({ data: { uid, mes: MES, ano: ANO, contaId: 'principal', valor: 1000 }, auth: auth(uid) });
    await fns.saveSaldoConta.run({ data: { uid, mes: MES, ano: ANO, contaId: 'principal', valor: 1500 }, auth: auth(uid) });

    const res = await fns.getSaldosConta.run({ data: { uid, mes: MES, ano: ANO }, auth: auth(uid) });
    assert.deepEqual(res.saldos, { principal: 1500 });
  });

  await t.test('aceita valor negativo (conta no vermelho)', async () => {
    const uid = uidTeste();
    await fns.saveSaldoConta.run({ data: { uid, mes: MES, ano: ANO, contaId: 'principal', valor: -300 }, auth: auth(uid) });
    const res = await fns.getSaldosConta.run({ data: { uid, mes: MES, ano: ANO }, auth: auth(uid) });
    assert.deepEqual(res.saldos, { principal: -300 });
  });

  await t.test('rejeita contaId ausente', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.saveSaldoConta.run({ data: { uid, mes: MES, ano: ANO, valor: 100 }, auth: auth(uid) }),
      { code: 'invalid-argument' }
    );
  });

  await t.test('rejeita valor não numérico', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.saveSaldoConta.run({ data: { uid, mes: MES, ano: ANO, contaId: 'principal', valor: 'abc' }, auth: auth(uid) }),
      { code: 'invalid-argument' }
    );
  });

  await t.test('rejeita mentorada tentando editar saldo de outra uid', async () => {
    const uidAlvo = uidTeste();
    const uidAtacante = uidTeste();
    await assert.rejects(
      fns.saveSaldoConta.run({
        data: { uid: uidAlvo, mes: MES, ano: ANO, contaId: 'principal', valor: 999 },
        auth: auth(uidAtacante, false),
      }),
      { code: 'permission-denied' }
    );
  });
});
