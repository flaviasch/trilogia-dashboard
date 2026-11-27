// Versão da Política de Privacidade (27/11/2026: seção de IA). Sem efeitos
// colaterais: só as regras de data e versão, usadas por login-pj.html,
// vinculo.html e js/lgpd-pj-gate.js. index.html tem a mesma regra inline.
// Antes de 12/12/2026 ninguém vê o novo aceite. ?lgpdData=AAAA-MM-DD simula a data.
export const LGPD_VERSAO = '2026-11-27';
export const LGPD_VIGENCIA = '2026-12-12';

export function lgpdHoje() {
  try {
    const q = new URLSearchParams(window.location.search).get('lgpdData');
    if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) return q;
  } catch {}
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function precisaNovoAceiteLGPD(lgpdVersao) {
  return lgpdHoje() >= LGPD_VIGENCIA && lgpdVersao !== LGPD_VERSAO;
}
