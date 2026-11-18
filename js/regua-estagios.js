/**
 * Régua de estágios do CRM (18/11/2026, Flávia): setas encadeadas
 * Novo → Conexão → Diagnóstico → Proposta → Perdido → Convertido.
 * Usada no CRM do admin e no CRM do Dashboard PJ. Script clássico (não
 * module) para funcionar igual nas duas páginas.
 *
 * ReguaEstagios.render(container, atual, onChange)
 *   container: elemento onde a régua é desenhada
 *   atual:     estágio atual (string)
 *   onChange:  chamada com o novo estágio quando a usuária clica numa seta
 */
(function () {
  const ESTAGIOS = ['Novo', 'Conexão', 'Diagnóstico', 'Proposta', 'Perdido', 'Convertido'];

  const css = `
.regua-estagios{display:flex;width:100%;gap:0;padding:2px 0}
.regua-container{container:regua / inline-size}
.regua-estagios .re-seta{flex:1 1 0;min-width:0;position:relative;border:0;cursor:pointer;
  font-family:'Inter',sans-serif;font-size:13px;line-height:1;padding:12px 10px 12px 22px;
  background:rgba(var(--rgb-fg,255,255,255),.10);color:var(--text-muted,#9aa5b1);
  clip-path:polygon(0 0,calc(100% - 14px) 0,100% 50%,calc(100% - 14px) 100%,0 100%,14px 50%);
  margin-left:-8px;transition:background .15s,color .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.regua-estagios .re-seta:first-child{margin-left:0;padding-left:18px;border-radius:999px 0 0 999px;
  clip-path:polygon(0 0,calc(100% - 14px) 0,100% 50%,calc(100% - 14px) 100%,0 100%)}
.regua-estagios .re-seta:last-child{border-radius:0 999px 999px 0;
  clip-path:polygon(0 0,100% 0,100% 100%,0 100%,14px 50%)}
.regua-estagios .re-seta:hover{background:rgba(var(--rgb-fg,255,255,255),.18)}
.regua-estagios .re-seta.re-feito{background:rgba(207,174,101,.22);color:var(--gold,#CFAE65)}
.regua-estagios .re-seta.re-atual{background:var(--gold,#CFAE65);color:var(--navy,#0D2B45);font-weight:700}
.regua-estagios .re-seta.re-atual.re-perdido{background:var(--negative,#f87171);color:#fff}
.regua-estagios .re-seta.re-atual.re-convertido{background:var(--positive,#4ade80);color:#0b2a17}
.regua-estagios .re-seta:disabled{cursor:default}
@container regua (max-width:590px){
  .regua-estagios{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;overflow:visible}
  .regua-estagios .re-seta,.regua-estagios .re-seta:first-child,.regua-estagios .re-seta:last-child{
    min-width:0;margin:0;padding:10px 4px;border-radius:8px;clip-path:none;font-size:12px;text-align:center}
}`;

  function injetarCss() {
    if (document.getElementById('regua-estagios-css')) return;
    const st = document.createElement('style');
    st.id = 'regua-estagios-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function render(container, atual, onChange, opts) {
    if (!container) return;
    injetarCss();
    const somenteLeitura = !!(opts && opts.somenteLeitura);
    const idxAtual = ESTAGIOS.indexOf(atual);
    // "Feito" só faz sentido na trilha de avanço (Novo..Proposta); Perdido e
    // Convertido são saídas, então não pintam o que ficou para trás de verde.
    // Container query: a régua decide setas x grade pela largura do espaço
    // que tem (modal estreito, celular), não pela largura da tela.
    container.classList.add('regua-container');
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'regua-estagios';
    wrap.setAttribute('role', 'radiogroup');
    wrap.setAttribute('aria-label', 'Estágio do lead');
    ESTAGIOS.forEach((e, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 're-seta';
      b.textContent = e;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', e === atual ? 'true' : 'false');
      if (e === atual) {
        b.classList.add('re-atual');
        if (e === 'Perdido') b.classList.add('re-perdido');
        if (e === 'Convertido') b.classList.add('re-convertido');
      } else if (idxAtual >= 0 && i < idxAtual && i <= 3) {
        b.classList.add('re-feito');
      }
      if (somenteLeitura) b.disabled = true;
      else b.addEventListener('click', () => {
        render(container, e, onChange, opts);
        if (typeof onChange === 'function') onChange(e);
      });
      wrap.appendChild(b);
    });
    container.appendChild(wrap);
  }

  window.ReguaEstagios = { ESTAGIOS, render };
})();
