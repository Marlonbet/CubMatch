// CUBMATCH — capa visual "Mediopunto" que se engancha al DOM sin tocar app.js:
//  · Selector de avatares bajo el campo de foto del perfil (input[data-f="fotoURL"]).
//    Elegir un avatar rellena ese campo con un data: URI y dispara 'input'/'change',
//    exactamente igual que la subida desde galería: app.js ya sabe qué hacer.
//  · Íconos SVG propios en la barra inferior (en vez de emoji).
//  · Logo de mediopunto en portada y cabecera.
// Idempotente: cada elemento se marca con data-mp y nunca se procesa dos veces.
import {
  PIELES, PELOS, PEINADOS, NOMBRES_PEINADO, FONDOS, NOMBRES_FONDO,
  randomSpec, normalizarSpec, avatarDataURI, esAvatarElegido,
} from './avatares.js';

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ---------------------------------------------------------------- íconos
const TRAZO = {
  descubrir: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5L13.5 13.5L8.5 15.5L10.5 10.5Z"/>',
  top: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9L3.5 9.7l5.9-.8z"/>',
  matches: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10C19.5 15.4 12 20 12 20z"/>',
  chats: '<path d="M4 5h16v11H9l-5 4z"/>',
  avisos: '<path d="M6 17v-6a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4"/>',
  ajustes: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  perfil: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c0-4 3.2-6 7-6s7 2 7 6"/>',
};
function claveTab(tab) {
  const t = norm(tab.getAttribute('aria-label') || tab.textContent);
  if (t.includes('descubr')) return 'descubrir';
  if (t.includes('top') || t.includes('mejores')) return 'top';
  if (t.includes('match')) return 'matches';
  if (t.includes('chat') || t.includes('mensaj')) return 'chats';
  if (t.includes('aviso') || t.includes('sugerenc')) return 'avisos';
  if (t.includes('ajust')) return 'ajustes';
  if (t.includes('perfil')) return 'perfil';
  return null;
}
function iconos() {
  document.querySelectorAll('.tabnav .tab .tico:not([data-mp])').forEach((t) => {
    t.dataset.mp = '1';
    const d = TRAZO[claveTab(t.closest('.tab'))];
    if (!d) return;
    Array.from(t.childNodes).forEach((n) => { if (n.nodeType === 3) n.remove(); });
    t.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>');
  });
}

// ------------------------------------------------------------------ logo
let nLogo = 0;
function marca(tam) {
  const id = 'mpa' + (nLogo++);
  const cols = FONDOS[0];
  const cuñas = cols.map((c, k) => {
    const p = (a) => (32 + 70 * Math.cos(a * Math.PI / 180)).toFixed(1) + ' ' + (60 - 70 * Math.sin(a * Math.PI / 180)).toFixed(1);
    return '<path d="M32 60L' + p(180 - 36 * k) + 'L' + p(144 - 36 * k) + 'Z" fill="' + c + '"/>';
  }).join('');
  return '<svg viewBox="0 0 64 64" width="' + tam + '" height="' + tam + '" role="img" aria-label="CubMatch">'
    + '<clipPath id="' + id + '"><path d="M6 60V32a26 26 0 0 1 52 0v28z"/></clipPath>'
    + '<g clip-path="url(#' + id + ')">' + cuñas + '</g>'
    + '<path d="M6 60V32a26 26 0 0 1 52 0v28z" fill="none" stroke="#12304a" stroke-width="3"/>'
    + '<path d="M32 49s-9-5.5-9-12a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.5-9 12-9 12z" fill="#fff" stroke="#12304a" stroke-width="2"/></svg>';
}
function logos() {
  [['.brand .logo svg', '1em'], ['.inicio-logo-big svg', 160], ['.deck-title svg', 30]].forEach(([sel, tam]) => {
    document.querySelectorAll(sel + ':not([data-mp])').forEach((s) => {
      const tmp = document.createElement('span');
      tmp.innerHTML = marca(tam);
      const nuevo = tmp.firstChild;
      nuevo.setAttribute('data-mp', '1');
      s.replaceWith(nuevo);
    });
  });
}

// --------------------------------------------------------------- avatares
const fondoCSS = (c) => 'linear-gradient(90deg,' + c.map((x, i) => x + ' ' + i * 20 + '% ' + (i + 1) * 20 + '%').join(',') + ')';

