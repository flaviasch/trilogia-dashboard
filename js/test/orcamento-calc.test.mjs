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
  calcularNaoPlanejado,
  pertenceAConta,
  CONTA_PRINCIPAL_ID,
  CATEGORIA_AJUSTE,
} from '../orcamento-calc.js';

const HOJE = new Date(2026, 6, 6); // 2026-07-06 (mesma data usada na sessão)

test('isPendenteEfetivo', async (t) => {
  await t.test('data futura é pendente', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-10' }, HOJE), true);
  });
  await t.test('data de hoje é pendente até ser confirmada (achado 09/07/2026)', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-06' }, HOJE), true);
  });
  await t.test('data de hoje confirmada não é mais pendente', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-06', confirmado: true }, HOJE), false);
  });
  await t.test('data futura confirmada não é mais pendente', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-10', confirmado: true }, HOJE), false);
  });
  await t.test('fallback legado (sem flag pendente): data passada não é pendente — usado por importação de extrato/fatura', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-01' }, HOJE), false);
  });
  await t.test('marcado explicitamente pendente: continua pendente mesmo com data passada (achado 13/07/2026 — sem prazo de validade)', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-01', pendente: true }, HOJE), true);
  });
  await t.test('marcado explicitamente pendente, mas confirmado: não é mais pendente', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-01', pendente: true, confirmado: true }, HOJE), false);
  });
  await t.test('sem data não é pendente', () => {
    assert.equal(isPendenteEfetivo({ data: '' }, HOJE), false);
  });
  await t.test('despesa fixa direta na conta (recorrenteId, sem cartao) é sempre pendente, mesmo sem flag e com data passada (achado 20/07/2026)', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-01', recorrenteId: 'r1', cartao: false }, HOJE), true);
  });
  await t.test('despesa fixa de cartão (recorrenteId, com cartao) NÃO entra na regra acima — segue o fallback por data', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-01', recorrenteId: 'r1', cartao: true }, HOJE), false);
  });
  await t.test('despesa fixa direta na conta confirmada não é mais pendente, mesmo com recorrenteId', () => {
    assert.equal(isPendenteEfetivo({ data: '2026-07-01', recorrenteId: 'r1', cartao: false, confirmado: true }, HOJE), false);
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

  await t.test('achado 09/07/2026: receita datada de HOJE não sensibiliza o caixa sem confirmar', () => {
    const data = periodo([], [{ categoria: 'Salário', valor: 5000, data: '2026-07-06' }]); // HOJE = 2026-07-06
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.totalReceita, 0, 'não deveria entrar em caixa sem confirmar');
    assert.equal(r.totalReceitaPendente, 5000);
    assert.equal(r.receitaComprometida, 5000, 'comprometido (Planejamento/Score/home) continua contando o mês inteiro');
  });

  await t.test('achado 09/07/2026: despesa datada de HOJE também precisa de confirmação (regra simétrica)', () => {
    const data = periodo([{ categoria: 'Mercado', valor: 200, data: '2026-07-06' }]); // HOJE = 2026-07-06
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.despesaCaixa, 0);
    assert.equal(r.totalPendente, 200);
    assert.equal(r.despesaComprometida, 200);
  });

  await t.test('receita de hoje CONFIRMADA sensibiliza o caixa normalmente', () => {
    const data = periodo([], [{ categoria: 'Salário', valor: 5000, data: '2026-07-06', confirmado: true }]);
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.totalReceita, 5000);
    assert.equal(r.totalReceitaPendente, 0);
  });

  await t.test('receita de ONTEM (data passada) continua entrando sozinha, sem precisar confirmar', () => {
    const data = periodo([], [{ categoria: 'Salário', valor: 5000, data: '2026-07-05' }]); // 1 dia antes de HOJE
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.totalReceita, 5000);
    assert.equal(r.totalReceitaPendente, 0);
  });

  await t.test('fatura fechada aguardando pagamento entra em despesaComprometida (achado 06/07/2026) mas não em despesaCaixa', () => {
    const data = periodo([{ categoria: 'Transporte', valor: 400, data: '2026-07-01', cartao: true, cartaoId: 'c1', fatura: '2026-07', _faturaAberta: false }]);
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.despesaCaixa, 0);
    assert.equal(r.totalFaturas, 400);
    assert.equal(r.despesaComprometida, 400);
  });

  await t.test('achado 15/07/2026: estorno de compra vinculado à fatura desconta do total a pagar', () => {
    const despesas = [{ categoria: 'Compras', valor: 400, data: '2026-07-01', cartao: true, cartaoId: 'c1', fatura: '2026-07', _faturaAberta: false }];
    const receitas = [{ categoria: 'Restituição / Estorno', valor: 150, data: '2026-07-05', cartao: true, cartaoId: 'c1', fatura: '2026-07', _faturaAberta: false }];
    const data = periodo(despesas, receitas);
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.totalFaturas, 250, 'fatura a vencer deve descontar o estorno vinculado');
    assert.equal(r.despesaComprometida, 250);
  });

  await t.test('item de fatura ABERTA nunca conta em despesaCaixa/despesaComprometida no mês da COMPRA', () => {
    const data = periodo([{ categoria: 'Transporte', valor: 999, data: '2026-07-05', cartao: true, cartaoId: 'c1', fatura: '2026-08', _faturaAberta: true }]);
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.despesaCaixa, 0);
    assert.equal(r.despesaComprometida, 0);
  });

  await t.test('item de fatura ABERTA conta em totalComprometidoMes no mês em que vai DEBITAR, mesmo antes do ciclo fechar (achado 09/08/2026)', () => {
    // Vendo agosto (mês em que a fatura vai debitar) enquanto o ciclo ainda
    // está em curso — Flávia: "elas tb não aparecem em setembro, e DEVEM
    // APARECER". totalComprometidoMes é o que Planejamento/Detalhe usam pra
    // decidir se o item aparece na categoria daquele mês.
    const dataAgosto = periodo(
      [{ categoria: 'Transporte', valor: 999, data: '2026-07-05', cartao: true, cartaoId: 'c1', fatura: '2026-08', _faturaAberta: true }],
      [], { periodo: { mes: 8, ano: 2026 } }
    );
    const rAgosto = calcularAgregadosOrcamento({ data: dataAgosto, agora: HOJE });
    assert.equal(rAgosto.totalComprometidoMes, 999);

    // Vendo julho (mês da compra, não o de pagamento) — continua de fora.
    const dataJulho = periodo([{ categoria: 'Transporte', valor: 999, data: '2026-07-05', cartao: true, cartaoId: 'c1', fatura: '2026-08', _faturaAberta: true }]);
    const rJulho = calcularAgregadosOrcamento({ data: dataJulho, agora: HOJE });
    assert.equal(rJulho.totalComprometidoMes, 0);
  });

  await t.test('fatura fechada e paga entra em despesaCaixa (via totalCartaoCaixa) e em despesaComprometida', () => {
    const data = periodo([{ categoria: 'Transporte', valor: 250, data: '2026-07-01', cartao: true, cartaoId: 'c1', fatura: '2026-07', _faturaAberta: false }]);
    const faturaEstados = { 'c1_2026-07': { estado: 'paga_total' } };
    const r = calcularAgregadosOrcamento({ data, faturaEstados, agora: HOJE });
    assert.equal(r.despesaCaixa, 250);
    assert.equal(r.totalFaturas, 0);
    assert.equal(r.despesaComprometida, 250);
  });

  await t.test('achado 29/07/2026: despesa de "pagamento adiantado de fatura" (origem:antecipacao_fatura, sem cartao/fatura) conta como despesa comum, não é excluída nem contada em dobro', () => {
    // Pagamento antecipado de fatura AINDA ABERTA (Dashboard PF) é modelado
    // como despesa comum (sem as flags cartao/fatura) de propósito, pra não
    // precisar de nenhuma mudança neste módulo — ver abrirModalAntecipacaoFatura
    // em orcamento.html. Este teste prova que essa escolha de desenho não
    // introduziu nenhum caminho especial: o item entra em despesaCaixa e
    // despesaComprometida exatamente como qualquer despesa avulsa, mesmo
    // tendo cartaoId/faturaAlvo como metadado (esses campos são ignorados
    // por este módulo, que só reage a `cartao`/`fatura`).
    const data = periodo([{
      categoria: 'Cartão de crédito', valor: 500, data: '2026-07-05',
      origem: 'antecipacao_fatura', cartaoId: 'c1', faturaAlvo: '2026-08',
    }]);
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.despesaCaixa, 500);
    assert.equal(r.despesaComprometida, 500);
    assert.equal(r.totalFaturas, 0);
    assert.equal(r.totalCartaoPago, 0);
  });

  await t.test('achado 09/07/2026: fatura SEM lançamento (só ajusteTotal) marcada como paga sensibiliza o caixa', () => {
    // Fatura confirmada só via "Ajustar fatura" (sem nenhuma despesa individual
    // lançada pra ela) — antes do fix, o backfill pulava chaves já paga_total,
    // e a fatura sumia do cálculo inteiro assim que confirmada como paga.
    const data = periodo([]); // nenhuma despesa de cartão lançada
    const cartoes = [{ id: 'c1', ativo: true }];
    const faturaEstados = { 'c1_2026-07': { estado: 'paga_total', ajusteTotal: 9892 } };
    const r = calcularAgregadosOrcamento({ data, cartoes, faturaEstados, agora: HOJE });
    assert.equal(r.despesaCaixa, 9892, 'a fatura paga precisa sensibilizar o caixa mesmo sem despesa individual');
    assert.equal(r.totalCartaoPago, 9892);
    assert.equal(r.totalFaturas, 0);
  });

  await t.test('fatura SEM lançamento, ainda NÃO paga, continua em "a vencer" (totalFaturas)', () => {
    const data = periodo([]);
    const cartoes = [{ id: 'c1', ativo: true }];
    const faturaEstados = { 'c1_2026-07': { ajusteTotal: 500 } }; // sem estado = ainda não paga
    const r = calcularAgregadosOrcamento({ data, cartoes, faturaEstados, agora: HOJE });
    assert.equal(r.totalFaturas, 500);
    assert.equal(r.totalCartaoPago, 0);
    assert.equal(r.despesaCaixa, 0);
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

  await t.test('achado 22/07/2026: recorrente de receita fixa (tipo:\'receita\') não vira fixaVirtual de despesa', () => {
    const data = periodo([]);
    const recorrentes = [
      { id: 'r1', ativo: true, cartao: false, categoria: 'Salário', valor: 21800, dia: 10, frequencia: 'mensal', tipo: 'receita' },
      { id: 'r2', ativo: true, cartao: false, categoria: 'Assinaturas', valor: 60, dia: 20, frequencia: 'mensal', tipo: 'despesa' },
      { id: 'r3', ativo: true, cartao: false, categoria: 'Aluguel', valor: 1500, dia: 5, frequencia: 'mensal' }, // sem tipo (legado) = despesa
    ];
    const r = calcularAgregadosOrcamento({ data, recorrentes, agora: HOJE });
    // Só as duas de despesa (r2 + r3) entram em fixasVirtuais — a receita (r1)
    // fica de fora dali, mas entra em fixasVirtuaisReceita (achado 23/07/2026:
    // igualada à despesa fixa, projeta sozinha nos meses futuros).
    assert.equal(r.totalFixasVirtuais, 60 + 1500);
    assert.ok(!r.fixasVirtuais.some(v => v.recorrenteId === 'r1'));
    assert.equal(r.totalFixasVirtuaisReceita, 21800);
    assert.ok(r.fixasVirtuaisReceita.some(v => v.recorrenteId === 'r1'));
    assert.ok(!r.fixasVirtuaisReceita.some(v => v.recorrenteId === 'r2' || v.recorrenteId === 'r3'));
  });

  await t.test('achado 23/07/2026: receita fixa já lançada neste mês (recorrenteId em data.receitas) não duplica em fixasVirtuaisReceita', () => {
    const data = periodo([], [{ recorrenteId: 'r1', categoria: 'Salário', valor: 21800, data: '2026-07-10', pendente: true }]);
    const recorrentes = [{ id: 'r1', ativo: true, cartao: false, categoria: 'Salário', valor: 21800, dia: 10, frequencia: 'mensal', tipo: 'receita' }];
    const r = calcularAgregadosOrcamento({ data, recorrentes, agora: HOJE });
    assert.equal(r.totalFixasVirtuaisReceita, 0);
    assert.equal(r.totalReceitaPendente, 21800, 'já entra como receita pendente de verdade, não mais como virtual');
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

  // Fase C de múltiplas contas correntes: filtro opcional por contaId.
  await t.test('NÃO-REGRESSÃO: sem contaId, itens com contaId variado somam tudo igual a antes desse parâmetro existir', () => {
    const data = periodo([
      { categoria: 'Moradia', valor: 500, data: '2026-07-01', cartao: false },
      { categoria: 'Lazer', valor: 200, data: '2026-07-01', cartao: false, contaId: 'principal' },
      { categoria: 'Mercado', valor: 300, data: '2026-07-01', cartao: false, contaId: 'conta-secundaria' },
    ]);
    const semFiltro = calcularAgregadosOrcamento({ data, agora: HOJE });
    const semNenhumContaId = calcularAgregadosOrcamento({
      data: periodo([{ categoria: 'X', valor: 1000, data: '2026-07-01', cartao: false }]),
      agora: HOJE,
    });
    assert.equal(semFiltro.despesaCaixa, 1000, 'consolida despesas de todas as contas, mesmo as sem contaId');
    assert.equal(semNenhumContaId.despesaCaixa, 1000, 'baseline idêntico ao comportamento anterior à Fase C');
  });

  await t.test('com contaId, só entram itens dessa conta — item sem contaId conta como "principal"', () => {
    const data = periodo([
      { categoria: 'Moradia', valor: 500, data: '2026-07-01', cartao: false }, // sem contaId = principal
      { categoria: 'Lazer', valor: 200, data: '2026-07-01', cartao: false, contaId: 'principal' },
      { categoria: 'Mercado', valor: 300, data: '2026-07-01', cartao: false, contaId: 'conta-secundaria' },
    ]);
    const principal = calcularAgregadosOrcamento({ data, agora: HOJE, contaId: 'principal' });
    const secundaria = calcularAgregadosOrcamento({ data, agora: HOJE, contaId: 'conta-secundaria' });
    assert.equal(principal.despesaCaixa, 700);
    assert.equal(secundaria.despesaCaixa, 300);
  });

  await t.test('fatura de outra conta não vaza total via ajusteTotal de faturaEstados (contaId vem do pagamento, não do cartão)', () => {
    // Cartão não carrega contaId (não existe mais vínculo fixo cartão→conta) —
    // quem define a conta é o campo contaId gravado em faturaEstados no
    // momento da confirmação de pagamento (ou do ajuste manual).
    const data = periodo([]);
    const cartoes = [
      { id: 'c-principal', ativo: true },
      { id: 'c-secundaria', ativo: true },
    ];
    const faturaEstados = {
      'c-principal_2026-07': { ajusteTotal: 400 }, // sem contaId = principal
      'c-secundaria_2026-07': { ajusteTotal: 900, contaId: 'conta-secundaria' },
    };
    const principal = calcularAgregadosOrcamento({ data, cartoes, faturaEstados, agora: HOJE, contaId: 'principal' });
    const secundaria = calcularAgregadosOrcamento({ data, cartoes, faturaEstados, agora: HOJE, contaId: 'conta-secundaria' });
    assert.equal(principal.totalFaturas, 400, 'não deve incluir o ajuste de 900 da conta secundária');
    assert.equal(secundaria.totalFaturas, 900, 'inclui só o ajuste da própria conta');
  });

  await t.test('despesa de cartão usa a conta gravada no pagamento da fatura, não a conta do item', () => {
    const data = periodo([
      { categoria: 'Mercado', valor: 300, data: '2026-07-05', cartao: true, cartaoId: 'c1', fatura: '2026-07' },
    ]);
    const cartoes = [{ id: 'c1', ativo: true }];
    const faturaEstados = { 'c1_2026-07': { estado: 'paga_total', contaId: 'conta-secundaria' } };
    const principal   = calcularAgregadosOrcamento({ data, cartoes, faturaEstados, agora: HOJE, contaId: 'principal' });
    const secundaria  = calcularAgregadosOrcamento({ data, cartoes, faturaEstados, agora: HOJE, contaId: 'conta-secundaria' });
    assert.equal(principal.totalCartaoPago, 0, 'fatura paga por outra conta não aparece na principal');
    assert.equal(secundaria.totalCartaoPago, 300, 'fatura paga pela conta secundária aparece nela');
  });

  await t.test('fatura ainda não paga (sem contaId no faturaEstados) cai em principal por padrão', () => {
    const data = periodo([
      { categoria: 'Mercado', valor: 500, data: '2026-07-05', cartao: true, cartaoId: 'c1', fatura: '2026-07' },
    ]);
    const cartoes = [{ id: 'c1', ativo: true }];
    const principal  = calcularAgregadosOrcamento({ data, cartoes, faturaEstados: {}, agora: HOJE, contaId: 'principal' });
    const secundaria = calcularAgregadosOrcamento({ data, cartoes, faturaEstados: {}, agora: HOJE, contaId: 'conta-secundaria' });
    assert.equal(principal.totalFaturas, 500, 'fatura a vencer sem pagamento aparece na principal por padrão');
    assert.equal(secundaria.totalFaturas, 0, 'não aparece na secundária até ser paga por ela');
  });

  // Transferência entre contas (achado 27/07/2026): duas pernas ligadas por
  // transferenciaId, cada uma com sua própria contaId e direcao.
  await t.test('transferência: sem contaId (consolidado), líquido das duas pernas é zero e não muda saldoFinal', () => {
    const data = periodo([{ categoria: 'Moradia', valor: 500, data: '2026-07-01', cartao: false }], [], {
      transferencias: [
        { transferenciaId: 't1', direcao: 'saida',   valor: 300, contaId: 'principal' },
        { transferenciaId: 't1', direcao: 'entrada', valor: 300, contaId: 'conta-secundaria' },
      ],
    });
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.totalTransferenciaLiquida, 0, 'as duas pernas se cancelam no consolidado');
    assert.equal(r.saldoFinal, r.sobra, 'saldoFinal consolidado não muda com transferência entre contas próprias');
  });

  await t.test('transferência: saldo da conta origem cai, saldo da conta destino sobe', () => {
    const data = periodo([], [], {
      saldoConta: 1000,
      transferencias: [
        { transferenciaId: 't1', direcao: 'saida',   valor: 300, contaId: 'principal' },
        { transferenciaId: 't1', direcao: 'entrada', valor: 300, contaId: 'conta-secundaria' },
      ],
    });
    const origem  = calcularAgregadosOrcamento({ data, agora: HOJE, contaId: 'principal' });
    const destino = calcularAgregadosOrcamento({ data: { ...data, saldoConta: 0 }, agora: HOJE, contaId: 'conta-secundaria' });
    assert.equal(origem.totalTransferenciaLiquida, -300);
    assert.equal(destino.totalTransferenciaLiquida, 300);
    assert.equal(origem.saldoFinal, origem.sobra - 300);
    assert.equal(destino.saldoFinal, destino.sobra + 300);
  });

  await t.test('transferência NÃO entra em totalReceita, despesaCaixa nem despesaComprometida', () => {
    const data = periodo([{ categoria: 'Moradia', valor: 500, data: '2026-07-01', cartao: false }],
      [{ categoria: 'Salário', valor: 3000, data: '2026-07-05' }], {
      transferencias: [
        { transferenciaId: 't1', direcao: 'saida',   valor: 700, contaId: 'principal' },
        { transferenciaId: 't1', direcao: 'entrada', valor: 700, contaId: 'conta-secundaria' },
      ],
    });
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.totalReceita, 3000, 'transferência não é receita');
    assert.equal(r.despesaCaixa, 500, 'transferência não é despesa de caixa');
    assert.equal(r.despesaComprometida, 500, 'transferência não é despesa comprometida');
  });

  await t.test('NÃO-REGRESSÃO: sem transferencias, saldoFinal continua igual a antes desse campo existir', () => {
    const data = periodo([{ categoria: 'Moradia', valor: 500, data: '2026-07-01', cartao: false }],
      [{ categoria: 'Salário', valor: 3000, data: '2026-07-05' }]);
    const r = calcularAgregadosOrcamento({ data, agora: HOJE });
    assert.equal(r.totalTransferenciaLiquida, 0);
    assert.equal(r.saldoFinal, r.sobra - r.totalAp);
  });

  await t.test('achado 23/07/2026: fatura futura (ainda não aberta) não entra em totalFaturas nem gruposFechadaCaixa', () => {
    // HOJE = 2026-07-06. Cartão diaCorte=2, diaVencimento=10: dia 6 > corte 2
    // → mês+1 (agosto); vencimento(10) > corte(2) → sem incremento extra.
    // openKey do cartão hoje = "2026-08".
    const data = periodo([
      { categoria: 'Assinatura', valor: 100, data: '2026-07-04', cartao: true, cartaoId: 'c1', fatura: '2026-09' }, // futura — ainda nem abriu
      { categoria: 'Mercado', valor: 500, data: '2026-07-05', cartao: true, cartaoId: 'c1', fatura: '2026-07' }, // já fechada
    ]);
    const cartoes = [{ id: 'c1', ativo: true, diaCorte: 2, diaVencimento: 10 }];
    const r = calcularAgregadosOrcamento({ data, cartoes, agora: HOJE });
    assert.equal(r.totalFaturas, 500, 'só a fatura já fechada (2026-07) conta — a futura (2026-09) fica de fora');
    assert.ok(!('c1_2026-09' in r.gruposFechadaCaixa), 'fatura futura não deveria nem entrar em gruposFechadaCaixa');
    assert.ok('c1_2026-07' in r.gruposFechadaCaixa);
  });

  await t.test('achado 23/07/2026: backfill de faturaEstados só entra com ajusteTotal — sem isso, fatura do próprio mês some (não vira card fantasma de R$0)', () => {
    const data = periodo([]); // mês sem nenhum item de cartão, período 2026-07 (default do helper)
    const cartoes = [{ id: 'c1', ativo: true }];
    const faturaEstados = {
      'c1_2026-07': { estado: 'paga_total', valorPago: 100 }, // sem ajusteTotal, é do próprio mês calculado
    };
    const r = calcularAgregadosOrcamento({ data, cartoes, faturaEstados, agora: HOJE });
    assert.ok(!('c1_2026-07' in r.gruposFechadaCaixa), 'sem ajusteTotal, não deve ser reinserida mesmo sendo do próprio mês, se não tem lançamento nenhum');
  });

  await t.test('achado 03/08/2026: ajusteTotal só entra no mês nativo da fatura — não vaza pros meses seguintes', () => {
    // Antes, o backfill só checava "_faturaJaAbriu" (ciclo já começou em
    // relação a hoje), o que é sempre verdadeiro pra qualquer mês passado —
    // um ajuste resolvido em julho continuava reaparecendo em agosto,
    // setembro etc. pra sempre, inflando "Lançamentos não identificados" e
    // Despesas totais desses meses.
    const dataJulho  = periodo([], [], { periodo: { mes: 7, ano: 2026 } });
    const dataAgosto = periodo([], [], { periodo: { mes: 8, ano: 2026 } });
    const cartoes = [{ id: 'c1', ativo: true }];
    const faturaEstados = {
      'c1_2026-07': { estado: 'paga_total', valorPago: 9892, ajusteTotal: 9892 }, // resolvida em julho
    };
    const julho  = calcularAgregadosOrcamento({ data: dataJulho, cartoes, faturaEstados, agora: HOJE });
    const agosto = calcularAgregadosOrcamento({ data: dataAgosto, cartoes, faturaEstados, agora: HOJE });
    assert.ok('c1_2026-07' in julho.gruposFechadaCaixa, 'no mês da própria fatura, continua aparecendo (comportamento de 09/07/2026)');
    assert.equal(julho.totalCartaoPago, 9892);
    assert.ok(!('c1_2026-07' in agosto.gruposFechadaCaixa), 'mês seguinte não deve herdar o ajuste de julho');
    assert.equal(agosto.totalCartaoPago, 0, 'agosto não pode ficar inflado pelo ajuste de julho já resolvido');
  });
});

