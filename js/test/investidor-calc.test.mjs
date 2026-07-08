// Testes do módulo compartilhado de alocação/prazo de investidor
// (js/investidor-calc.js). Roda com `node --test js/test/*.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALOCACAO_PERFIL,
  ALOCACAO_CURTO_PRAZO,
  ALOCACAO_MEDIO_PRAZO,
  mesesAte,
  mesesEntre,
} from '../investidor-calc.js';

function mesAno(offsetMeses) {
  const d = new Date();
  d.setMonth(d.getMonth() + offsetMeses);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

test('ALOCACAO_PERFIL', async (t) => {
  await t.test('as 3 chaves de perfil somam 100%', () => {
    for (const key of ['conservador', 'moderado', 'arrojado']) {
      const soma = ALOCACAO_PERFIL[key].reduce((s, a) => s + a.pct, 0);
      assert.ok(Math.abs(soma - 100) < 0.01, `${key} soma ${soma}, esperado 100`);
    }
  });
});

test('ALOCACAO_CURTO_PRAZO / ALOCACAO_MEDIO_PRAZO somam 100%', () => {
  assert.equal(ALOCACAO_CURTO_PRAZO.reduce((s, a) => s + a.pct, 0), 100);
  assert.equal(ALOCACAO_MEDIO_PRAZO.reduce((s, a) => s + a.pct, 0), 100);
});

test('mesesAte', async (t) => {
  await t.test('null sem data', () => {
    assert.equal(mesesAte(null), null);
    assert.equal(mesesAte(''), null);
  });
  await t.test('mês atual retorna 0', () => {
    assert.equal(mesesAte(mesAno(0)), 0);
  });
  await t.test('12 meses à frente retorna 12', () => {
    assert.equal(mesesAte(mesAno(12)), 12);
  });
  await t.test('data no passado clampa em 0, nunca negativo', () => {
    assert.equal(mesesAte(mesAno(-12)), 0);
  });
  await t.test('aritmética de mês-calendário, não aproximação por dias', () => {
    // 1 mês à frente é sempre exatamente 1, independente de o mês ter
    // 28, 30 ou 31 dias (diferente da aproximação por "30 dias corridos").
    assert.equal(mesesAte(mesAno(1)), 1);
  });
});

test('mesesEntre', async (t) => {
  await t.test('null sem uma das datas', () => {
    assert.equal(mesesEntre(null, '2027-01'), null);
    assert.equal(mesesEntre('2026-01', null), null);
  });
  await t.test('mesmo mês retorna 0', () => {
    assert.equal(mesesEntre('2026-07', '2026-07'), 0);
  });
  await t.test('cruzando virada de ano', () => {
    assert.equal(mesesEntre('2026-11', '2027-02'), 3);
  });
  await t.test('ordem invertida clampa em 0, nunca negativo', () => {
    assert.equal(mesesEntre('2027-01', '2026-01'), 0);
  });
});