function montarSelector(input) {
  input.dataset.mp = '1';
  const donde = input.closest('label, .fld') || input.parentElement;
  const caja = document.createElement('div');
  caja.className = 'av-picker';
  caja.innerHTML = '<button type="button" class="btn ghost sm av-abrir">Elegir un avatar</button><div class="av-panel" hidden></div>';
  donde.insertAdjacentElement('afterend', caja);
  const panel = caja.querySelector('.av-panel');
  let s = randomSpec();

  const sw = (k, i, fondo, nombre) => '<button type="button" class="av-sw" data-k="' + k + '" data-v="' + i + '" aria-pressed="' + (s[k] === i) + '" aria-label="' + nombre + '" style="background:' + fondo + '"></button>';
  function pintar(foco) {
    panel.innerHTML = '<img class="av-prev" alt="Vista previa de tu avatar" src="' + avatarDataURI(s) + '">'
      + '<p class="av-lbl">Peinado</p><div class="av-row">' + PEINADOS.map((_, i) =>
        '<button type="button" class="av-th" data-k="peinado" data-v="' + i + '" aria-pressed="' + (s.peinado === i) + '" aria-label="' + NOMBRES_PEINADO[i] + '"><img alt="" src="' + avatarDataURI({ ...s, peinado: i }) + '"></button>').join('') + '</div>'
      + '<p class="av-lbl">Piel</p><div class="av-row">' + PIELES.map((c, i) => sw('piel', i, c, 'Piel ' + (i + 1))).join('') + '</div>'
      + '<p class="av-lbl">Pelo</p><div class="av-row">' + PELOS.map((c, i) => sw('pelo', i, c, 'Pelo ' + (i + 1))).join('') + '</div>'
      + '<p class="av-lbl">Vidrio de fondo</p><div class="av-row">' + FONDOS.map((c, i) => sw('fondo', i, fondoCSS(c), NOMBRES_FONDO[i])).join('') + '</div>'
      + '<div class="av-row"><label class="check"><input type="checkbox" data-k="barba"' + (s.barba ? ' checked' : '') + '> Barba</label>'
      + '<label class="check"><input type="checkbox" data-k="gafas"' + (s.gafas ? ' checked' : '') + '> Gafas</label></div>'
      + '<div class="row-btns"><button type="button" class="btn ghost sm" data-act="azar">Sorpréndeme</button>'
      + '<button type="button" class="btn primary sm" data-act="usar">Usar este avatar</button></div>';
    if (foco) { const el = panel.querySelector(foco); if (el) el.focus(); }
  }
  caja.querySelector('.av-abrir').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden && !panel.firstChild) pintar();
  });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !panel.contains(b)) return;
    if (b.dataset.k) { s = normalizarSpec({ ...s, [b.dataset.k]: Number(b.dataset.v) }); pintar('[data-k="' + b.dataset.k + '"][data-v="' + b.dataset.v + '"]'); return; }
    if (b.dataset.act === 'azar') { s = randomSpec(); pintar('[data-act="azar"]'); return; }
    if (b.dataset.act === 'usar') {
      const actual = input.value.trim();
      if (actual && !esAvatarElegido(actual) && !window.confirm('Esto reemplaza tu foto actual. ¿Seguir?')) return;
      input.value = avatarDataURI(s);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      panel.hidden = true;
    }
  });
  panel.addEventListener('change', (e) => {
    const c = e.target;
    if (c && c.dataset && (c.dataset.k === 'barba' || c.dataset.k === 'gafas')) {
      s = normalizarSpec({ ...s, [c.dataset.k]: c.checked ? 1 : 0 });
      pintar('[data-k="' + c.dataset.k + '"]');
    }
  });
}
function selectores() {
  document.querySelectorAll('input[data-f="fotoURL"]:not([data-mp])').forEach(montarSelector);
}

// ----------------------------------------------------------------- arranque
function mejorar() { pendiente = false; iconos(); logos(); selectores(); }
let pendiente = false;
const agenda = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16);
if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
  new MutationObserver(() => { if (!pendiente) { pendiente = true; agenda(mejorar); } })
    .observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mejorar);
  else mejorar();
}