test('pertenceAConta', async (t) => {
  await t.test('sem contaId de filtro (null/undefined), sempre pertence — visão consolidada', () => {
    assert.equal(pertenceAConta({ contaId: 'x' }, null), true);
    assert.equal(pertenceAConta({}, undefined), true);
  });

  await t.test('item sem contaId conta como a conta principal', () => {
    assert.equal(pertenceAConta({}, CONTA_PRINCIPAL_ID), true);
    assert.equal(pertenceAConta({}, 'outra-conta'), false);
  });

  await t.test('item com contaId explícito só bate com o mesmo filtro', () => {
    assert.equal(pertenceAConta({ contaId: 'conta-a' }, 'conta-a'), true);
    assert.equal(pertenceAConta({ contaId: 'conta-a' }, 'conta-b'), false);
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

test('calcularNaoPlanejado', async (t) => {
  await t.test('sem renda/percentual definidos, totalPlanejado e folga são null', () => {
    const r = calcularNaoPlanejado({ categorias: [{ nome: 'Moradia', limite: 2000 }] });
    assert.equal(r.temMeta, false);
    assert.equal(r.totalPlanejado, null);
    assert.equal(r.folga, null);
    assert.equal(r.sobreAlocado, false);
  });

  await t.test('folga = total planejado - soma dos limites das categorias', () => {
    const r = calcularNaoPlanejado({
      renda: 10000, percentual: 70,
      categorias: [{ nome: 'Moradia', limite: 4000 }, { nome: 'Alimentação', limite: 2000 }],
    });
    assert.equal(r.totalPlanejado, 7000);
    assert.equal(r.somaLimites, 6000);
    assert.equal(r.folga, 1000);
    assert.equal(r.sobreAlocado, false);
  });

  await t.test('soma de limites acima do planejado: folga clampa em 0 e sinaliza sobreAlocado', () => {
    const r = calcularNaoPlanejado({
      renda: 10000, percentual: 70,
      categorias: [{ nome: 'Moradia', limite: 5000 }, { nome: 'Alimentação', limite: 3000 }],
    });
    assert.equal(r.totalPlanejado, 7000);
    assert.equal(r.somaLimites, 8000);
    assert.equal(r.folga, 0);
    assert.equal(r.sobreAlocado, true);
  });
});
