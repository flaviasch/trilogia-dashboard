// TrilogIA, sua analista de números (fatia 1, 27/11/2026).
// Quadro compacto (cabeçalho, destaque do mês e botão) que abre um modal com as
// cinco perguntas fixas; a resposta aparece no próprio modal. Usado na tela
// inicial (computador) e no fim do Orçamento simplificado (celular).
// Só aparece se statusTrilogia disser que está liberada para a conta. Em
// qualquer erro (conta PJ, parceiro, recurso desligado) o quadro fica escondido.
import { statusTrilogia, perguntarTrilogia } from './api.js?v=91';

const CSS = `
.tri-card{background:linear-gradient(135deg,rgba(207,174,101,0.10),rgba(207,174,101,0.03));border:1px solid var(--border-gold);border-radius:14px;padding:18px 20px;margin:0 0 24px}
.tri-rot{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--gold);margin-bottom:6px}
.tri-sub{font-size:13px;color:var(--text-secondary);line-height:1.5;margin-bottom:12px}
.tri-destaque{font-size:14px;line-height:1.5;margin-bottom:14px}
.tri-btn{background:var(--gold);color:#0D2B45;border:none;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:700;font-family:'Inter',sans-serif;cursor:pointer;width:100%}
.tri-aviso{font-size:11px;color:var(--text-secondary);line-height:1.5;margin-top:12px;opacity:.85}
.tri-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.8);display:flex;align-items:flex-end;justify-content:center;z-index:400}
.tri-overlay[hidden]{display:none}
.tri-modal{background:var(--navy);border-top:1px solid var(--border-gold);border-radius:16px 16px 0 0;padding:24px 20px 28px;width:100%;max-width:560px;max-height:88vh;overflow-y:auto;-webkit-overflow-scrolling:touch}
@media (min-width:768px){.tri-overlay{align-items:center}.tri-modal{border-radius:16px;border:1px solid var(--border-gold)}.tri-btn{width:auto}}
.tri-topo{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:4px}
.tri-titulo{font-family:'Playfair Display',serif;font-size:19px;font-weight:600}
.tri-fechar{background:none;border:none;color:var(--text-secondary);font-size:22px;line-height:1;cursor:pointer;padding:0 4px}
.tri-perguntas{display:flex;flex-direction:column;gap:8px;margin:14px 0}
.tri-perg{text-align:left;background:rgba(var(--rgb-fg,255,255,255),0.05);border:1px solid var(--border-gold);color:inherit;border-radius:10px;padding:11px 14px;font-size:14px;font-family:'Inter',sans-serif;cursor:pointer}
.tri-perg.ativa{border-color:var(--gold);background:rgba(207,174,101,0.14)}
.tri-perg:disabled{opacity:.6;cursor:wait}
.tri-resp{font-size:14px;line-height:1.65;padding:14px;border-radius:10px;background:rgba(var(--rgb-fg,255,255,255),0.04);border-left:3px solid var(--gold)}
.tri-resp[hidden]{display:none}
`;

let _cssOk = false;
function _css() {
  if (_cssOk) return;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
  _cssOk = true;
}

function _el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

let _modal = null;
function _montarModal(perguntas, aviso, periodo) {
  if (_modal) _modal.remove();
  const ov = _el('div', 'tri-overlay');
  ov.hidden = true;
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  const m = _el('div', 'tri-modal');
  const topo = _el('div', 'tri-topo');
  const tt = _el('div');
  tt.appendChild(_el('div', 'tri-titulo', 'TrilogIA, sua analista de números'));
  tt.appendChild(_el('div', 'tri-sub', 'Escolha uma pergunta sobre o seu mês.'));
  const fechar = _el('button', 'tri-fechar', '×');
  fechar.type = 'button';
  fechar.setAttribute('aria-label', 'Fechar');
  topo.append(tt, fechar);
  const lista = _el('div', 'tri-perguntas');
  const resp = _el('div', 'tri-resp');
  resp.hidden = true;
  resp.setAttribute('aria-live', 'polite');
  const botoes = Object.entries(perguntas).map(([id, texto]) => {
    const b = _el('button', 'tri-perg', texto);
    b.type = 'button';
    b.addEventListener('click', async () => {
      botoes.forEach(x => { x.disabled = true; x.classList.toggle('ativa', x === b); });
      resp.hidden = false;
      resp.textContent = 'Analisando os seus números…';
      try {
        const p = periodo() || {};
        const r = await perguntarTrilogia(id, p.mes, p.ano);
        resp.textContent = (r && r.texto) || 'Não consegui montar essa resposta agora. Tente novamente mais tarde.';
      } catch (_) {
        resp.textContent = 'Não consegui montar essa resposta agora. Tente novamente mais tarde.';
      } finally {
        botoes.forEach(x => { x.disabled = false; });
      }
    });
    lista.appendChild(b);
    return b;
  });
  m.append(topo, lista, resp, _el('div', 'tri-aviso', aviso));
  ov.appendChild(m);
  const fecharModal = () => { ov.hidden = true; document.body.style.overflow = ''; };
  fechar.addEventListener('click', fecharModal);
  ov.addEventListener('click', (e) => { if (e.target === ov) fecharModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ov.hidden) fecharModal(); });
  document.body.appendChild(ov);
  _modal = ov;
  return () => {
    resp.hidden = true; resp.textContent = '';
    botoes.forEach(x => x.classList.remove('ativa'));
    ov.hidden = false; document.body.style.overflow = 'hidden';
  };
}

/**
 * Monta o quadro dentro de `container` (fica escondido até a resposta do servidor).
 * opts.periodo: () => ({ mes, ano }) do mês em tela (opcional; padrão: mês atual).
 */
export async function montarTrilogia(container, opts = {}) {
  if (!container) return;
  container.hidden = true;
  const periodo = typeof opts.periodo === 'function' ? opts.periodo : () => null;
  let st;
  try {
    const p = periodo() || {};
    st = await statusTrilogia(p.mes, p.ano);
  } catch (_) { return; }
  if (!st || !st.disponivel) return;
  _css();
  const abrir = _montarModal(st.perguntas || {}, st.aviso || '', periodo);
  container.textContent = '';
  const card = _el('div', 'tri-card');
  card.appendChild(_el('div', 'tri-rot', '✦ TrilogIA, sua analista de números'));
  if (st.destaque) card.appendChild(_el('div', 'tri-destaque', st.destaque));
  else card.appendChild(_el('div', 'tri-sub', 'Pergunte sobre a sua sobra, os limites, o patrimônio, as reservas e a sua meta.'));
  const b = _el('button', 'tri-btn', 'Perguntar à TrilogIA');
  b.type = 'button';
  b.addEventListener('click', abrir);
  card.append(b, _el('div', 'tri-aviso', st.aviso || ''));
  container.appendChild(card);
  container.hidden = false;
}
