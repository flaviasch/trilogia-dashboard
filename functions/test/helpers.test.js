'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _normCat, _resolverCategoria, _sugerirFatura, _mesPagamento } = require('../index')._test;

test('_normCat', async (t) => {
  await t.test('minúscula e sem acento tratam como iguais', () => {
    assert.equal(_normCat('Alimentação'), _normCat('alimentacao'));
    assert.equal(_normCat('AJUSTE DE FATURA'), _normCat('Ajuste de fatura'));
  });

  await t.test('remove espaços nas pontas', () => {
    assert.equal(_normCat('  Despesas financeiras  '), 'despesas financeiras');
  });

  await t.test('vazio/nulo/indefinido viram string vazia', () => {
    assert.equal(_normCat(''), '');
    assert.equal(_normCat(null), '');
    assert.equal(_normCat(undefined), '');
  });

  await t.test('categorias visualmente diferentes continuam diferentes', () => {
    assert.notEqual(_normCat('Outros'), _normCat('Outro'));
  });
});

test('_resolverCategoria', async (t) => {
  await t.test('código numérico conhecido vira o nome da categoria', () => {
    assert.equal(_resolverCategoria('1'), 'Aluguel');
    assert.equal(_resolverCategoria(36), 'Alimentação');
  });

  await t.test('código com espaços nas pontas ainda resolve', () => {
    assert.equal(_resolverCategoria(' 1 '), 'Aluguel');
  });

  await t.test('código numérico sem mapeamento retorna como veio', () => {
    assert.equal(_resolverCategoria('999'), '999');
  });

  await t.test('texto que não é código numérico retorna sem alteração', () => {
    assert.equal(_resolverCategoria('Aluguel'), 'Aluguel');
    assert.equal(_resolverCategoria('Ajuste de fatura'), 'Ajuste de fatura');
  });

  await t.test('vazio/nulo retorna como veio', () => {
    assert.equal(_resolverCategoria(''), '');
    assert.equal(_resolverCategoria(null), null);
  });
});

test('_sugerirFatura', async (t) => {
  await t.test('Bradesco (corte 30, vencimento 10): compra dia 4 cai na fatura do mês seguinte', () => {
    // vencimento(10) <= corte(30) → sempre avança mais um mês além do corte
    assert.equal(_sugerirFatura('2026-07-04', 30, 10), '2026-08');
  });

  await t.test('XP/Sem Parar (corte 2, vencimento 10): compra dia 4 (já passou do corte) cai 2 meses à frente', () => {
    // dia(4) > corte(2) → avança 1 mês; vencimento(10) > corte(2) → não avança de novo
    assert.equal(_sugerirFatura('2026-07-04', 2, 10), '2026-08');
  });

  await t.test('compra antes do corte não avança pela primeira regra', () => {
    // corte 30, vencimento 10: compra dia 3 (< corte) — só avança pela regra do vencimento
    assert.equal(_sugerirFatura('2026-07-03', 30, 10), '2026-08');
  });

  await t.test('sem diaVencimento definido sempre avança mais um mês', () => {
    assert.equal(_sugerirFatura('2026-07-03', 30, undefined), '2026-08');
  });

  await t.test('virada de ano', () => {
    assert.equal(_sugerirFatura('2026-12-15', 2, 10), '2027-01');
  });
});

test('_mesPagamento', async (t) => {
  await t.test('fatura válida retorna ela mesma (é o mês de pagamento)', () => {
    assert.equal(_mesPagamento('2026-07'), '2026-07');
  });

  await t.test('sem fatura retorna null', () => {
    assert.equal(_mesPagamento(null), null);
    assert.equal(_mesPagamento(''), null);
  });

  await t.test('formato inválido retorna null', () => {
    assert.equal(_mesPagamento('não-é-uma-data'), null);
  });
});
