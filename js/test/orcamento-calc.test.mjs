// Testes do módulo compartilhado de cálculo de orçamento (js/orcamento-calc.js).
// Roda com `node --test js/test/*.test.mjs` — sem dependências externas.
//
// localStorage não existe nativamente no Node sem flag especial; um polyfill
// mínimo em memória é instalado ANTES de importar o módulo, já que
// getFixasPuladas/addFixaPulada leem/escrevem localStorage diretamente.
globalThis.localStorage = (() => {
  let store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPendenteEfetivo,
  normCat,
  diasSemanaNoMes,
  diasEsperadosRecorrente,
  diasFaltantesRecorrente,
  chaveFixaPulada,
  getFixasPuladas,
  addFixaPulada,
  calcularAgregadosOrcamento,
  calcularAjuste,
  CATEGORIA_AJUSTE,
} from '../orcamento-calc.js';

const HOJE = new Date(2026, 6, 6); // 2026-07-06 (mesma data usada na sessão)

test('isPendenteEfetivo', async (t) => {
  await t.test('data futura é pendente', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-10' }, HOJE), true);
  });
  await t.test('data de hoje não é pendente', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-06' }, HOJE), false);
  });
  await t.test('data passada não é pendente', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-01' }, HOJE), false);
  });
  await t.test('sem data não é pendente', () => {
    assert.equal(isPendenteEfetivo({ data: '' }, HOJE), false);
  });
});

test('normCat', async (t) => {
  await t.test('remove acento e baixa caixa', () => {
    assert.equal(normCat('Alimentação'), 'alimentacao');
  });
  await t.test('trata vazio/undefined', () => {
    assert.equal(normCat(undefined), '');
  });
  await t.test('mesma categoria com grafias diferentes normaliza igual', () => {
    assert.equal(normCat('Saúde'), normCat('saude'));
  });
});

test('diasSemanaNoMes', () => {
  // Julho/2026: dia 1 é quarta-feira (getDay()=3)
  const quartas = diasSemanaNoMes(2026, 7, 3);
  assert.deepEqual(quartas, [1, 8, 15, 22, 29]);
});

test('diasEsperadosRecorrente', async (t) => {
  await t.test('mensal retorna só o dia configurado', () => {
    assert.deepEqual(diasEsperadosRecorrente({ frequencia: 'mensal', dia: 14 }, 7, 2026), [14]);
  });
  await t.test('quinzenal retorna dia e dia+14', () => {
    assert.deepEqual(diasEsperadosRecorrente({ frequencia: 'quinzenal', dia: 4 }, 7, 2026), [4, 18]);
  });
  await t.test('semanal usa diasSemanaNoMes', () => {
    assert.deepEqual(diasEsperadosRecorrente({ frequencia: 'semanal', dia: 3 }, 7, 2026), [1, 8, 15, 22, 29]);
  });
  await t.test('achado 06/07/2026: recorrente com mesInicio no futuro não gera nada antes disso', () => {
    const r = { frequencia: 'mensal', dia: 11, mesInicio: 8, anoInicio: 2026 };
    assert.deepEqual(diasEsperadosRecorrente(r, 7, 2026), []); // julho: antes do início
    assert.deepEqual(diasEsperadosRecorrente(r, 8, 2026), [11]); // agosto: mês do início, gera normal
    assert.deepEqual(diasEsperadosRecorrente(r, 9, 2026), [11]); // setembro: depois, gera normal
  });
  await t.test('recorrente sem mesInicio/anoInicio (antiga) não tem gate', () => {
    assert.deepEqual(diasEsperadosRecorrente({ frequencia: 'mensal', dia: 14 }, 1, 2020), [14]);
  });
});

test('diasFaltantesRecorrente', async (t) => {
  const r = { id: 'rec1', categoria: 'Moradia', frequencia: 'mensal', dia: 10 };
  await t.test('dia já lançado (por recorrenteId) não aparece como faltante', () => {
    const despesas = [{ recorrenteId: 'rec1', data: '2026-07-10' }];
    assert.deepEqual(diasFaltantesRecorrente(r, despesas, 7, 2026), []);
  });
  await t.test('dia ainda não lançado aparece como faltante', () => {
    assert.deepEqual(diasFaltantesRecorrente(r, [], 7, 2026), [10]);
  });
  await t.test('fallback por categoria (lançamento manual antigo sem recorrenteId)', () => {
    const despesas = [{ categoria: 'Moradia', data: '2026-07-10' }];
    assert.deepEqual(diasFaltantesRecorrente(r, despesas, 7, 2026), []);
  });
});

