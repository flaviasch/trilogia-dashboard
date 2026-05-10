// ─── Toast notifications ─────────────────────────────────────────────────────
// Uso: toast('Reserva salva!', 'success')
//      toast('Preencha o nome.', 'warning')
//      toast('Erro ao salvar.', 'error')
//      toast('Importando…',     'info')

export function toast(msg, type = 'success', duration = 3500) {
  let container = document.getElementById('_toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = '_toastContainer';
    container.style.cssText = [
      'position:fixed', 'bottom:80px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:9999', 'display:flex', 'flex-direction:column-reverse', 'gap:8px',
      'align-items:center', 'pointer-events:none',
      'width:max-content', 'max-width:calc(100vw - 32px)',
    ].join(';');
    document.body.appendChild(container);
  }

  // Injeta keyframes uma única vez
  if (!document.getElementById('_toastStyle')) {
    const s = document.createElement('style');
    s.id = '_toastStyle';
    s.textContent = `
      @keyframes _tIn  { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
      @keyframes _tOut { from { opacity:1; transform:translateY(0);   } to { opacity:0; transform:translateY(-6px); } }
    `;
    document.head.appendChild(s);
  }

  const palette = {
    success: ['rgba(74,222,128,.13)', 'rgba(74,222,128,.38)', '#4ade80'],
    error:   ['rgba(248,113,113,.13)', 'rgba(248,113,113,.38)', '#f87171'],
    warning: ['rgba(251,191,36,.13)', 'rgba(251,191,36,.38)', '#fbbf24'],
    info:    ['rgba(207,174,101,.13)', 'rgba(207,174,101,.32)', '#CFAE65'],
  };
  const [bg, border, color] = palette[type] ?? palette.info;

  const el = document.createElement('div');
  el.style.cssText = [
    `background:${bg}`, `border:1px solid ${border}`, `color:${color}`,
    'padding:11px 18px', 'border-radius:10px',
    "font-family:'Inter',sans-serif", 'font-size:13px', 'font-weight:500',
    'backdrop-filter:blur(8px)', 'pointer-events:auto',
    'animation:_tIn .2s ease', 'white-space:pre-wrap', 'text-align:center',
    'box-shadow:0 4px 20px rgba(0,0,0,.45)', 'max-width:320px',
  ].join(';');
  el.textContent = msg;
  container.appendChild(el);

  setTimeout(() => {
    el.style.animation = '_tOut .2s ease forwards';
    setTimeout(() => el.remove(), 220);
  }, duration);
}

// ─── Button loading state ─────────────────────────────────────────────────────
// Uso: setLoading(btn, true)  → desabilita e mostra spinner
//      setLoading(btn, false) → restaura estado original

const SPIN_HTML =
  '<span style="display:inline-block;width:13px;height:13px;border:2px solid currentColor;' +
  'border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;' +
  'vertical-align:middle;margin-right:6px;opacity:.8"></span>';

export function setLoading(btn, loading) {
  if (loading) {
    btn._origHTML     = btn.innerHTML;
    btn._origDisabled = btn.disabled;
    btn.innerHTML     = SPIN_HTML + 'Salvando…';
    btn.disabled      = true;
    btn.style.opacity = '.65';
  } else {
    if (btn._origHTML !== undefined) btn.innerHTML = btn._origHTML;
    btn.disabled      = btn._origDisabled ?? false;
    btn.style.opacity = '';
  }
}
