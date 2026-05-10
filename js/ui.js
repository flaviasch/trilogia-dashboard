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

// ─── Confirm delete dialog ────────────────────────────────────────────────────
// Substitui o confirm() nativo por um diálogo estilizado.
// Uso: if (!(await confirmDelete('Excluir "Viagem Europa"?'))) return;

export function confirmDelete(msg) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:10000',
      'background:rgba(0,0,0,.65)', 'display:flex',
      'align-items:center', 'justify-content:center', 'padding:24px',
    ].join(';');

    overlay.innerHTML = `
      <div style="background:#0D2B45;border:1px solid rgba(255,255,255,.1);border-radius:14px;
                  padding:24px;max-width:320px;width:100%;font-family:'Inter',sans-serif">
        <p style="font-size:14px;color:#fff;margin-bottom:20px;line-height:1.5">${msg}</p>
        <div style="display:flex;gap:10px">
          <button id="_cfNo"  style="flex:1;background:transparent;border:1px solid rgba(255,255,255,.1);
            border-radius:8px;padding:10px;font-size:13px;color:rgba(255,255,255,.5);
            cursor:pointer;font-family:'Inter',sans-serif">Cancelar</button>
          <button id="_cfYes" style="flex:1;background:rgba(248,113,113,.12);
            border:1px solid rgba(248,113,113,.35);border-radius:8px;padding:10px;
            font-size:13px;font-weight:600;color:#f87171;cursor:pointer;
            font-family:'Inter',sans-serif">Excluir</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const done = r => { overlay.remove(); resolve(r); };
    overlay.querySelector('#_cfNo').onclick  = () => done(false);
    overlay.querySelector('#_cfYes').onclick = () => done(true);
    overlay.onclick = e => { if (e.target === overlay) done(false); };
  });
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
