/**
 * investidor-calc.js — alocação por perfil de investidor e cálculo de prazo,
 * compartilhado entre perfil.html e reservas.html.
 *
 * Extraído em 08/07/2026: a tabela de alocação por perfil e o cálculo de
 * "quantos meses até a data" existiam como cópias independentes nos dois
 * arquivos. perfil.html usava uma aproximação por dias (30 dias/mês);
 * reservas.html usava aritmética de mês-calendário — perto de virada de
 * mês as duas podiam discordar em ±1 mês, mudando se uma mesma reserva
 * conta como "longo prazo" numa tela e não na outra.
 */

// ─── Alocação sugerida por perfil de investidor ──────────────────────────────
export const ALOCACAO_PERFIL = {
  conservador: [
    { label: 'RF Pós',      pct: 70,   cor: '#60a5fa' },
    { label: 'RF Inflação', pct: 25,   cor: '#34d399' },
    { label: 'RF Pré',      pct:  5,   cor: '#a78bfa' },
  ],
  moderado: [
    { label: 'RF Pós',         pct: 52.5, cor: '#60a5fa' },
    { label: 'RF Inflação',    pct: 25,   cor: '#34d399' },
    { label: 'RF Pré',         pct:  5,   cor: '#a78bfa' },
    { label: 'Multimercado',   pct:  7.5, cor: '#fb7185' },
    { label: 'Renda Variável', pct:  5,   cor: '#f59e0b' },
    { label: 'Internacional',  pct:  5,   cor: '#22d3ee' },
  ],
  arrojado: [
    { label: 'RF Pós',         pct: 20,  cor: '#60a5fa' },
    { label: 'RF Inflação',    pct: 25,  cor: '#34d399' },
    { label: 'RF Pré',         pct:  5,  cor: '#a78bfa' },
    { label: 'Multimercado',   pct: 15,  cor: '#fb7185' },
    { label: 'Renda Variável', pct: 15,  cor: '#f59e0b' },
    { label: 'Internacional',  pct: 15,  cor: '#22d3ee' },
    { label: 'Alternativos',   pct:  5,  cor: '#c084fc' },
  ],
};

// ─── Buckets de curto/médio prazo ────────────────────────────────────────────
// Usados em reservas.html tanto pela sugestão exibida (alocacaoPorPrazo) quanto
// pela subtração residual do comparativo (alocacaoParaSubtracao) — só o prazo
// acima de 48 meses diverge entre as duas de propósito (uma usa o perfil do
// investidor, a outra distribui proporcional ao portfólio atual pra não
// distorcer os percentuais), então só esses dois buckets fazem sentido
// compartilhar.
export const ALOCACAO_CURTO_PRAZO = [{ label: 'RF Pós', pct: 100, cor: '#60a5fa' }];
export const ALOCACAO_MEDIO_PRAZO = [
  { label: 'RF Pós',      pct: 70, cor: '#60a5fa' },
  { label: 'RF Inflação', pct: 25, cor: '#34d399' },
  { label: 'RF Pré',      pct:  5, cor: '#a78bfa' },
];

// ─── Cálculo de prazo ─────────────────────────────────────────────────────────

/**
 * Meses de agora até um mês-alvo "AAAA-MM" (aritmética de mês-calendário —
 * não é aproximação por dias, evita discordância de ±1 mês perto de virada
 * de mês entre telas diferentes decidindo "isso é longo prazo?").
 */
export function mesesAte(dataStr) {
  if (!dataStr) return null;
  const hoje = new Date();
  const [ano, mes] = dataStr.split('-').map(Number);
  const alvo = new Date(ano, mes - 1, 1);
  return Math.max(0, (alvo.getFullYear() - hoje.getFullYear()) * 12 + (alvo.getMonth() - hoje.getMonth()));
}

/** Meses entre dois "AAAA-MM". */
export function mesesEntre(dataIni, dataFim) {
  if (!dataIni || !dataFim) return null;
  const [a1, m1] = dataIni.split('-').map(Number);
  const [a2, m2] = dataFim.split('-').map(Number);
  return Math.max(0, (a2 - a1) * 12 + (m2 - m1));
}
