'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fns, auth, uidTeste } = require('./setup');

// Vínculo categoria → categoria-mãe GLOBAL (achado 05/08/2026): ao contrário
// de upsertCategoriaLimite (por mês), este vínculo não pertence a nenhum mês
// — uma vez definido, vale pra todos, passados e futuros, sem precisar
// refazer. Guarda em mentoradas/{uid}/config/categoriasMae, separado do
// documento de planejamento do mês.

test('upsertCategoriaMaeGlobal', async (t) => {
  await t.test('cria vínculo novo quando não existe nenhum', async () => {
    const uid = uidTeste();
    const res = await fns.upsertCategoriaMaeGlobal.run({
      data: { uid, nome: 'Presente de aniversário', mae: 'Lazer' },
      auth: auth(uid),
    });
    assert.equal(res.vinculos.length, 1);
    assert.deepEqual(res.vinculos[0], { nome: 'Presente de aniversário', mae: 'Lazer' });
  });

  await t.test('getCategoriasMaeGlobais retorna o que foi salvo', async () => {
    const uid = uidTeste();
    await fns.upsertCategoriaMaeGlobal.run({
      data: { uid, nome: 'Petiscaria', mae: 'Pet' },
      auth: auth(uid),
    });
    const res = await fns.getCategoriasMaeGlobais.run({ data: { uid }, auth: auth(uid) });
    assert.equal(res.vinculos.length, 1);
    assert.deepEqual(res.vinculos[0], { nome: 'Petiscaria', mae: 'Pet' });
  });

  await t.test('mae null/vazio remove o vínculo em vez de manter registro vazio', async () => {
    const uid = uidTeste();
    await fns.upsertCategoriaMaeGlobal.run({ data: { uid, nome: 'Cinema', mae: 'Lazer' }, auth: auth(uid) });
    const res = await fns.upsertCategoriaMaeGlobal.run({ data: { uid, nome: 'Cinema', mae: null }, auth: auth(uid) });
    assert.equal(res.vinculos.length, 0);
  });

  await t.test('grafia diferente atualiza o mesmo vínculo, não cria duplicata', async () => {
    const uid = uidTeste();
    await fns.upsertCategoriaMaeGlobal.run({ data: { uid, nome: 'Alimentação', mae: 'Alimentação' }, auth: auth(uid) });
    const res = await fns.upsertCategoriaMaeGlobal.run({ data: { uid, nome: 'alimentação', mae: 'Alimentação' }, auth: auth(uid) });
    assert.equal(res.vinculos.length, 1, 'deveria ter só 1 entrada, não 2 (Alimentação + alimentação)');
  });

  await t.test('troca de categoria-mãe atualiza o vínculo existente', async () => {
    const uid = uidTeste();
    await fns.upsertCategoriaMaeGlobal.run({ data: { uid, nome: 'Presente', mae: 'Outros' }, auth: auth(uid) });
    const res = await fns.upsertCategoriaMaeGlobal.run({ data: { uid, nome: 'Presente', mae: 'Lazer' }, auth: auth(uid) });
    assert.equal(res.vinculos.length, 1);
    assert.equal(res.vinculos[0].mae, 'Lazer');
  });

  await t.test('preserva outros vínculos já existentes', async () => {
    const uid = uidTeste();
    await fns.upsertCategoriaMaeGlobal.run({ data: { uid, nome: 'Aluguel', mae: 'Moradia' }, auth: auth(uid) });
    await fns.upsertCategoriaMaeGlobal.run({ data: { uid, nome: 'Combustível', mae: 'Transporte' }, auth: auth(uid) });
    const res = await fns.upsertCategoriaMaeGlobal.run({ data: { uid, nome: 'Mensalidades', mae: 'Educação' }, auth: auth(uid) });
    assert.equal(res.vinculos.length, 3);
    const nomes = res.vinculos.map(c => c.nome).sort();
    assert.deepEqual(nomes, ['Aluguel', 'Combustível', 'Mensalidades']);
  });

  await t.test('rejeita nome vazio', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.upsertCategoriaMaeGlobal.run({ data: { uid, nome: '', mae: 'Outros' }, auth: auth(uid) }),
      { code: 'invalid-argument' }
    );
  });

  await t.test('rejeita chamada sem autenticação', async () => {
    const uid = uidTeste();
    await assert.rejects(
      fns.upsertCategoriaMaeGlobal.run({ data: { uid, nome: 'Outros', mae: 'Outros' } }),
      { code: 'unauthenticated' }
    );
  });

  await t.test('rejeita mentorada tentando editar dado de outra uid', async () => {
    const uidAlvo = uidTeste();
    const uidAtacante = uidTeste();
    await assert.rejects(
      fns.upsertCategoriaMaeGlobal.run({
        data: { uid: uidAlvo, nome: 'Outros', mae: 'Outros' },
        auth: auth(uidAtacante, false),
      }),
      { code: 'permission-denied' }
    );
  });
});