test('fixas puladas (localStorage)', async (t) => {
  await t.test('chaveFixaPulada monta a chave esperada', () => {
    assert.equal(chaveFixaPulada('rec1', 2026, 8, 11), 'rec1_2026-08-11');
  });
  await t.test('addFixaPulada persiste e getFixasPuladas lê de volta', () => {
    localStorage.clear();
    addFixaPulada('rec1_2026-08-11');
    assert.deepEqual(getFixasPuladas(), ['rec1_2026-08-11']);
  });
  await t.test('achado 06/07/2026: pular um mês futuro não é descartado na hora', () => {
    localStorage.clear();
    const futuro = new Date(2027, 0, 1); // bem à frente de "hoje" real
    const chave = chaveFixaPulada('rec1', futuro.getFullYear(), futuro.getMonth() + 1, 5);
    addFixaPulada(chave);
    assert.ok(getFixasPuladas().includes(chave));
  });
  await t.test('poda só entradas de 2+ meses atrás', () => {
    localStorage.clear();
    const antiga = chaveFixaPulada('recX', 2020, 1, 1); // bem no passado
    localStorage.setItem('_fixasPuladas', JSON.stringify([antiga]));
    addFixaPulada('recY_2026-07-06');
    const atuais = getFixasPuladas();
    assert.ok(!atuais.includes(antiga));
    assert.ok(atuais.includes('recY_2026-07-06'));
  });
});

