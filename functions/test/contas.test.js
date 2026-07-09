'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fns, auth, uidTeste } = require('./setup');

test('getContas', async (t) => {
  await t.test('sem nenhuma conta salva, retorna só a principal sintetizada', async () => {
    const uid = uidTeste();
    const res = await fns.getContas.run({ data: { uid }, auth: auth(uid) });
    assert.equal(res.contas.length, 1);
    assert.deepEqual(res.contas[0], { id: 'principal', nome: 'Conta principal', ativa: true, principal: true });
  });

  await t.test('rejeita chamada sem autenticação', async () => {
    const uid = uidTeste();
    await assert.rejects(fns.getContas.run({ data: { uid } }), { code: 'unauthenticated' });
  });
});

test('saveConta', async (t) => {
  await t.test('sem id, cria uma conta nova secundária', async () => {
    const uid = uidTeste();
    const criada = await fns.saveConta.run({ data: { uid, nome: 'Poupança conjunta' }, auth: auth(uid) });
    assert.equal(criada.nome, 'Poupança conjunta');
    assert.equal(criada.principal, false);
    assert.ok(criada.id);

    const { contas } = await fns.getContas.run({ data: { uid }, auth: auth(uid) });
    assert.equal(contas.length, 2);
    assert.equal(contas[0].id, 'principal', 'principal sempre vem primeiro');
    assert.equal(contas[1].nome, 'Poupança conjunta');
  });

  await t.test('com id="principal", renomeia a principal em vez de criar outra', async () => {
    const uid = uidTeste();
    await fns.saveConta.run({ data: { uid, id: 'principal', nome: 'Conta do Nubank' }, auth: auth(uid) });

    const { contas } = await fns.getContas.run({ data: { uid }, auth: auth(uid) });
    assert.equal(contas.length, 1, 'renomear a principal não deveria criar uma segunda entrada');
    assert.equal(contas[0].nome, 'Conta do Nubank');
    assert.equal(contas[0].principal, true);
  });

  await t.test('rejeita nome vazio', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.saveConta.run({ data: { uid, nome: '' }, auth: auth(uid) }),
      { code: 'invalid-argument' }
    );
  });

  await t.test('respeita o limite máximo de contas', async () => {
    const uid = uidTeste();
    for (let i = 0; i < 9; i++) {
      await fns.saveConta.run({ data: { uid, nome: `Conta ${i}` }, auth: auth(uid) });
    }
    await assert.rejects(
      fns.saveConta.run({ data: { uid, nome: 'Conta a mais' }, auth: auth(uid) }),
      { code: 'failed-precondition' }
    );
  });

  await t.test('rejeita mentorada tentando editar conta de outra uid', async () => {
    const uidAlvo = uidTeste();
    const uidAtacante = uidTeste();
    await assert.rejects(
      fns.saveConta.run({ data: { uid: uidAlvo, nome: 'Invasão' }, auth: auth(uidAtacante, false) }),
      { code: 'permission-denied' }
    );
  });
});

test('arquivarConta', async (t) => {
  await t.test('arquiva e reativa uma conta secundária', async () => {
    const uid = uidTeste();
    const criada = await fns.saveConta.run({ data: { uid, nome: 'Conta antiga' }, auth: auth(uid) });

    await fns.arquivarConta.run({ data: { uid, id: criada.id, ativa: false }, auth: auth(uid) });
    let res = await fns.getContas.run({ data: { uid }, auth: auth(uid) });
    assert.equal(res.contas.find(c => c.id === criada.id).ativa, false);

    await fns.arquivarConta.run({ data: { uid, id: criada.id, ativa: true }, auth: auth(uid) });
    res = await fns.getContas.run({ data: { uid }, auth: auth(uid) });
    assert.equal(res.contas.find(c => c.id === criada.id).ativa, true);
  });

  await t.test('rejeita arquivar a conta principal', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.arquivarConta.run({ data: { uid, id: 'principal', ativa: false }, auth: auth(uid) }),
      { code: 'invalid-argument' }
    );
  });
});

test('deletarConta', async (t) => {
  await t.test('exclui uma conta secundária permanentemente', async () => {
    const uid = uidTeste();
    const criada = await fns.saveConta.run({ data: { uid, nome: 'Duplicata' }, auth: auth(uid) });

    await fns.deletarConta.run({ data: { uid, id: criada.id }, auth: auth(uid) });

    const { contas } = await fns.getContas.run({ data: { uid }, auth: auth(uid) });
    assert.equal(contas.length, 1, 'só deve sobrar a principal');
    assert.equal(contas.find(c => c.id === criada.id), undefined);
  });

  await t.test('rejeita excluir a conta principal', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.deletarConta.run({ data: { uid, id: 'principal' }, auth: auth(uid) }),
      { code: 'invalid-argument' }
    );
  });

  await t.test('rejeita mentorada tentando excluir conta de outra uid', async () => {
    const uidAlvo = uidTeste();
    const uidAtacante = uidTeste();
    const criada = await fns.saveConta.run({ data: { uid: uidAlvo, nome: 'Alvo' }, auth: auth(uidAlvo) });
    await assert.rejects(
      fns.deletarConta.run({ data: { uid: uidAlvo, id: criada.id }, auth: auth(uidAtacante, false) }),
      { code: 'permission-denied' }
    );
  });
});
