/**
 * orcamento-calc.js — cálculo de orçamento compartilhado entre orcamento.html
 * e index.html (e qualquer outra página que precise dos mesmos totais).
 *
 * Extraído em 07/07/2026: antes desse módulo, cada página tinha sua própria
 * cópia (às vezes simplificada, às vezes divergente) da lógica de pendente,
 * fatura, despesas fixas ainda não lançadas e reconciliação de caixa —
 * causa raiz de vários bugs de inconsistência corrigidos em 06-07/07/2026
 * (Detalhe x Planejamento x home batendo valores diferentes).
 *
 * Funções puras — nenhuma lê estado de módulo ou toca o DOM. `localStorage`
 * só é lido/escrito pelas funções de "fixas puladas" (getFixasPuladas/
 * addFixaPulada), que são as únicas com efeito colateral aqui.
 */

// ─── Categoria de ajuste usada quando sobra uma diferença não identificada ───
export const CATEGORIA_AJUSTE = 'Lançamentos não identificados — verificar';

// ─── Helpers de data/recorrência ──────────────────────────────────────────────

/**
 * Um lançamento é "pendente" (não sensibiliza o caixa ainda) enquanto não for
 * confirmado manualmente. Dois critérios, nessa ordem:
 *
 * 1. `item.pendente === true` — marcado explicitamente no momento em que o
 *    item nasceu como algo agendado/projetado (lançamento manual com data
 *    futura, ou fixa recorrente materializada) — fica pendente PARA SEMPRE,
 *    a data passar não resolve sozinho (achado 13/07/2026: a versão anterior
 *    deixava isso virar caixa automaticamente no dia seguinte à data, sem a
 *    usuária confirmar — ela quer confirmação explícita sempre, sem prazo de
 *    validade). Só existe até a usuária confirmar (que apaga esse campo) ou
 *    excluir o item.
 *
 * 2. Despesa fixa direta na conta (não cartão) — SEMPRE pendente até
 *    confirmação manual, mesmo sem o campo `pendente` explícito (item
 *    antigo/legado). Regra do produto (Flávia, achado 20/07/2026): "despesa
 *    direta na conta sempre como pendente para ser confirmada manualmente",
 *    sem exceção por data já ter passado — nunca cai no fallback por data
 *    abaixo. Identificada por ter `recorrenteId` (é uma ocorrência de
 *    despesa fixa) e não ser de cartão.
 *
 * 3. Fallback por data (comportamento legado, achado 09/07/2026) — para
 *    itens de antes dessa marcação existir (sem `pendente` explícito, ex.
 *    já materializados em produção): hoje ou futuro = pendente; passado =
 *    já aconteceu. Também é o que rege importação de extrato/fatura, que
 *    nunca marca `pendente` (é histórico, não precisa confirmação).
 */
export function isPendenteEfetivo(item, agora = new Date()) {
  if (item.confirmado) return false;
  if (!item.data) return false;
  if (item.pendente) return true;
  if (item.recorrenteId && !item.cartao) return true;
  const hoje = new Date(agora); hoje.setHours(0, 0, 0, 0);
  return new Date(item.data + 'T00:00:00') >= hoje;
}

/**
 * Chave normalizada de categoria (minúscula, sem acento) — usada só pra
 * AGRUPAR/COMPARAR categorias na tela. Nunca reescreve o texto já salvo.
 */