test('calcularAgregadosOrcamento', async (t) => {
  function periodo(despesas, receitas = [], extra = {}) {
    return { periodo: { mes: 7, ano: 2026 }, saldoConta: 2000, receitas, despesas, aportes: [], ...extra };
  }

  await t.test('despesa efetivada (data passada) entra em despesaCaixa e despesaComprometida', () => {
    const data = periodo([{ categoria: 'Moradia', valor: 500, data: '2026-07-01', cartao: false }]);
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.despesaCaixa, 500);
    assert.equal(r.despesaComprometida, 500);
    assert.equal(r.totalPendente, 0);
  });

  await t.test('despesa pendente (data futura, não-cartão) entra em despesaComprometida mas não em despesaCaixa', () => {
    const data = periodo([{ categoria: 'Saúde', valor: 300, data: '2026-07-20', cartao: false }]);
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.despesaCaixa, 0);
    assert.equal(r.totalPendente, 300);
    assert.equal(r.despesaComprometida, 300);
  });

  await t.test('fatura fechada aguardando pagamento entra em despesaComprometida (achado 06/07/2026) mas não em despesaCaixa', () => {
    const data = periodo([{ categoria: 'Transporte', valor: 400, data: '2026-07-01', cartao: true, cartaoId: 'c1', fatura: '2026-07', _faturaAberta: false }]);
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.despesaCaixa, 0);
    assert.equal(r.totalFaturas, 400);
    assert.equal(r.despesaComprometida, 400);
  });

  await t.test('item de fatura ABERTA nunca conta em nenhum dos dois totais', () => {
    const data = periodo([{ categoria: 'Transporte', valor: 999, data: '2026-07-05', cartao: true, cartaoId: 'c1', fatura: '2026-08', _faturaAberta: true }]);
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.despesaCaixa, 0);
    assert.equal(r.despesaComprometida, 0);
  });

  await t.test('fatura fechada e paga entra em despesaCaixa (via totalCartaoCaixa) e em despesaComprometida', () => {
    const data = periodo([{ categoria: 'Transporte', valor: 250, data: '2026-07-01', cartao: true, cartaoId: 'c1', fatura: '2026-07', _faturaAberta: false }]);
    const faturaEstados = { 'c1_2026-07': { estado: 'paga_total' } };
    const r = calcularAgregadosOrcamento({ data, faturaEstados, agora: HOJE });
    assert.equal(r.despesaCaixa, 250);
    assert.equal(r.totalFaturas, 0);
    assert.equal(r.despesaComprometida, 250);
  });

  await t.test('receitaComprometida inclui receita pendente (data futura), diferente de totalReceita', () => {
    const data = periodo([], [
      { categoria: 'Salário', valor: 3000, data: '2026-07-05' },
      { categoria: 'Bônus', valor: 500, data: '2026-07-25' }, // depois de HOJE (06/07)
    ]);
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.totalReceita, 3000); // exclui a pendente
    assert.equal(r.receitaComprometida, 3500); // inclui as duas
  });

  await t.test('despesa fixa em conta ainda não lançada entra como fixaVirtual em despesaComprometida', () => {
    const data = periodo([]);
    const recorrentes = [{ id: 'r1', ativo: true, cartao: false, categoria: 'Assinaturas', valor: 60, dia: 20, frequencia: 'mensal' }];
    const r = calcularAgregadosOrcamento({ data, recorrentes, agora: HOJE });
    assert.equal(r.totalFixasVirtuais, 60);
    assert.equal(r.despesaComprometida, 60);
    assert.equal(r.despesaCaixa, 0);
  });

  await t.test('recorrente pulada neste mês não gera fixaVirtual', () => {
    localStorage.clear();
    const chave = chaveFixaPulada('r1', 2026, 7, 20);
    addFixaPulada(chave);
    const data = periodo([]);
    const recorrentes = [{ id: 'r1', ativo: true, cartao: false, categoria: 'Assinaturas', valor: 60, dia: 20, frequencia: 'mensal' }];
    const r = calcularAgregadosOrcamento({ data, recorrentes, agora: HOJE });
    assert.equal(r.totalFixasVirtuais, 0);
  });

  await t.test('achado 06/07/2026: mês futuro conta tudo como caixa (sem distinção pendente)', () => {
    const data = { periodo: { mes: 12, ano: 2026 }, saldoConta: 0, receitas: [], despesas: [{ categoria: 'X', valor: 100, data: '2026-12-20', cartao: false }], aportes: [] };
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.ehFuturo, true);
    assert.equal(r.despesaCaixa, 100); // conta mesmo sendo "pendente" por data
    assert.equal(r.totalPendente, 100); // ainda aparece como pendente na lista, mas já soma no caixa
  });

  await t.test('sobra e saldoFinal batem com a fórmula saldo + receita - despesa - aporte', () => {
    const data = periodo(
      [{ categoria: 'Moradia', valor: 500, data: '2026-07-01', cartao: false }],
      [{ categoria: 'Salário', valor: 3000, data: '2026-07-05' }],
      { aportes: [{ valor: 200 }] }
    );
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.totalReceita, 3000);
    assert.equal(r.despesaCaixa, 500);
    assert.equal(r.sobra, 2000 + 3000 - 500);
    assert.equal(r.saldoFinal, r.sobra - 200);
  });

  await t.test('diffNaoIdentificadoMes fica ~0 quando não há discrepância', () => {
    const data = periodo([{ categoria: 'Moradia', valor: 500, data: '2026-07-01', cartao: false }]);
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.ok(Math.abs(r.diffNaoIdentificadoMes) < 1);
  });

  await t.test('diffNaoIdentificadoMes é 0 em mês futuro', () => {
    const data = { periodo: { mes: 12, ano: 2026 }, saldoConta: 0, receitas: [], despesas: [], aportes: [] };
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.diffNaoIdentificadoMes, 0);
  });
});

test('calcularAjuste', async (t) => {
  await t.test('sem diferença relevante não tem ajuste', () => {
    const { temAjuste } = calcularAjuste(0.5);
    assert.equal(temAjuste, false);
  });
  await t.test('com diferença relevante, valorAjuste é o inverso do diff', () => {
    const { temAjuste, valorAjuste } = calcularAjuste(-100);
    assert.equal(temAjuste, true);
    assert.equal(valorAjuste, 100);
  });
  await t.test('desconta o que já foi explicado por outra decomposição (ex: fixas virtuais)', () => {
    const { valorAjuste } = calcularAjuste(-1000, 300);
    assert.equal(valorAjuste, 700); // -(-1000) - 300
  });
  await t.test('CATEGORIA_AJUSTE é a mesma string usada em Detalhe e Planejamento', () => {
    assert.equal(CATEGORIA_AJUSTE, 'Lançamentos não identificados — verificar');
  });
});
