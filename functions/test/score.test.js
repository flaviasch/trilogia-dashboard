'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calcularScoreMes } = require('../index')._test;

// Helper pra montar itens de orçamento rapidamente
const receita  = (valor) => ({ tipo: 'receita', valor });
const despesa  = (valor, categoria) => ({ tipo: 'despesa', valor, categoria });
const aporte   = (valor) => ({ tipo: 'aporte', valor });

test('calcularScoreMes — componente Sobra (peso 30%)', async (t) => {
  await t.test('sobra >= 30% da receita → 100 pontos', () => {
    // receita 1000, despesa 600 → sobra 40% ; sem reservas/cats → só sobra*0.30 + regularidade*0.10
    const score = calcularScoreMes([receita(1000), despesa(600)], [], []);
    assert.equal(score, Math.round(100 * 0.30 + 0 * 0.35 + 75 * 0.25 + 100 * 0.10));
  });

  await t.test('sem receita nenhuma → 0 pontos de sobra', () => {
    const score = calcularScoreMes([despesa(100)], [], []);
    assert.equal(score, Math.round(0 * 0.30 + 0 * 0.35 + 75 * 0.25 + 100 * 0.10));
  });
});

test('calcularScoreMes — componente Aporte (peso 35%)', async (t) => {
  await t.test('sem meta de reserva (totalPlan=0) → 0 pontos de aporte', () => {
    const score = calcularScoreMes([receita(1000), aporte(500)], [], []);
    // ptsAporte fica 0 quando não há reservas com aporte planejado
    assert.equal(score, Math.round(100 * 0.30 + 0 * 0.35 + 75 * 0.25 + 100 * 0.10));
  });

  await t.test('aporte executado >= 100% da meta → 100 pontos', () => {
    const score = calcularScoreMes(
      [receita(1000), aporte(500)],
      [{ aporte: 500 }],
      []
    );
    assert.equal(score, Math.round(100 * 0.30 + 100 * 0.35 + 75 * 0.25 + 100 * 0.10));
  });
});

test('calcularScoreMes — componente Orçamento (peso 25%)', async (t) => {
  await t.test('sem categorias com limite → neutro (75)', () => {
    const score = calcularScoreMes([receita(1000)], [], []);
    assert.equal(score, Math.round(100 * 0.30 + 0 * 0.35 + 75 * 0.25 + 100 * 0.10));
  });

  await t.test('nenhuma categoria estourada → 100', () => {
    const score = calcularScoreMes(
      [receita(1000), despesa(200, 'Alimentação')],
      [],
      [{ nome: 'Alimentação', limite: 500 }]
    );
    assert.equal(score, Math.round(100 * 0.30 + 0 * 0.35 + 100 * 0.25 + 100 * 0.10));
  });

  await t.test('1 categoria estourada → 70', () => {
    const score = calcularScoreMes(
      [receita(1000), despesa(600, 'Alimentação')],
      [],
      [{ nome: 'Alimentação', limite: 500 }]
    );
    // sobra = 1000-600 = 400 (40%) → ptsSobra=100
    assert.equal(score, Math.round(100 * 0.30 + 0 * 0.35 + 70 * 0.25 + 100 * 0.10));
  });

  await t.test('categoria e limite comparados sem diferenciar maiúscula/acento (_normCat)', () => {
    // categoria salva com grafia diferente da despesa lançada — antes do fix
    // (comparação exata) essa categoria nunca contava como estourada.
    const score = calcularScoreMes(
      [receita(1000), despesa(600, 'alimentacao')],
      [],
      [{ nome: 'Alimentação', limite: 500 }]
    );
    assert.equal(score, Math.round(100 * 0.30 + 0 * 0.35 + 70 * 0.25 + 100 * 0.10));
  });
});

test('calcularScoreMes — componente Regularidade (peso 10%)', async (t) => {
  await t.test('sem nenhum lançamento → 0 pontos de regularidade', () => {
    const score = calcularScoreMes([], [], []);
    assert.equal(score, Math.round(0 * 0.30 + 0 * 0.35 + 75 * 0.25 + 0 * 0.10));
  });

  await t.test('com pelo menos um lançamento → 100 pontos de regularidade', () => {
    const score = calcularScoreMes([despesa(50, 'Outros')], [], []);
    assert.ok(score > 0);
  });
});