export function normCat(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

export function diasSemanaNoMes(ano, mes, diaSemana) {
  const dias = [];
  const total = new Date(ano, mes, 0).getDate();
  for (let d = 1; d <= total; d++) {
    if (new Date(ano, mes - 1, d).getDay() === diaSemana) dias.push(d);
  }
  return dias;
}

/**
 * Dias do mês em que uma recorrente deveria ter um lançamento, conforme a
 * frequência — semanal/quinzenal têm mais de um por mês, diferente de mensal.
 * Recorrentes antigas (sem mesInicio/anoInicio) não têm gate. Recorrentes
 * novas só valem a partir do mês em que foram criadas — meses anteriores a
 * isso não geram ocorrência nenhuma (achado em 06/07/2026: uma despesa fixa
 * criada "a partir de agosto" aparecia também em julho).
 */
export function diasEsperadosRecorrente(r, mes, ano) {
  if (r.anoInicio != null && r.mesInicio != null) {
    const antesDoInicio = ano < r.anoInicio || (ano === r.anoInicio && mes < r.mesInicio);
    if (antesDoInicio) return [];
  }
  const freq = r.frequencia || 'mensal';
  if (freq === 'semanal')   return diasSemanaNoMes(ano, mes, r.dia);
  if (freq === 'quinzenal') return [r.dia, r.dia + 14].filter(d => d >= 1 && d <= 31);
  return [r.dia];
}

/**
 * Dias esperados que ainda não têm lançamento no mês — cobre tanto itens já
 * linkados por recorrenteId quanto lançamentos manuais antigos sem o vínculo
 * (mesma categoria), pra não duplicar quando a recorrente foi criada antes
 * do backfill automático existir. Não usa valor no fallback: se o valor do
 * lançamento já existente foi editado à mão, ele deixaria de "casar" com
 * o valor atual do template e geraria um duplicado.
 */
export function diasFaltantesRecorrente(r, despesasArr, mes, ano) {
  const esperados = diasEsperadosRecorrente(r, mes, ano);
  const ocupados = new Set(
    (despesasArr || [])
      .filter(d => d.recorrenteId === r.id || (!d.recorrenteId && d.categoria === r.categoria))
      .map(d => parseInt((d.data || '').split('-')[2], 10))
      .filter(d => !isNaN(d))
  );
  return esperados.filter(d => !ocupados.has(d));
}

// ─── Despesas fixas puladas (localStorage) ────────────────────────────────────

export function chaveFixaPulada(recorrenteId, ano, mes, dia) {
  return `${recorrenteId}_${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

export function getFixasPuladas() {
  try { return JSON.parse(localStorage.getItem('_fixasPuladas') || '[]'); }
  catch (_) { return []; }
}

/**
 * Ignora uma ocorrência específica de despesa fixa em CONTA neste mês, sem
 * cancelar a recorrência (que continua valendo nos próximos meses).
 * Persistido em localStorage — não é dado da mentorada, só preferência de UI.
 */
export function addFixaPulada(chave) {
  const atuais = getFixasPuladas();
  if (!atuais.includes(chave)) atuais.push(chave);
  // Poda só entradas de meses BEM antigos (2+ meses atrás), sem limite pra
  // frente — despesas fixas podem ser puladas em meses futuros também
  // (achado em 06/07/2026).
  const hoje = new Date();
  const limiteAntigo = new Date(hoje.getFullYear(), hoje.getMonth() - 2, 1);
  const filtradas = atuais.filter(c => {
    const m = c.match(/_(\d{4})-(\d{2})-\d{2}$/);
    if (!m) return true;
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1);
    return d >= limiteAntigo;
  });
  localStorage.setItem('_fixasPuladas', JSON.stringify(filtradas));
  return filtradas;
}

// ─── Múltiplas contas ──────────────────────────────────────────────────────────

/** Id reservado da conta principal — implícito quando o item não tem `contaId`. */
export const CONTA_PRINCIPAL_ID = 'principal';

/**
 * Um item (despesa/receita/aporte/cartão) pertence à conta filtrada quando:
 * sem filtro (contaId null/undefined) → sempre true (visão consolidada);
 * com filtro → item.contaId (ou 'principal' se ausente) bate com o filtro.
 */
export function pertenceAConta(item, contaId) {
  if (contaId == null) return true;
  return (item.contaId || CONTA_PRINCIPAL_ID) === contaId;
}

// ─── Agregação principal ───────────────────────────────────────────────────────

/**
 * Calcula todos os totais de um período de orçamento (mês/ano). Mesmo
 * cálculo usado pelo Resumo, Detalhe, Planejamento, Score, Gráficos, Anual e
 * pela home — antes desse módulo cada tela tinha sua própria cópia.
 *
 * @param {object} args
 * @param {{periodo:{mes:number,ano:number}, saldoConta?:number, receitas:object[], despesas:object[], aportes?:object[], transferencias?:object[]}} args.data
 * @param {object[]} [args.cartoes] - lista de cartões ({ id, ativo, ... })
 * @param {object} [args.faturaEstados] - mapa "cartaoId_YYYY-MM" -> { estado, ajusteTotal, valorPago }
 * @param {object[]} [args.recorrentes] - lista de despesas fixas ({ id, ativo, cartao, categoria, valor, dia, frequencia, mesInicio, anoInicio })
 * @param {string[]} [args.fixasPuladas] - se omitido, lê getFixasPuladas() internamente
 * @param {Date} [args.agora] - injetável pra testes; default new Date()
 * @param {string|null} [args.contaId] - filtra por conta (via pertenceAConta);
 *   default null = consolidado, soma todas as contas (comportamento de sempre,
 *   inclusive pra dado antigo sem nenhum item com contaId).
 *
 * `data.transferencias` (achado 27/07/2026): itens `{ direcao: 'entrada'|'saida',
 * valor, contaId, ... }` — cada transferência entre contas próprias grava duas
 * pernas (uma de saída na origem, uma de entrada no destino). Entram no
 * `saldoFinal` da conta filtrada (líquido: entrada soma, saída subtrai), mas
 * NUNCA em totalReceita/despesaCaixa/despesaComprometida/categorias/Score —
 * mover dinheiro entre contas da própria usuária não é receita nem despesa
 * real. Na visão consolidada (contaId null) as duas pernas de toda
 * transferência se cancelam (soma líquida zero), preservando o saldo total.
 *
 * @returns {{
 *   ehFuturo: boolean, saldoConta: number, totalReceita: number,
 *   gruposFechadaCaixa: object, totalFaturas: number, totalCartaoPago: number, totalCartaoCaixa: number,
 *   despesasPendentes: object[], totalPendente: number,
 *   fixasVirtuais: object[], totalFixasVirtuais: number,
 *   fixasVirtuaisReceita: object[], totalFixasVirtuaisReceita: number,
 *   receitasPendentes: object[], totalReceitaPendente: number, receitaComprometida: number,
 *   despesaCaixa: number, despesaComprometida: number, totalComprometidoMes: number,
 *   diffNaoIdentificadoMes: number,
 *   sobra: number, sobraPct: number, totalAp: number, totalTransferenciaLiquida: number, saldoFinal: number,
 * }}
 */
export function calcularAgregadosOrcamento({
  data,
  cartoes = [],
  faturaEstados = {},
  recorrentes = [],
  fixasPuladas = null,
  agora = new Date(),
  contaId = null,
}) {
  // Filtro por conta aplicado uma única vez, antes de qualquer cálculo — sem
  // contaId (default) é um no-op (pertenceAConta sempre retorna true), então
  // o resultado consolidado continua idêntico ao de antes desse parâmetro
  // existir. Cartão não pertence a conta nenhuma (não existe mais vínculo
  // fixo cartão→conta) — quem paga a fatura é escolhido no momento da
  // confirmação de pagamento, então um item de despesa de cartão usa a conta
  // gravada em faturaEstados[cartaoId_fatura].contaId, não a sua própria.
  // Fatura ainda não paga não tem conta definida — cai em CONTA_PRINCIPAL_ID
  // por padrão até ser confirmada.
  const _contaFatura = d => faturaEstados[`${d.cartaoId}_${d.fatura}`]?.contaId || CONTA_PRINCIPAL_ID;
  const _pertenceItemDespesa = d => (d.cartao && d.fatura)
    ? (contaId == null || _contaFatura(d) === contaId)
    : pertenceAConta(d, contaId);
  data = {
    ...data,
    receitas: data.receitas.filter(r => pertenceAConta(r, contaId)),
    despesas: data.despesas.filter(_pertenceItemDespesa),
    aportes: (data.aportes || []).filter(a => pertenceAConta(a, contaId)),
    transferencias: (data.transferencias || []).filter(t => pertenceAConta(t, contaId)),
  };
  recorrentes = (recorrentes || []).filter(r => pertenceAConta(r, contaId));

  const { mes, ano } = data.periodo;
  const periodoTotal = ano * 12 + mes;
  const agoraTotal   = agora.getFullYear() * 12 + agora.getMonth() + 1;
  const ehFuturo = periodoTotal > agoraTotal;

  const saldoConta = data.saldoConta || 0;
  const totalReceita = data.receitas.filter(r => !isPendenteEfetivo(r, agora)).reduce((s, r) => s + r.valor, 0);
  // Receita "comprometida" — toda receita prevista no mês, pendente ou não
  // (mesmo critério de despesaComprometida). Usada por Score/Planejamento/
  // home, que olham o mês inteiro, não só o que já caiu na conta.
  const receitaComprometida = data.receitas.reduce((s, r) => s + r.valor, 0);

  // Fatura fechada só sensibiliza o caixa (despesaCaixa/Sobra/Saldo Final) quando
  // confirmada como paga — total ou, no parcial, só a parte paga (o restante
  // vira despesa automática no mês seguinte). Até confirmar, fica em "a
  // vencer". Em meses futuros tudo é projeção, sem essa separação.
  //
  // "openKey" por cartão — a fatura que está acumulando compras HOJE (mesmo
  // cálculo de sugerirFatura em orcamento.html, duplicado aqui só pra este
  // módulo continuar sem depender do frontend). Usado abaixo pra não tratar
  // uma fatura que ainda nem abriu (ex: setembro, com assinatura recorrente
  // já lançada com antecedência em agosto) como se já tivesse fechado —
  // achado 23/07/2026, Flávia: fatura futura aparecendo junto das fechadas.
  const _openKeyPorCartao = {};
  (cartoes || []).forEach(c => {
    if (!c.diaCorte) return;
    const dia = agora.getDate();
    const d = new Date(agora.getFullYear(), agora.getMonth(), 1);
    if (dia > c.diaCorte) d.setMonth(d.getMonth() + 1);
    if (!c.diaVencimento || c.diaVencimento <= c.diaCorte) d.setMonth(d.getMonth() + 1);
    _openKeyPorCartao[c.id] = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const _periodoNumCalc = key => {
    const [a, m] = (key || '').split('-').map(Number);
    return (a || 0) * 12 + (m || 0);
  };
  const _faturaJaAbriu = (cartaoId, fatura) => {
    const aberta = _openKeyPorCartao[cartaoId];
    return !aberta || _periodoNumCalc(fatura) <= _periodoNumCalc(aberta);
  };
  const gruposFechadaCaixa = {};
  data.despesas.forEach(d => {
    if (d.cartao && d.fatura && !d._faturaAberta && _faturaJaAbriu(d.cartaoId, d.fatura)) {
      const key = `${d.cartaoId}_${d.fatura}`;
      gruposFechadaCaixa[key] = (gruposFechadaCaixa[key] || 0) + d.valor;
    }
  });
  // Estorno de uma compra vinculado à mesma fatura (achado 15/07/2026) —
  // desconta do total devido, igual já acontece na aba Faturas do frontend.
  (data.receitas || []).forEach(r => {
    if (r.cartao && r.fatura && !r._faturaAberta && _faturaJaAbriu(r.cartaoId, r.fatura)) {
      const key = `${r.cartaoId}_${r.fatura}`;
      gruposFechadaCaixa[key] = (gruposFechadaCaixa[key] || 0) - r.valor;
    }
  });
  // Fatura com ajuste manual confirmado (ajusteTotal) não pode sumir só
  // porque nenhum lançamento individual ficou com essa fatura — o ajuste é
  // o valor real da conta física, independente de existir item detalhado.
  // NUNCA pular por já estar paga_total (achado 09/07/2026): uma fatura
  // ajuste-only marcada como paga desaparecia do cálculo inteiro — o
  // backfill existe justamente pra ela continuar existindo depois de paga.
  //
  // Só entra aqui quem tem ajusteTotal de verdade — faturaEstados é global
  // (todas as faturas de todos os meses), então sem esse filtro qualquer
  // fatura já resolvida de outro mês virava um card fantasma de R$0 em todo
  // mês visualizado dali pra frente (achado 23/07/2026, mesmo fix na aba
  // Faturas do frontend).
  Object.entries(faturaEstados).forEach(([key, fe]) => {
    if (key in gruposFechadaCaixa) return;
    if (fe.ajusteTotal == null) return;
    if (contaId != null && (fe.contaId || CONTA_PRINCIPAL_ID) !== contaId) return;
    const [cartaoId, faturaKey] = key.split('_');
    if (!_faturaJaAbriu(cartaoId, faturaKey)) return;
    if (cartoes.some(c => c.id === cartaoId && c.ativo)) gruposFechadaCaixa[key] = 0;
  });
  let totalFaturas    = 0; // fatura fechada ainda não confirmada como paga ("a vencer")
  let totalCartaoPago = 0; // fatura fechada já confirmada (total ou parte paga)
  if (!ehFuturo) {
    Object.entries(gruposFechadaCaixa).forEach(([key, total]) => {
      const fe = faturaEstados[key];
      const totalAjustado = fe?.ajusteTotal ?? total;
      if (fe?.estado === 'paga_total') totalCartaoPago += totalAjustado;
      else if (fe?.estado === 'paga_parcial') totalCartaoPago += fe.valorPago || 0;
      else totalFaturas += totalAjustado;
    });
  }
  const totalCartaoCaixa = ehFuturo
    ? Object.values(gruposFechadaCaixa).reduce((s, v) => s + v, 0)
    : totalCartaoPago;

  const despesasPendentes = data.despesas.filter(d => isPendenteEfetivo(d, agora) && !(d.cartao && d.fatura));
  const totalPendente = despesasPendentes.reduce((s, d) => s + d.valor, 0);

  // Despesas fixas em CONTA (débito, não cartão) ainda não lançadas neste
  // mês — não existem como lançamento de verdade ainda, por isso não contam
  // em caixa nem comprometido "real", só aparecem como pendentes virtuais
  // até a usuária confirmar uma por uma. Fixas no CARTÃO são lançadas junto
  // com a fatura, então não entram aqui.
  const puladas = fixasPuladas ?? getFixasPuladas();
  const fixasVirtuais = [];
  // Achado 22/07/2026: com a chegada de receita fixa (tipo:'receita'), esse
  // filtro passou a pegar TAMBÉM as recorrentes de receita — que não têm
  // projeção virtual própria (materializam só manualmente, via "Lançar
  // agora" em orcamento.html) — e jogava elas aqui dentro como se fossem
  // despesa fixa pendente, aparecendo como débito negativo no Saldo
  // Projetado. `tipo` não existia quando este filtro foi escrito, então
  // toda recorrente ativa e sem cartão era despesa por definição; agora
  // filtra explicitamente só despesa (recorrentes antigas, sem `tipo`
  // salvo, continuam contando como despesa — comportamento inalterado).
  (recorrentes || []).filter(r => r.ativo && !r.cartao && (r.tipo || 'despesa') === 'despesa').forEach(r => {
    diasFaltantesRecorrente(r, data.despesas, mes, ano).forEach(dia => {
      if (puladas.includes(chaveFixaPulada(r.id, ano, mes, dia))) return;
      fixasVirtuais.push({ recorrenteId: r.id, categoria: r.categoria, descricao: r.descricao || '', valor: r.valor, dia });
    });
  });
  const totalFixasVirtuais = fixasVirtuais.reduce((s, v) => s + v.valor, 0);

  // Receita fixa — mesma ideia da despesa fixa acima (projeção virtual até a
  // usuária confirmar uma por uma), espelhando data.receitas em vez de
  // data.despesas. Adicionado em 23/07/2026: a v1 (achado 22/07/2026) só
  // tinha o botão manual "Lançar agora" no modal, sem projeção automática
  // nos meses futuros — pedido da Flávia pra igualar ao comportamento da
  // despesa fixa.
  const fixasVirtuaisReceita = [];
  (recorrentes || []).filter(r => r.ativo && !r.cartao && r.tipo === 'receita').forEach(r => {
    diasFaltantesRecorrente(r, data.receitas, mes, ano).forEach(dia => {
      if (puladas.includes(chaveFixaPulada(r.id, ano, mes, dia))) return;
      fixasVirtuaisReceita.push({ recorrenteId: r.id, categoria: r.categoria, descricao: r.descricao || '', valor: r.valor, dia });
    });
  });
  const totalFixasVirtuaisReceita = fixasVirtuaisReceita.reduce((s, v) => s + v.valor, 0);

  // Mesma exclusão que despesasPendentes já tinha (linha acima): receita
  // vinculada a cartão/fatura (ex: estorno de compra, "Ajuste de fatura"
  // crédito) é resolvida na aba Faturas, não deveria contar como pendência
  // genérica no resumo/home — assimetria achada em 30/07/2026, Flávia:
  // "o valor do crédito entrou como receita pendente, não deveria".
  const receitasPendentes = data.receitas.filter(r => isPendenteEfetivo(r, agora) && !(r.cartao && r.fatura));
  const totalReceitaPendente = receitasPendentes.reduce((s, r) => s + r.valor, 0);

  // Em mês futuro, "pendente por data" não diz nada (tudo é futuro) — conta
  // tudo, igual já acontece com o totalCartaoCaixa acima. Só no mês atual a
  // distinção caixa (já sensibilizou) x pendente (ainda não) faz sentido.
  const contaComoCaixa = d => ehFuturo || !isPendenteEfetivo(d, agora);
  const despesaCaixa = data.despesas.filter(d => contaComoCaixa(d) && !d._faturaAberta && !(d.cartao && d.fatura)).reduce((s, d) => s + d.valor, 0) + totalCartaoCaixa;

  // Critério "comprometido" — despesas já efetivadas + pendentes + faturas
  // fechadas (pagas ou a vencer) + fixas ainda não lançadas. Compras na
  // fatura ABERTA (ciclo em curso) ficam de fora — só contam quando a
  // fatura fechar. Esse é o total usado por Detalhe, Planejamento e home —
  // "quanto esse mês vai custar no total", diferente de despesaCaixa
  // ("quanto já saiu da conta").
  const totalComprometidoMes = data.despesas.filter(d => !d._faturaAberta).reduce((s, d) => s + d.valor, 0);
  const despesaComprometida = despesaCaixa + totalPendente + totalFaturas + totalFixasVirtuais;
  // Diferença entre o comprometido (soma direta de tudo lançado) e a
  // reconciliação de caixa (despesaCaixa + pendentes + faturas + fixas
  // virtuais) — idealmente ~0; se não for, indica algo não identificável
  // item a item (ex: fatura com ajuste manual sem lançamentos correspondentes).
  // Em mês futuro não faz sentido calcular (tudo é projeção).
  const diffNaoIdentificadoMes = ehFuturo ? 0 : (totalComprometidoMes - despesaComprometida);

  const sobra = saldoConta + totalReceita - despesaCaixa;
  const sobraPct = (saldoConta + totalReceita) > 0 ? (sobra / (saldoConta + totalReceita)) * 100 : 0;
  const totalAp = (data.aportes || []).reduce((s, a) => s + a.valor, 0);
  // Transferência entre contas próprias: entrada soma, saída subtrai — igual
  // receita/despesa afetam o saldo de caixa, mas NUNCA entram em
  // totalReceita/despesaCaixa/despesaComprometida/categorias/Score, calculados
  // só a partir de data.receitas/data.despesas acima (transferencias é um
  // array à parte, não misturado neles). Consolidado (contaId null): as duas
  // pernas de cada transferência somam zero líquido.
  const totalTransferenciaLiquida = (data.transferencias || [])
    .reduce((s, t) => s + (t.direcao === 'entrada' ? t.valor : -t.valor), 0);
  const saldoFinal = sobra - totalAp + totalTransferenciaLiquida;

  return {
    ehFuturo, saldoConta, totalReceita, receitaComprometida,
    gruposFechadaCaixa, totalFaturas, totalCartaoPago, totalCartaoCaixa,
    despesasPendentes, totalPendente,
    fixasVirtuais, totalFixasVirtuais,
    fixasVirtuaisReceita, totalFixasVirtuaisReceita,
    receitasPendentes, totalReceitaPendente,
    despesaCaixa, despesaComprometida, totalComprometidoMes,
    diffNaoIdentificadoMes,
    sobra, sobraPct, totalAp, totalTransferenciaLiquida, saldoFinal,
  };
}

/**
 * "Não planejado" do Planejamento — a folga do orçamento planejado que não
 * foi distribuída em nenhuma categoria (renda × % planejado − soma dos
 * limites). Não é sobre gasto real: despesa real sempre aparece na sua
 * própria categoria na tabela principal, tenha limite definido ou não —
 * mesmo raciocínio de uma transação lançada manualmente (achado 13/07/2026;
 * antes essa função também somava despesa de categoria sem limite aqui,
 * escondendo-a da própria categoria). Não confundir com CATEGORIA_AJUSTE
 * (calcularAjuste) — aquela é reconciliação de caixa, essa é planejamento.
 *
 * @param {object} args
 * @param {number|null} [args.renda] - renda planejada do mês; null se ainda não definida
 * @param {number|null} [args.percentual] - percentual planejado pra gastar (0-100); null se ainda não definido
 * @param {{nome:string, limite:number}[]} [args.categorias]
 * @returns {{
 *   temMeta: boolean, totalPlanejado: number|null, somaLimites: number,
 *   folga: number|null, sobreAlocado: boolean,
 * }}
 */
export function calcularNaoPlanejado({ renda = null, percentual = null, categorias = [] }) {
  const temMeta = renda != null && percentual != null;
  const totalPlanejado = temMeta ? renda * (percentual / 100) : null;
  const somaLimites = (categorias || []).reduce((s, c) => s + (c.limite || 0), 0);
  const folga = temMeta ? Math.max(0, totalPlanejado - somaLimites) : null;
  const sobreAlocado = temMeta && somaLimites > totalPlanejado;

  return { temMeta, totalPlanejado, somaLimites, folga, sobreAlocado };
}

/**
 * Categoria de ajuste "Lançamentos não identificados" — mesma peça que
 * Detalhe e Planejamento injetam quando diffNaoIdentificadoMes é relevante
 * (>1 em módulo). Centralizado aqui pra não divergir entre as duas telas.
 *
 * @param {number} diffNaoIdentificadoMes
 * @param {number} [jaExplicadoPor] - valor já coberto por outra decomposição
 *   (ex: fixas virtuais mostradas separadamente) — subtraído pra não contar
 *   duas vezes. Default 0.
 * @returns {{ temAjuste: boolean, valorAjuste: number }}
 */
export function calcularAjuste(diffNaoIdentificadoMes, jaExplicadoPor = 0) {
  const valorAjuste = -diffNaoIdentificadoMes - jaExplicadoPor;
  return { temAjuste: Math.abs(valorAjuste) > 1, valorAjuste };
}
