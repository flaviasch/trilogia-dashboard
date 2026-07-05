'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fns, auth, uidTeste } = require('./setup');

const MES = 7, ANO = 2026;

test('upsertCategoriaLimite', async (t) => {
  await t.test('cria categoria nova quando não existe nenhuma', async () => {
    const uid = uidTeste();
    const res = await fns.upsertCategoriaLimite.run({
      data: { uid, mes: MES, ano: ANO, nome: 'Saúde', limite: 4800 },
      auth: auth(uid),
    });
    assert.equal(res.categorias.length, 1);
    assert.deepEqual(res.categorias[0], { nome: 'Saúde', limite: 4800 });
  });

  await t.test('achado 04/07/2026: grafia diferente atualiza a mesma entrada, não cria duplicata', async () => {
    const uid = uidTeste();
    await fns.upsertCategoriaLimite.run({ data: { uid, mes: MES, ano: ANO, nome: 'Alimentação', limite: 5700 }, auth: auth(uid) });
    const res = await fns.upsertCategoriaLimite.run({ data: { uid, mes: MES, ano: ANO, nome: 'alimentação', limite: 1800 }, auth: auth(uid) });

    assert.equal(res.categorias.length, 1, 'deveria ter só 1 entrada, não 2 (Alimentação + alimentação)');
    assert.equal(res.categorias[0].limite, 1800, 'o limite mais recente deve prevalecer');
    assert.equal(res.categorias[0].nome, 'alimentação', 'o nome é reescrito pra grafia mais recente enviada');
  });

  await t.test('limite=0 remove a categoria em vez de manter com valor zero', async () => {
    const uid = uidTeste();
    await fns.upsertCategoriaLimite.run({ data: { uid, mes: MES, ano: ANO, nome: 'Lazer', limite: 100 }, auth: auth(uid) });
    const res = await fns.upsertCategoriaLimite.run({ data: { uid, mes: MES, ano: ANO, nome: 'Lazer', limite: 0 }, auth: auth(uid) });

    assert.equal(res.categorias.length, 0);
  });

  await t.test('preserva outras categorias já existentes no mesmo mês', async () => {
    const uid = uidTeste();
    await fns.upsertCategoriaLimite.run({ data: { uid, mes: MES, ano: ANO, nome: 'Pets', limite: 1200 }, auth: auth(uid) });
    await fns.upsertCategoriaLimite.run({ data: { uid, mes: MES, ano: ANO, nome: 'Transporte', limite: 1200 }, auth: auth(uid) });
    const res = await fns.upsertCategoriaLimite.run({ data: { uid, mes: MES, ano: ANO, nome: 'Seguros', limite: 688 }, auth: auth(uid) });

    assert.equal(res.categorias.length, 3);
    const nomes = res.categorias.map(c => c.nome).sort();
    assert.deepEqual(nomes, ['Pets', 'Seguros', 'Transporte']);
  });

  await t.test('rejeita nome vazio', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.upsertCategoriaLimite.run({ data: { uid, mes: MES, ano: ANO, nome: '', limite: 100 }, auth: auth(uid) }),
      /invalid-argument/
    );
  });

  await t.test('rejeita limite negativo', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.upsertCategoriaLimite.run({ data: { uid, mes: MES, ano: ANO, nome: 'Outros', limite: -50 }, auth: auth(uid) }),
      /invalid-argument/
    );
  });

  await t.test('rejeita chamada sem autenticação', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.upsertCategoriaLimite.run({ data: { uid, mes: MES, ano: ANO, nome: 'Outros', limite: 100 } }),
      /unauthenticated/
    );
  });

  await t.test('rejeita mentorada tentando editar dado de outra uid', async () => {
    const uidAlvo = uidTeste();
    const uidAtacante = uidTeste();
    await assert.rejects(
      fns.upsertCategoriaLimite.run({
        data: { uid: uidAlvo, mes: MES, ano: ANO, nome: 'Outros', limite: 100 },
        auth: auth(uidAtacante, false),
      }),
      /permission-denied/
    );
  });
});
