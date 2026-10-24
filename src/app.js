// CUBMATCH — UI completa (entry point, ES module; esbuild lo empaqueta en IIFE).
// Vanilla JS, todo renderizado en #app con template strings.
// Sin dependencias de Node: solo los 5 módulos + WebSocket global del navegador.

import { nip04, getEventHash } from 'nostr-tools';
import { RelayPool, RELAYS, ALL_RELAYS, importIdentity, createIdentity, eventoValido, KIND_DM } from './red.js';
import {
  KIND_CALL, CallSession, buildCallPayload, parseCallPayload,
  videoDisponible, rechazoEntranteVideo, textoRegistroLlamada, fmtDuracion,
  iceServersConfig, offerEsFresca,
} from './llamadas.js';
import {
  passwordStrength, checkUsername, fetchNetCount, netcountFromCache, logoSVG,
  APP_URL, shareLinks, qrSVG,
} from './ux.js';
import {
  normalizeUsername, validatePassword, deriveSecretKey,
  buildClaimEvent, fetchUsernameClaim, verifyCredentials, nsecOf, nombreOcupado,
} from './cuentas.js';
import {
  KIND_PERFIL, KIND_LIKE, profileAddr, parseLikeEvent, integrarLikeEntrante,
  parsePerfilEvent, publishPerfil, fetchPerfiles,
  sendLike, sendDislike, fetchLikes, mutualMatches, sendReporte,
  publishIdentityDocs, migrarInboxSiDesactualizado, sendDMRouted, setInboxStore,
  mergePerfiles, mergeLikes,
} from './cubmatch.js';
import {
  newProfile, completitud, camposFaltantes, validateProfile, avatarDataURI, MIN_COMPLETITUD,
  PROVINCIAS, GENEROS, ORIENTACIONES, COMPLEXIONES, OJOS, PIEL, CABELLO,
  EDUCACION, SECTORES, VALORES, INTERESES, RASGOS, RELACIONES, DISTANCIAS,
  PROMPTS, MAX_BIO, MAX_TAGS,
} from './perfil.js';
import {
  TEXTO_LIMITE_EXPL, TEXTO_LIMITE_AVISO, TEXTO_LIMITE_CORTE,
  GRACIA_LIMITE_MS, conUso, agotado, textoRestante,
} from './tiempollamadas.js';
import { buildCorpus, rankCandidates, topDaily, likesYou, compatLabel } from './matching.js';
import { preparePhotoBlob, uploadPhoto } from './foto.js';
import {
  parseChatPayload, buildLocPayload, buildStickerPayload, osmUrl, geoErrorTexto,
  loadStickers, addSticker, removeSticker,
  prepareStickerBlob, stickerPesoOk,
} from './chatx.js';
import { fusionarMensajes, estadoVisible, marcarColgados } from './mensajes.js';
import {
  KIND_PRESENCIA, BEACON_CADA_MS, textoPresencia, parseBeacon,
} from './presencia.js';

// ---------- utilidades ----------
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const hoyISO = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const horaCorta = (ts) => {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, v) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {};
    o = o[ks[i]];
  }
  o[ks[ks.length - 1]] = v;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- localStorage (prefijo cubmatch_) ----------
const LS = {
  get(k, def) {
    try {
      const v = localStorage.getItem('cubmatch_' + k);
      return v == null ? def : JSON.parse(v);
    } catch { return def; }
  },
  set(k, v) {
    try { localStorage.setItem('cubmatch_' + k, JSON.stringify(v)); } catch {}
  },
  del(k) {
    try { localStorage.removeItem('cubmatch_' + k); } catch {}
  },
};

// ---------- estado global ----------
const S = {
  pool: null, sk: null, pubkey: null, username: null, npub: null,
  miPerfil: null, perfilPublicado: false, borrador: null, obPaso: 1,
  vistos: {}, bloqueados: [],
  datosBajos: false, relayStatus: {},
  data: null,            // {perfiles, likes, corpus, ctx, me}
  candidatos: [], idx: 0,
  leGustas: [],          // fila "Le gustas": [{other, ts}]
  top: [],
  perfilCache: new Map(),
  chats: {},             // peerPubkey -> [{id,from,ts,text,read,estado?}]
  presencia: {},         // pubkey -> {ts, off} (última vez visto, local)
  chatPeer: null, chatSubs: [],
  stickerEdit: false,    // panel de stickers en modo edición (borrar)
  cuentaModo: 'registro',
  infoFrom: 'inicio',
  timers: [],
  screen: 'inicio',
};
let wired = false;

// ---------- toast ----------
function toast(msg, ms) {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  box.appendChild(el);
  const t = setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms || 3200);
  S.timers.push(t);
}

// ---------- pool de relays (lazy: sin auto-conexión) ----------
function makePool(sk) {
  return new RelayPool({
    secretKey: sk,
    onRelayStatus: (url, st) => {
      S.relayStatus[url] = st;
      const row = document.querySelector('.relay-row[data-url="' + CSS.escape(url) + '"] .rdot');
      if (row) row.className = 'rdot ' + (st === 'open' ? 'g' : st === 'connecting' ? 'y' : 'r');
    },
  });
}

// Cada pantalla adquiere el scope de relays que necesita al entrar y lo
// libera al salir. Refcount + gracia de 10 s: navegar rápido entre
// pantallas del mismo scope no reconecta. El boot no conecta nada.
let screenScope = null;
function setScreenScope(scope) {
  const want = scope === 'both' ? ['discovery', 'messaging'] : scope ? [scope] : [];
  const have = screenScope === 'both' ? ['discovery', 'messaging'] : screenScope ? [screenScope] : [];
  if (S.pool) {
    for (const s of have) if (!want.includes(s)) S.pool.release(s);
    for (const s of want) if (!have.includes(s)) S.pool.acquire(s);
  }
  screenScope = scope;
}

function stopChat() {
  for (const sub of S.chatSubs) { try { sub.unsub(); } catch {} }
  S.chatSubs = [];
  S.chatPeer = null;
  stopPresenciaUi();
}

export function dispose() {
  for (const t of S.timers) { clearTimeout(t); clearInterval(t); }
  S.timers = [];
  for (const t of cuentaTimers) clearTimeout(t);
  cuentaTimers = [];
  netcountRun++; // invalida el contador en vuelo
  stopChat();
  stopCalls();
  stopPresencia();
  stopGlobalLive();
  setScreenScope(null);
  try { if (S.pool) S.pool.shutdown(); } catch {}
  S.pool = null;
}

export function boot() {
  dispose();
  const root = document.getElementById('app');
  if (root) root.innerHTML = '';
  Object.assign(S, {
    sk: null, pubkey: null, username: null, npub: null,
    miPerfil: null, perfilPublicado: false, borrador: null, obPaso: 1,
    data: null, candidatos: [], idx: 0, leGustas: [], top: [],
    chats: {}, chatPeer: null, stickerEdit: false, screen: 'inicio', cuentaModo: 'registro', infoFrom: 'inicio',
    relayStatus: {},
  });
  S.perfilCache = new Map();
  // Vistos v2: mapa {pubkey: ts} (el ts manda para la reaparición de
  // dislikes a los 21 días). Migración del formato viejo (array sin
  // fechas): cada visto hereda fecha = ahora.
  const vistosRaw = LS.get('vistos', null);
  if (Array.isArray(vistosRaw)) {
    const ahora = Math.floor(Date.now() / 1000);
    S.vistos = {};
    for (const pk of vistosRaw) S.vistos[pk] = ahora;
    LS.set('vistos', S.vistos);
  } else {
    S.vistos = vistosRaw && typeof vistosRaw === 'object' ? vistosRaw : {};
  }
  S.bloqueados = LS.get('bloqueados', []);
  S.presencia = LS.get('presencia', {}) || {};
  S.datosBajos = LS.get('datosbajos', '0') === '1';
  // El inbox ajeno (NIP-17) se cachea en localStorage con TTL 24h.
  setInboxStore({ get: (k) => LS.get(k, null), set: (k, v) => LS.set(k, v) });
  if (!wired) { wired = true; wireEvents(); }
  const ses = LS.get('sesion', null);
  if (ses && ses.username && ses.nsec) restoreSession(ses);
  else showInicio();
}

function wireEvents() {
  const root = document.getElementById('app');
  root.addEventListener('click', onAppClick);
  root.addEventListener('input', onDraftInput);
  root.addEventListener('change', onDraftInput);
  root.addEventListener('change', onFotoChange);
  root.addEventListener('change', onStickerChange);
  root.addEventListener('submit', (e) => {
    if (e.target.id === 'cuenta-form') { e.preventDefault(); submitCuenta(); }
    else if (e.target.id === 'chat-form') { e.preventDefault(); submitChat(); }
  });
  // Al cruzar el breakpoint de escritorio, el deck se re-renderiza
  // (una tarjeta ⇄ cuadrícula) sin recargar datos.
  let resizeT = null;
  window.addEventListener('resize', () => {
    if (resizeT) clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (S.screen === 'deck') renderDeckBody(); }, 200);
  });
  // Al ocultar/cerrar la app, despedida de presencia (best-effort:
  // el TTL de 2 min es la garantía real de que no quede "en línea").
  window.addEventListener('pagehide', () => { if (S.sk) void publicarBeacon('off'); });
}

// ---------- helpers de UI ----------
function avatarImg(pubkey, profile, cls) {
  const fb = avatarDataURI(pubkey, profile.apodo);
  const src = profile.fotoURL && String(profile.fotoURL).trim() ? String(profile.fotoURL).trim() : fb;
  return '<img class="' + (cls || 'avatar') + '" src="' + esc(src) + '" data-fb="' + esc(fb) +
    '" alt="" loading="lazy" onerror="if(this.dataset.fb){this.src=this.dataset.fb;this.removeAttribute(\'data-fb\');}">';
}
function nombreEdad(p) {
  const edad = (p.mostrarEdad !== false && p.edad) ? ', ' + esc(p.edad) : '';
  return esc(p.apodo || 'Sin nombre') + edad;
}
function lugar(p) {
  const bits = [];
  if (p.municipio) bits.push(p.municipio);
  if (p.provincia) bits.push(p.provincia);
  return esc(bits.join(', ') || 'Cuba');
}
// Compatibilidad visible (v2): etiqueta Alta/Media/Explorar en vez
// de %. Los pools relajados siempre se etiquetan "Explorar".
function compatTxt(c) {
  return compatLabel(c.total, c.relajado);
}
function compatCls(c) {
  return 'compat ' + compatTxt(c).toLowerCase();
}
// Sugerencias pendientes de la pestaña 🔔: una por cada campo que
// falta del perfil (la misma cuenta que alimenta la pantalla de
// sugerencias). Se calcula en vivo en cada render de la navegación,
// así la insignia se actualiza al entrar y tras editar el perfil.
function numSugerencias() {
  if (!S.miPerfil) return 0;
  return camposFaltantes(S.miPerfil).length;
}
function navHTML(active) {
  const tabs = [
    ['deck', 'Descubrir', '🔥'],
    ['top10', 'Top 10', '⭐'],
    ['matches', 'Matches', '💬'],
    // Pestaña de sugerencias (v1.10.0): SOLO el símbolo 🔔, sin
    // texto, con insignia del nº de sugerencias pendientes.
    ['avisos', '', '🔔'],
    ['ajustes', 'Ajustes', '⚙️'],
  ];
  return '<nav class="tabnav" aria-label="Navegación principal">' + tabs.map(([id, label, ico]) => {
    const badge = id === 'avisos' ? numSugerencias() : 0;
    const aria = id === 'avisos'
      ? 'Sugerencias' + (badge ? ' (' + badge + ' pendientes)' : '')
      : label;
    return '<button type="button" class="tab' + (active === id ? ' active' : '') + '" data-act="nav-' + id + '"' +
      (active === id ? ' aria-current="page"' : '') + ' aria-label="' + aria + '">' +
      '<span class="tico" aria-hidden="true">' + ico +
      (badge ? '<span class="tab-badge" aria-hidden="true">' + badge + '</span>' : '') + '</span>' +
      (label ? '<span>' + label + '</span>' : '') + '</button>';
  }).join('') + '</nav>';
}
function pantallaShell(active, inner) {
  return '<div class="screen has-nav"><div class="scroll">' + inner + '</div>' + navHTML(active) + '</div>';
}
function cargandoHTML(msg) {
  return '<div class="center-pad"><div class="spinner"></div><p class="muted">' + esc(msg || 'Cargando…') + '</p></div>';
}
// Vistos v2: mapa {pubkey: ts}; el ts (segundos) es el que usa el
// motor para la reaparición de dislikes a los 21 días.
function marcarVisto(pubkey) {
  S.vistos[pubkey] = Math.floor(Date.now() / 1000);
  LS.set('vistos', S.vistos);
}
function superlikeDisponible() {
  const s = LS.get('superlike', { fecha: '', n: 0 });
  return !(s.fecha === hoyISO() && s.n >= 1);
}
function marcarSuperlike() {
  LS.set('superlike', { fecha: hoyISO(), n: 1 });
}

// ---------- 1. inicio ----------
// Landing (v1.10.0): presenta la app SIN robarle prioridad a las
// acciones principales — héroe compacto (marca + 4 características
// en viñetas cortas) y los botones Crear cuenta / Ya tengo cuenta
// visibles sin hacer scroll en un móvil típico. El "¿Cómo
// funciona?" y el "¿Qué es Nostr?" quedan debajo, como explicación.
// Con sesión activa esta pantalla nunca se ve: boot entra directo.
function showInicio() {
  setScreenScope(null);
  S.screen = 'inicio';
  const cached = netcountFromCache(LS.get('netcount', null), Date.now());
  $('#app').innerHTML =
    '<div class="screen inicio" id="pantalla-inicio">' +
    '<div class="brand"><div class="logo">' + logoSVG(84) + '</div><h1>CubMatch</h1>' +
    '<p class="tagline">Conoce gente en Cuba, sin intermediarios.<br>Directo, gratis y sin VPN.</p></div>' +
    '<ul class="hero-features" aria-label="Características de CubMatch">' +
    '<li><span aria-hidden="true">🇨🇺</span><span>Perfiles de toda Cuba</span></li>' +
    '<li><span aria-hidden="true">🔒</span><span>Chat privado y cifrado</span></li>' +
    '<li><span aria-hidden="true">📞</span><span>Llamadas de voz y video</span></li>' +
    '<li><span aria-hidden="true">🆓</span><span>Gratis y sin intermediarios</span></li>' +
    '</ul>' +
    '<div class="inicio-btns">' +
    '<button type="button" class="btn primary big" data-act="ir-registro">Crear cuenta</button>' +
    '<button type="button" class="btn ghost big" data-act="ir-login">Ya tengo cuenta</button>' +
    '<button type="button" class="btn ghost big" data-act="compartir">📤 Compartir CubMatch</button>' +
    '</div>' +
    '<p class="netcount" id="netcount"' + (cached != null ? '' : ' hidden') + '>' +
    (cached != null ? '💘 Ya hay <b>' + cached + '</b> perfiles publicados en la red' : '') + '</p>' +
    '<div class="inicio-logo-big" aria-hidden="true">' + logoSVG(230, 'big') + '</div>' +
    '<section class="como-funciona" aria-label="Cómo funciona">' +
    '<h3>¿Cómo funciona?</h3>' +
    '<ul>' +
    '<li><span>💚</span><span><b>Sin servidores.</b> Tus datos viven en una red abierta que nadie controla ni puede apagar.</span></li>' +
    '<li><span>🔑</span><span><b>Tú tienes la llave.</b> Tu cuenta nace en tu teléfono: sin correo, sin número, sin tarjeta.</span></li>' +
    '<li><span>🇨🇺</span><span><b>Gratis y sin VPN.</b> Hecho para Cuba: funciona con tus datos móviles.</span></li>' +
    '</ul>' +
    '<details class="nostr-det"><summary>¿Qué es Nostr?</summary>' +
    '<p>La red abierta donde vive CubMatch. Como el correo electrónico, pero sin una empresa dueña: tu identidad es una llave que solo tú tienes.</p></details>' +
    '</section>' +
    '<nav class="foot-links" aria-label="Información">' +
    '<button type="button" class="link" data-act="info-seguridad">🛡️ Seguridad</button>' +
    '<span aria-hidden="true">·</span>' +
    '<button type="button" class="link" data-act="info-terminos">📄 Términos y privacidad</button>' +
    '</nav>' +
    '<p class="fine">Tu identidad vive en tu teléfono.<br>Sin servidores, sin tarjeta, sin rastreo.<br><span class="ver">v' + VERSION + '</span></p>' +
    '</div>';
  actualizarContadorRed();
}

// Contador de perfiles en la red (prueba social REAL): no bloquea la
// pantalla; usa caché de 1 h y consulta en segundo plano con un pool
// temporal de clave desechable (solo lectura). Si falla, el contador
// se oculta en silencio.
let netcountRun = 0;
async function actualizarContadorRed() {
  const run = ++netcountRun;
  const tmp = makePool(createIdentity('consulta').sk);
  try {
    tmp.acquire('discovery');
    const n = await fetchNetCount(tmp);
    if (run !== netcountRun || n == null || S.screen !== 'inicio') return;
    LS.set('netcount', { n, ts: Date.now() });
    const el = $('#netcount');
    if (el) {
      el.hidden = false;
      el.innerHTML = '💘 Ya hay <b>' + n + '</b> perfiles publicados en la red';
    }
  } catch {} finally {
    try { tmp.shutdown(); } catch {}
  }
}

// ---------- 2. cuenta: registro / login ----------
function showCuenta(modo) {
  setScreenScope(null);
  S.screen = 'cuenta';
  S.cuentaModo = modo || 'registro';
  const reg = S.cuentaModo === 'registro';
  $('#app').innerHTML =
    '<div class="screen"><div class="scroll"><div class="form-wrap">' +
    '<button type="button" class="link" data-act="ir-inicio">← Volver</button>' +
    '<h2>' + (reg ? 'Crea tu cuenta' : 'Entra a tu cuenta') + '</h2>' +
    '<p class="muted">' + (reg
      ? 'Tu usuario se reclama en la red; tu contraseña genera tu identidad.'
      : 'La misma contraseña de siempre recupera tu identidad en cualquier teléfono.') + '</p>' +
    (reg
      ? '<div class="warn-box" role="alert"><span class="warn-ico">⚠️</span><div>' +
        '<p><b>Sin recuperación.</b> Si olvidas tu contraseña, pierdes tu cuenta para siempre. Nadie —ni siquiera nosotros— puede devolvértela.</p>' +
        '<label class="check-row"><input type="checkbox" id="entiendo-check"> <span>Entiendo que si olvido mi contraseña pierdo mi cuenta: nadie puede recuperarla.</span></label>' +
        '</div></div>'
      : '') +
    '<form id="cuenta-form" autocomplete="off">' +
    '<label>Usuario<input name="usuario" id="cuenta-usuario" type="text" inputmode="latin" autocapitalize="none" autocomplete="username" placeholder="ej: marlon92" required></label>' +
    '<div class="field-status" id="usuario-status" aria-live="polite"></div>' +
    '<label>Contraseña<span class="pw-wrap"><input name="clave" id="cuenta-clave" type="password" autocomplete="' + (reg ? 'new-password' : 'current-password') + '" placeholder="mínimo 8 caracteres" required>' +
    '<button type="button" class="pw-eye" data-act="toggle-clave" aria-label="Mostrar contraseña">👁️</button></span></label>' +
    (reg ? '<div class="pw-meter" id="pw-meter" hidden><div class="pw-bar"><span id="pw-bar-fill"></span></div><small id="pw-label"></small></div>' : '') +
    '<div class="error-box" id="cuenta-error" hidden></div>' +
    '<button type="submit" class="btn primary big" id="cuenta-btn">' + (reg ? 'Crear cuenta' : 'Entrar') + '</button>' +
    '</form>' +
    '<p class="center muted">' + (reg
      ? '¿Ya tienes cuenta? <button type="button" class="link" data-act="ir-login">Entra aquí</button>'
      : '¿No tienes cuenta? <button type="button" class="link" data-act="ir-registro">Crea una</button>') + '</p>' +
    '</div></div></div>';
  wireCuentaInputs();
}

// Validación en vivo del formulario de cuenta (no interfiere con el
// submit: es solo feedback visual). Los timers se limpian en dispose().
let cuentaTimers = [];
function wireCuentaInputs() {
  for (const t of cuentaTimers) clearTimeout(t);
  cuentaTimers = [];
  const form = $('#cuenta-form');
  if (!form) return;
  // Selectores explícitos (no acceso nombrado legacy form.x: no funciona
  // en todos los motores y es frágil).
  const uIn = $('#cuenta-usuario', form);
  const cIn = $('#cuenta-clave', form);
  const status = $('#usuario-status');
  let checkSeq = 0;
  if (uIn && status) {
    uIn.addEventListener('input', () => {
      const v = uIn.value;
      status.className = 'field-status';
      if (!v.trim()) { status.textContent = ''; return; }
      let uname;
      try { uname = normalizeUsername(v); }
      catch { status.textContent = '⚠️ Formato: 3-20 caracteres (letras, números, . _ -)'; status.classList.add('bad'); return; }
      status.textContent = 'Comprobando disponibilidad…';
      for (const t of cuentaTimers) clearTimeout(t);
      cuentaTimers = [];
      const seq = ++checkSeq;
      cuentaTimers.push(setTimeout(async () => {
        const tmp = makePool(createIdentity('consulta').sk);
        try {
          tmp.acquire('discovery');
          const r = await checkUsername(tmp, uname);
          if (seq !== checkSeq || S.screen !== 'cuenta') return;
          if (r === 'tomado') { status.textContent = '✗ Ese usuario ya está en uso'; status.classList.add('bad'); }
          else if (r === 'sin-red') { status.textContent = 'Sin conexión para verificar ahora'; }
          else { status.textContent = '✓ Usuario disponible'; status.classList.add('ok'); }
        } catch { /* silencio: es solo feedback */ }
        finally { try { tmp.shutdown(); } catch {} }
      }, 600));
    });
  }
  const meter = $('#pw-meter');
  if (meter && cIn) {
    cIn.addEventListener('input', () => {
      const pw = cIn.value;
      if (!pw) { meter.hidden = true; return; }
      const { score, label } = passwordStrength(pw);
      meter.hidden = false;
      const fill = $('#pw-bar-fill');
      const lab = $('#pw-label');
      if (fill) { fill.style.width = ((score + 1) / 4 * 100) + '%'; fill.className = 'f' + score; }
      if (lab) { lab.textContent = 'Contraseña ' + label; lab.className = 's' + score; }
    });
  }
}

function cuentaError(msg) {
  const box = $('#cuenta-error');
  if (!box) return;
  box.hidden = false;
  box.textContent = msg;
}

async function submitCuenta() {
  const form = $('#cuenta-form');
  const btn = $('#cuenta-btn');
  const usuarioRaw = form.querySelector('[name=usuario]').value;
  const clave = form.querySelector('[name=clave]').value;
  $('#cuenta-error').hidden = true;
  let username;
  try {
    username = normalizeUsername(usuarioRaw);
    validatePassword(clave);
  } catch (e) {
    cuentaError(e.message);
    return;
  }
  if (S.cuentaModo === 'registro') {
    const chk = $('#entiendo-check');
    if (!chk || !chk.checked) {
      cuentaError('Marca la casilla "Entiendo…" para continuar.');
      return;
    }
  }
  btn.disabled = true;
  btn.textContent = 'Derivando tu identidad…';
  try {
    const sk = await deriveSecretKey(username, clave);
    btn.textContent = 'Conectando a la red…';
    const tmp = makePool(sk);
    tmp.acquire('discovery');
    tmp.acquire('messaging');
    try {
      const claim = await fetchUsernameClaim(tmp, username);
      if (S.cuentaModo === 'registro') {
        // M4: un reclamo pelado (sin documentos ni perfil del reclamante)
        // no ocupa el nombre; solo un reclamante corroborado lo bloquea.
        if (claim && await nombreOcupado(tmp, claim)) throw new Error('Ese usuario ya está tomado. Prueba con otro.');
        btn.textContent = 'Reclamando tu usuario…';
        await tmp.publishAll(buildClaimEvent(username));
        // Documentos de identidad: NIP-65 (10002, mis relays) e inbox
        // NIP-17 (10050, dónde recibo DMs). Best-effort: los fallbacks
        // de lectura cubren si algún relay falla aquí.
        try {
          await publishIdentityDocs(tmp);
          try { LS.set(LS_MI_INBOX, RELAYS.messaging.slice()); } catch {}
        } catch (e) { console.warn('[cubmatch] 10002/10050 no publicados', e); }
      } else {
        const { pubkey } = importIdentity(nsecOf(sk));
        if (!verifyCredentials(pubkey, claim)) {
          throw new Error('Usuario o contraseña incorrectos.');
        }
      }
    } finally {
      tmp.shutdown();
    }
    btn.textContent = 'Listo ✓';
    await enterApp(username, sk);
  } catch (e) {
    const msg = /fetch|network|relays|conexión|tiempo/i.test(e.message || '')
      ? 'Sin conexión a los relays. Revisa tu internet e intenta de nuevo.'
      : (e.message || 'Algo salió mal. Intenta de nuevo.');
    cuentaError(msg);
    btn.disabled = false;
    btn.textContent = S.cuentaModo === 'registro' ? 'Crear cuenta' : 'Entrar';
  }
}

async function enterApp(username, sk) {
  const id = importIdentity(nsecOf(sk));
  LS.set('sesion', { username, nsec: nsecOf(sk) });
  S.username = username;
  S.sk = sk;
  S.pubkey = id.pubkey;
  S.npub = id.npub;
  if (S.pool) { try { stopGlobalLive(); } catch {} try { S.pool.shutdown(); } catch {} }
  S.pool = makePool(sk);
  S.chats = chatsLS();
  setScreenScope('discovery');
  $('#app').innerHTML = '<div class="screen">' + cargandoHTML('Buscando tu perfil…') + '</div>';
  let mine = null;
  try { mine = await fetchMyPerfil(); } catch {}
  if (mine && mine.profile) {
    S.miPerfil = mine.profile;
    S.perfilPublicado = true;
  } else {
    // Sin perfil publicado (o sin red para leerlo): NUNCA se abre
    // solo el asistente de completar perfil (v1.10.0, era lo que
    // molestaba al entrar). Se entra a la app con el borrador local
    // y las sugerencias viven en la pestaña 🔔.
    S.borrador = LS.get('perfil', null) || newProfile();
    S.miPerfil = S.borrador;
    S.perfilPublicado = false;
  }
  showDeck();
  startCalls();
  startPresencia();
  startGlobalLive();
  migrarInboxSiToca();
}

async function restoreSession(ses) {
  try {
    const id = importIdentity(ses.nsec);
    S.username = ses.username;
    S.sk = id.sk;
    S.pubkey = id.pubkey;
    S.npub = id.npub;
    S.pool = makePool(id.sk);
    S.chats = chatsLS();
    setScreenScope('discovery');
    $('#app').innerHTML = '<div class="screen">' + cargandoHTML('Reconectando…') + '</div>';
    let mine = null;
    try { mine = await fetchMyPerfil(); } catch {}
    if (mine && mine.profile) {
      S.miPerfil = mine.profile;
      S.perfilPublicado = true;
    } else {
      // Igual que en enterApp: sin asistente automático (v1.10.0).
      S.borrador = LS.get('perfil', null) || newProfile();
      S.miPerfil = S.borrador;
      S.perfilPublicado = false;
    }
    showDeck();
    startCalls();
    startPresencia();
    startGlobalLive();
    migrarInboxSiToca();
  } catch {
    LS.del('sesion');
    showInicio();
    toast('No se pudo restaurar la sesión. Entra de nuevo.');
  }
}

function fetchMyPerfil() {
  return new Promise((resolve) => {
    let best = null;
    const vistos = new Set(); // ids ya verificados en esta suscripción
    const sub = S.pool.discovery().subscribe(
      [{ kinds: [KIND_PERFIL], authors: [S.pubkey], limit: 1 }],
      (ev) => {
        if (!ev || typeof ev.id !== 'string' || vistos.has(ev.id)) return;
        vistos.add(ev.id);
        if (!eventoValido(ev)) { console.warn('[cubmatch] perfil propio con firma inválida, descartado:', ev.id); return; }
        const p = parsePerfilEvent(ev);
        if (p && (!best || ev.created_at > best.created_at)) best = p;
      }
    );
    sub.eose().then(() => { sub.unsub(); resolve(best); });
  });
}

// ---------- 3. onboarding (8 pasos) ----------
const OB_TITULOS = [
  'Identidad', 'Físico', 'Educación y trabajo', 'Estilo de vida',
  'Valores y personalidad', 'Intereses', 'Sobre ti', 'Preferencias',
];

function showOnboarding() {
  setScreenScope(null);
  S.screen = 'onboarding';
  if (!S.borrador) S.borrador = LS.get('perfil', null) || newProfile();
  $('#app').innerHTML =
    '<div class="screen"><div class="scroll"><div class="form-wrap">' +
    '<div class="ob-head"><span id="ob-paso"></span><span id="ob-pct" class="pct"></span></div>' +
    '<div class="prog"><div class="prog-fill" id="ob-prog"></div></div>' +
    '<h2 id="ob-titulo"></h2>' +
    '<div id="ob-body"></div>' +
    '<div class="error-box" id="ob-errores" hidden></div>' +
    '<div class="ob-nav">' +
    '<button type="button" class="btn ghost" data-act="ob-atras">Atrás</button>' +
    '<button type="button" class="btn primary" data-act="ob-siguiente" id="ob-next">Siguiente</button>' +
    '</div>' +
    '</div></div></div>';
  renderObPaso();
}

function updateProgress() {
  const pct = completitud(S.borrador);
  const bar = $('#ob-prog');
  const lab = $('#ob-pct');
  if (bar) bar.style.width = pct + '%';
  if (lab) lab.textContent = pct + '% completo';
}

function renderObPaso() {
  const paso = S.obPaso;
  $('#ob-paso').textContent = 'Paso ' + paso + ' de 8';
  $('#ob-titulo').textContent = OB_TITULOS[paso - 1];
  $('#ob-next').textContent = paso === 8 ? 'Publicar mi perfil' : 'Siguiente';
  $('#ob-errores').hidden = true;
  $('#ob-body').innerHTML = OB_STEPS[paso - 1]();
  updateProgress();
  const bio = $('#bio-count');
  if (bio) bio.textContent = String(S.borrador.bio || '').length + '/' + MAX_BIO;
}

function selectHTML(f, list, cur, placeholder) {
  const opts = list.map((item) => {
    const v = typeof item === 'object' ? item.id : item;
    const l = typeof item === 'object' ? item.label : item;
    return '<option value="' + esc(v) + '"' + (String(v) === String(cur ?? '') ? ' selected' : '') + '>' + esc(l) + '</option>';
  }).join('');
  return '<select data-f="' + f + '"><option value="">' + esc(placeholder || '— elige —') + '</option>' + opts + '</select>';
}
function field(label, inner) {
  return '<label class="fld"><span>' + esc(label) + '</span>' + inner + '</label>';
}
function chipsHTML(name, list, selected) {
  return '<div class="chips">' + list.map((item) => {
    const id = typeof item === 'object' ? item.id : item;
    const l = typeof item === 'object' ? item.label : item;
    const on = (selected || []).includes(id) ? ' sel' : '';
    return '<button type="button" class="chip' + on + '" data-chip="' + esc(name) + ':' + esc(id) + '">' + esc(l) + '</button>';
  }).join('') + '</div>';
}

const OB_STEPS = [
  // 1 Identidad
  () => {
    const d = S.borrador;
    return field('Apodo', '<input data-f="apodo" type="text" value="' + esc(d.apodo) + '" placeholder="¿Cómo te dicen?" maxlength="30">') +
      field('Edad', '<input data-f="edad" type="number" min="18" max="99" value="' + esc(d.edad) + '" placeholder="18+">') +
      field('Género', selectHTML('genero', GENEROS, d.genero)) +
      field('Orientación', selectHTML('orientacion', ORIENTACIONES, d.orientacion)) +
      field('Provincia', selectHTML('provincia', PROVINCIAS, d.provincia)) +
      field('Municipio', '<input data-f="municipio" type="text" value="' + esc(d.municipio) + '" placeholder="Ej: Palma Soriano">');
  },
  // 2 Físico
  () => {
    const d = S.borrador;
    return field('Estatura (cm)', '<input data-f="estatura" type="number" min="130" max="230" value="' + esc(d.estatura) + '" placeholder="Ej: 175">') +
      field('Complexión', selectHTML('complexion', COMPLEXIONES, d.complexion)) +
      field('Color de ojos', selectHTML('ojos', OJOS, d.ojos)) +
      field('Piel', selectHTML('piel', PIEL, d.piel)) +
      field('Cabello', selectHTML('cabello', CABELLO, d.cabello));
  },
  // 3 Educación y trabajo
  () => {
    const d = S.borrador;
    return field('Nivel de educación', selectHTML('educacion', EDUCACION, d.educacion)) +
      field('Profesión / oficio', '<input data-f="profesion" type="text" value="' + esc(d.profesion) + '" placeholder="Ej: enfermera, mecánico…">') +
      field('Sector', selectHTML('sector', SECTORES, d.sector));
  },
  // 4 Estilo de vida
  () => {
    const d = S.borrador;
    const sino = (f, v) => selectHTML(f, ['Sí', 'No'], v);
    return field('¿Fumas?', selectHTML('fumador', ['No', 'Ocasionalmente', 'Sí'], d.fumador)) +
      field('¿Bebes?', selectHTML('bebedor', ['No', 'Ocasionalmente', 'Sí'], d.bebedor)) +
      field('¿Haces deporte?', selectHTML('deporte', ['Sí', 'A veces', 'No'], d.deporte)) +
      field('Religión / creencia', '<input data-f="religion" type="text" value="' + esc(d.religion) + '" placeholder="Opcional">') +
      field('¿Tienes hijos?', selectHTML('hijosTiene', ['No tengo', 'Tengo'], d.hijosTiene)) +
      field('¿Quieres hijos?', selectHTML('hijosQuiere', ['Sí', 'No', 'Tal vez'], d.hijosQuiere)) +
      field('¿Mascotas?', sino('mascotas', d.mascotas));
  },
  // 5 Valores y personalidad
  () => {
    const d = S.borrador;
    const sliders = RASGOS.map((r) => {
      const v = +(getPath(d, 'rasgos.' + r.id) ?? 3);
      return '<div class="slider-row"><span>' + esc(r.label) + '</span>' +
        '<input type="range" min="1" max="5" step="1" value="' + v + '" data-f="rasgos.' + r.id + '">' +
        '<b data-out="rasgos.' + r.id + '">' + v + '</b></div>';
    }).join('');
    return '<p class="fld-label">¿Qué valoras? (elige varios)</p>' + chipsHTML('valores', VALORES, d.valores) +
      '<p class="fld-label">¿Cómo eres? (1 = poco, 5 = mucho)</p><div class="sliders">' + sliders + '</div>';
  },
  // 6 Intereses
  () => {
    const d = S.borrador;
    return '<p class="fld-label">¿Qué te gusta? (elige varios)</p>' + chipsHTML('intereses', INTERESES, d.intereses) +
      field('Tags libres (separados por coma, máx ' + MAX_TAGS + ')',
        '<input data-f="tags" type="text" data-split="1" value="' + esc((d.tags || []).join(', ')) + '" placeholder="Ej: café, malecón, trova">');
  },
  // 7 Sobre ti
  () => {
    const d = S.borrador;
    let prompts = '';
    for (let i = 0; i < 3; i++) {
      const pr = (d.prompts || [])[i] || { q: '', a: '' };
      prompts += '<div class="prompt-row">' + selectHTML('prompts.' + i + '.q', PROMPTS, pr.q, '— elige un prompt —') +
        '<input data-f="prompts.' + i + '.a" type="text" value="' + esc(pr.a) + '" placeholder="Tu respuesta…"></div>';
    }
    return field('Tu bio',
      '<textarea data-f="bio" rows="4" maxlength="' + MAX_BIO + '" placeholder="Cuéntale al mundo quién eres…">' + esc(d.bio) + '</textarea>' +
      '<small class="count" id="bio-count"></small>') +
      '<p class="fld-label">Prompts (opcional)</p>' + prompts +
      field('Descríbete en 3 palabras', '<input data-f="tresPalabras" type="text" value="' + esc(d.tresPalabras) + '" placeholder="Ej: alegre, sincero, soñador">') +
      field('Foto (URL opcional)', '<input data-f="fotoURL" type="url" inputmode="url" value="' + esc(d.fotoURL) + '" placeholder="https://…">') +
      '<div class="foto-subida">' +
      '<img id="foto-preview" class="foto-preview" alt="Vista previa de tu foto" src="' + esc(d.fotoURL) + '"' + (d.fotoURL ? '' : ' hidden') + '>' +
      '<label class="btn ghost foto-btn" for="foto-file">📷 Subir desde la galería</label>' +
      '<input type="file" id="foto-file" accept="image/*" hidden>' +
      '<small class="foto-estado" id="foto-estado" role="status"></small>' +
      '</div>' +
      '<label class="check"><input type="checkbox" data-f="mostrarEdad"' + (d.mostrarEdad !== false ? ' checked' : '') + '> Mostrar mi edad en el perfil</label>';
  },
  // 8 Preferencias
  () => {
    const d = S.borrador;
    const p = d.prefs || {};
    return '<div class="row2">' +
      field('Edad mínima', '<input data-f="prefs.edadMin" type="number" min="18" max="99" value="' + esc(p.edadMin ?? 18) + '">') +
      field('Edad máxima', '<input data-f="prefs.edadMax" type="number" min="18" max="99" value="' + esc(p.edadMax ?? 99) + '">') +
      '</div>' +
      '<p class="fld-label">Busco</p>' + chipsHTML('prefs.generos', GENEROS, p.generos) +
      field('Distancia', selectHTML('prefs.distancia', DISTANCIAS, p.distancia || 'cuba')) +
      '<p class="fld-label">Tipo de relación</p>' + chipsHTML('prefs.relacion', RELACIONES, p.relacion);
  },
];

function onDraftInput(e) {
  const t = e.target;
  if (!t || !t.dataset) return;
  if (S.screen !== 'onboarding' || !S.borrador) return;
  if (t.dataset.chip) return;
  let handled = false;
  if (t.dataset.f) {
    let v;
    if (t.type === 'checkbox') v = t.checked;
    else if (t.dataset.split) v = t.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_TAGS);
    else if (t.type === 'number' || t.type === 'range') v = t.value === '' ? '' : Number(t.value);
    else v = t.value;
    // prompts: data-f="prompts.0.a" -> asegurar objeto
    const m = /^prompts\.(\d+)\.([qa])$/.exec(t.dataset.f);
    if (m) {
      const i = +m[1];
      S.borrador.prompts = S.borrador.prompts || [];
      S.borrador.prompts[i] = S.borrador.prompts[i] || { q: '', a: '' };
      S.borrador.prompts[i][m[2]] = v;
    } else {
      setPath(S.borrador, t.dataset.f, v);
    }
    handled = true;
    if (t.type === 'range') {
      const out = document.querySelector('[data-out="' + CSS.escape(t.dataset.f) + '"]');
      if (out) out.textContent = t.value;
    }
    if (t.dataset.f === 'bio') {
      const c = $('#bio-count');
      if (c) c.textContent = String(t.value).length + '/' + MAX_BIO;
    }
  } else if (t.dataset.pq !== undefined || t.dataset.pa !== undefined) {
    handled = true; // legado: no se usa (los prompts usan data-f)
  }
  if (handled) {
    LS.set('perfil', S.borrador);
    updateProgress();
  }
}

// Subida de foto desde la galería (v1.5.0): el input #foto-file no lleva
// data-f, así que onDraftInput lo ignora y este es su flujo propio:
// vista previa inmediata → compresión en el cliente → subida a Blossom
// firmada con la identidad del usuario → la URL resultante cae en el
// campo fotoURL y en el borrador (el perfil se publica como siempre,
// solo con la URL). Si la subida falla, el campo queda como estaba.
async function onFotoChange(e) {
  const input = e.target;
  if (!input || input.id !== 'foto-file') return;
  if (S.screen !== 'onboarding' || !S.borrador || !S.sk) return;
  const file = input.files && input.files[0];
  if (!file) return;
  const estado = $('#foto-estado');
  try {
    const fr = new FileReader();
    fr.onload = () => {
      const img = $('#foto-preview');
      if (img) { img.src = String(fr.result); img.hidden = false; }
    };
    fr.readAsDataURL(file);
  } catch {}
  if (estado) estado.textContent = 'Subiendo…';
  try {
    const blob = await preparePhotoBlob(file);
    const url = await uploadPhoto(blob, S.sk);
    const urlInput = $('input[data-f="fotoURL"]');
    if (urlInput) urlInput.value = url;
    S.borrador.fotoURL = url;
    LS.set('perfil', S.borrador);
    updateProgress();
    const img = $('#foto-preview');
    if (img) { img.src = url; img.hidden = false; }
    if (estado) estado.textContent = '¡Foto subida! ✅ Ya está en tu perfil.';
  } catch {
    if (estado) estado.textContent = 'No se pudo subir la foto; revisa tu conexión o pega una URL.';
  } finally {
    input.value = ''; // permite volver a elegir el mismo archivo
  }
}

function toggleChip(btn) {
  const [name, id] = btn.dataset.chip.split(':');
  if (S.screen !== 'onboarding' || !S.borrador) return;
  let arr = getPath(S.borrador, name);
  if (!Array.isArray(arr)) { arr = []; setPath(S.borrador, name, arr); }
  const i = arr.indexOf(id);
  if (i >= 0) { arr.splice(i, 1); btn.classList.remove('sel'); }
  else { arr.push(id); btn.classList.add('sel'); }
  LS.set('perfil', S.borrador);
  updateProgress();
}

function obAtras() {
  if (S.obPaso > 1) {
    S.obPaso--;
    renderObPaso();
  } else if (S.miPerfil) {
    showAjustes();
  } else {
    showInicio();
  }
}

async function obSiguiente() {
  if (S.obPaso < 8) {
    S.obPaso++;
    renderObPaso();
    $('.scroll').scrollTop = 0;
    return;
  }
  // paso 8: publicar
  const btn = $('#ob-next');
  const box = $('#ob-errores');
  const errores = validateProfile(S.borrador);
  if (errores.length) {
    box.hidden = false;
    box.innerHTML = '<ul>' + errores.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
    box.scrollIntoView();
    return;
  }
  box.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Publicando…';
  try {
    S.borrador.prompts = (S.borrador.prompts || []).filter((p) => p && (p.q || p.a));
    S.borrador.oculto = !!(S.miPerfil && S.miPerfil.oculto);
    await publishPerfilAndDocs(S.borrador);
    S.miPerfil = clone(S.borrador);
    S.perfilPublicado = true;
    LS.set('perfil', S.borrador);
    toast('¡Tu perfil ya está en la red! 🎉');
    showDeck();
  } catch {
    toast('Sin conexión a los relays. Intenta de nuevo.');
    btn.disabled = false;
    btn.textContent = 'Publicar mi perfil';
  }
}

// ---------- datos compartidos deck / top10 / matches ----------
// Caché-primero + sync incremental (v1.1, fix M8): la UI muestra la caché
// local al instante y sincroniza en segundo plano pidiendo a los relays
// solo lo nuevo (since = última sincronización). Ahorra datos móviles.
const LS_PERFILES = 'cache_perfiles';
const LS_LIKES = 'cache_likes';
const LS_SYNC_D = 'lastSync_descubrimiento';
const LS_MI_INBOX = 'mi_inbox_relays'; // messaging con el que publiqué mi 10050

function buildDiscoveryData(me, perfiles, likes) {
  S.perfilCache = new Map(perfiles.map((p) => [p.pubkey, p]));
  const others = perfiles.map((p) => ({ pubkey: p.pubkey, profile: p.profile, created_at: p.created_at }));
  const corpus = buildCorpus([S.miPerfil, ...perfiles.map((p) => p.profile)]);
  const ctx = { corpus, likes, nowMs: Date.now() };
  return { perfiles, likes, corpus, ctx, me, others };
}

function meCtx() {
  return { pubkey: S.pubkey, profile: S.miPerfil, bloqueados: S.bloqueados, vistos: S.vistos };
}

async function ensureData({ force = false } = {}) {
  if (S.data && !force) return S.data;
  const me = meCtx();
  if (!force) {
    const cachedPerfiles = LS.get(LS_PERFILES, []);
    if (cachedPerfiles.length) {
      // Caché al instante; el resto llega en segundo plano.
      S.data = buildDiscoveryData(me, cachedPerfiles, LS.get(LS_LIKES, { sent: {}, received: {} }));
      syncDiscoveryBackground();
      return S.data;
    }
  }
  return refreshDiscovery(me, force);
}

async function refreshDiscovery(me, force = false) {
  const limit = S.datosBajos ? 120 : 400;
  const since = force ? 0 : LS.get(LS_SYNC_D, 0);
  const t0 = Math.floor(Date.now() / 1000);
  const [freshP, freshL] = await Promise.all([
    fetchPerfiles(S.pool, { limit, since, excludeSelf: S.pubkey }),
    fetchLikes(S.pool, S.pubkey, { since }),
  ]);
  const perfiles = force ? freshP : mergePerfiles(LS.get(LS_PERFILES, []), freshP);
  const likes = force ? freshL : mergeLikes(LS.get(LS_LIKES, { sent: {}, received: {} }), freshL);
  LS.set(LS_PERFILES, perfiles);
  LS.set(LS_LIKES, likes);
  // Solape de 120 s: si un evento nació durante el fetch, el próximo
  // since lo vuelve a traer (el dedup por id lo absorbe).
  LS.set(LS_SYNC_D, Math.max(0, t0 - 120));
  S.data = buildDiscoveryData(me, perfiles, likes);
  return S.data;
}

// Sincronización en segundo plano tras mostrar la caché: actualiza S.data
// y refresca la pantalla visible sin saltos (se conserva la posición).
async function syncDiscoveryBackground() {
  try {
    await refreshDiscovery(meCtx(), false);
    if (!S.data) return;
    if (S.screen === 'deck') {
      S.candidatos = rankCandidates(S.data.me, S.data.others, S.data.ctx);
      S.leGustas = likesYou(S.data.me, S.data.others, S.data.ctx);
      renderLeGustas();
      if (S.idx >= S.candidatos.length) S.idx = Math.max(0, S.candidatos.length - 1);
      const sub = $('#deck-sub');
      if (sub && S.candidatos.length) {
        sub.textContent = esDesktop()
          ? S.candidatos.length + ' perfiles para ti · actualizado ✓'
          : 'Perfil ' + (S.idx + 1) + ' de ' + S.candidatos.length + ' · actualizado ✓';
      }
    } else if (S.screen === 'top10') {
      S.top = topDaily(S.data.me, S.data.others, S.data.ctx, 10);
      renderTop();
    } else if (S.screen === 'matches') {
      loadMatches();
    }
  } catch { /* la caché sigue visible; se reintenta en la próxima pantalla */ }
}

// "Re-descubrir" / "Actualizar": borra caché y lastSync, descarga todo.
function forceRefresh() {
  S.data = null;
  LS.del(LS_PERFILES);
  LS.del(LS_LIKES);
  LS.del(LS_SYNC_D);
}

// Publicar perfil + documentos de identidad (10002/10050). Los documentos
// son best-effort: si fallan, los fallbacks de lectura lo cubren.
async function publishPerfilAndDocs(profile) {
  await publishPerfil(S.pool, profile);
  try {
    await publishIdentityDocs(S.pool);
    try { LS.set(LS_MI_INBOX, S.pool.roles.messaging.slice()); } catch {}
  }
  catch (e) { console.warn('[cubmatch] 10002/10050 no publicados', e); }
}

// Migración de relays de DM (v1.8.2): si mi 10050 quedó publicado con un
// scope messaging distinto del actual (p. ej. con relay.nostr.band, que
// dejó de conectar), republicarlo con la lista nueva al entrar. La lista
// con la que publiqué por última vez vive en localStorage; quien viene
// de versiones viejas no la tiene y migra una sola vez. Best-effort y
// sin bloquear la entrada: si falla, se reintenta en el próximo arranque.
function migrarInboxSiToca() {
  migrarInboxSiDesactualizado(S.pool, {
    get: () => LS.get(LS_MI_INBOX, null),
    set: (relays) => LS.set(LS_MI_INBOX, relays),
  }).catch((e) => console.warn('[cubmatch] migración de inbox (10050) falló', e));
}

// ---------- 4. deck ----------
function showDeck() {
  setScreenScope('discovery');
  stopChat();
  S.screen = 'deck';
  if (!S.miPerfil) {
    // Red de seguridad: sin perfil a mano se entra con el borrador
    // local — jamás se abre solo el asistente (v1.10.0).
    S.miPerfil = LS.get('perfil', null) || newProfile();
    S.perfilPublicado = false;
  }
  $('#app').innerHTML = pantallaShell('deck',
    '<div class="deck-head"><div class="deck-title">' + logoSVG(30, 'deck') + '<div><h2>Descubrir</h2><p class="muted" id="deck-sub">Buscando perfiles…</p></div></div></div>' +
    '<div id="deck-aviso">' + avisoMatchingHTML() + '</div>' +
    '<div id="deck-legustas"></div>' +
    '<div id="deck-body">' + cargandoHTML('Conectando a los relays…') + '</div>');
  loadDeck();
}

// Aviso de matching en Descubrir (v1.10.0): UNA sola línea discreta
// si el perfil aún no llega al 70% (por debajo no aparece en el
// matching). Sustituye a la antigua tarjeta "Completa tu perfil" y
// a su banner: las sugerencias completas viven ahora en la 🔔.
function avisoMatchingHTML() {
  if (!S.miPerfil) return '';
  const pct = completitud(S.miPerfil);
  if (pct >= MIN_COMPLETITUD) return '';
  return '<p class="deck-aviso">📣 Tu perfil aún no aparece en el matching (' + pct +
    '% completo). Mira las sugerencias en la pestaña 🔔 para terminarlo.</p>';
}

// ---------- pestaña 🔔: sugerencias de la página (v1.10.0) ----------
// Una sugerencia por cada cosa que falta del perfil (la misma
// cuenta de la insignia), cada una con su botón Completar que salta
// al paso correcto del editor. Perfil completo → estado amable.
function showAvisos() {
  setScreenScope('discovery');
  stopChat();
  S.screen = 'avisos';
  const p = S.miPerfil;
  const pct = p ? completitud(p) : 0;
  const faltan = p ? camposFaltantes(p) : [];
  let inner = '<div class="aj-wrap"><h2>🔔 Sugerencias</h2>';
  if (!faltan.length) {
    inner += '<div class="center-pad"><p class="big">🎉</p>' +
      '<p><b>Tu perfil está completo 🎉</b></p>' +
      '<p class="muted">No tienes sugerencias pendientes. ¡A conocer gente!</p></div>';
  } else {
    inner += '<p class="muted">Tu perfil va por el <b>' + pct + '%</b>. Esto es lo que te falta — ' +
      'toca <b>Completar</b> y saltas justo a ese paso:</p>' +
      '<div class="prog" style="margin:10px 0 14px"><div class="prog-fill" style="width:' + pct + '%"></div></div>' +
      '<ul class="guia-list">' +
      faltan.map((f) =>
        '<li class="guia-item"><span>' + esc(f.label) + '</span>' +
        '<button type="button" class="btn ghost sm" data-act="sug-ir" data-paso="' + f.paso + '">Completar</button></li>'
      ).join('') +
      '</ul>';
  }
  inner += '</div>';
  $('#app').innerHTML = pantallaShell('avisos', inner);
}

function irAPasoEditor(paso) {
  S.borrador = LS.get('perfil', null) || (S.miPerfil ? clone(S.miPerfil) : newProfile());
  S.obPaso = Math.max(1, Math.min(8, paso || 1));
  showOnboarding();
}

async function loadDeck() {
  const body = $('#deck-body');
  try {
    const d = await ensureData();
    S.candidatos = rankCandidates(d.me, d.others, d.ctx);
    S.leGustas = likesYou(d.me, d.others, d.ctx);
    S.idx = 0;
    renderLeGustas();
    renderDeckBody();
  } catch {
    if (!body) return;
    body.innerHTML = '<div class="center-pad"><p>😕 Sin conexión a los relays.</p>' +
      '<button type="button" class="btn primary" data-act="deck-recargar">Reintentar</button></div>';
  }
}

function curCand() { return S.candidatos[S.idx]; }

// ---------- fila "Le gustas" ----------
// Quien ya me dio like NO compite en el mazo: aparece aquí arriba,
// solo con los filtros duros. Like de vuelta = match seguro (el suyo
// ya está); dislike = respondido y sale de la fila (con la regla
// general de reaparición de dislikes a los 21 días).
function lgCardHTML(item) {
  const p = item.other.profile;
  const pk = esc(item.other.pubkey);
  return '<div class="lg-card">' +
    avatarImg(item.other.pubkey, p, 'avatar') +
    '<div class="lg-main"><b>' + esc(p.apodo || '¿?') + '</b>' +
    '<small class="muted">' + lugar(p) + '</small></div>' +
    '<div class="lg-actions">' +
    '<button type="button" class="btn round sm dislike" data-act="lg-no" data-peer="' + pk + '" title="No me interesa" aria-label="No me interesa">✕</button>' +
    '<button type="button" class="btn round sm like" data-act="lg-si" data-peer="' + pk + '" title="Me gusta" aria-label="Me gusta">♥</button>' +
    '</div></div>';
}

function renderLeGustas() {
  const box = $('#deck-legustas');
  if (!box) return;
  if (!S.leGustas || !S.leGustas.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<section class="legustas" aria-label="Personas a las que les gustas">' +
    '<h3>💘 Le gustas</h3>' +
    '<p class="muted">Estas personas ya te dieron ♥. Si les das ♥ de vuelta, ¡es match!</p>' +
    '<div class="lg-row">' + S.leGustas.map(lgCardHTML).join('') + '</div></section>';
}

async function lgAction(peerPubkey, like) {
  try {
    if (like) {
      await sendLike(S.pool, peerPubkey, {});
      S.data.likes.sent[peerPubkey] = { tipo: '+', superlike: false, ts: Math.floor(Date.now() / 1000) };
    } else {
      await sendDislike(S.pool, peerPubkey);
      S.data.likes.sent[peerPubkey] = { tipo: '-', superlike: false, ts: Math.floor(Date.now() / 1000) };
    }
    marcarVisto(peerPubkey);
    S.leGustas = S.leGustas.filter((x) => x.other.pubkey !== peerPubkey);
    renderLeGustas();
    // Está en "Le gustas" porque ya me dio '+': mi like es match mutuo.
    if (like) showMatchOverlay(peerPubkey);
  } catch {
    toast('Sin conexión a los relays. Intenta de nuevo.');
  }
}

function cardHTML(c) {
  const p = c.other.profile;
  const prompts = (p.prompts || []).filter((x) => x && x.q).slice(0, 3).map((x) =>
    '<div class="prompt"><b>' + esc(x.q) + '</b><span>' + esc(x.a || '') + '</span></div>').join('');
  const chips = [...(p.valores || []), ...(p.intereses || [])].slice(0, 10)
    .map((v) => '<span class="chip mini">' + esc(v) + '</span>').join('');
  return '<div class="tarjeta">' +
    '<div class="t-foto">' + avatarImg(c.other.pubkey, p, 'avatar big') +
    '<div class="' + compatCls(c) + '">' + compatTxt(c) + '</div></div>' +
    '<div class="t-body">' +
    '<h3>' + nombreEdad(p) + '</h3>' +
    '<p class="muted">📍 ' + lugar(p) + '</p>' +
    (p.bio ? '<p class="bio">' + esc(p.bio) + '</p>' : '') +
    (p.tresPalabras ? '<p class="trespal">“' + esc(p.tresPalabras) + '”</p>' : '') +
    prompts +
    (chips ? '<div class="chips static">' + chips + '</div>' : '') +
    '</div>' +
    '<div class="t-actions">' +
    '<button type="button" class="btn round dislike" data-act="deck-no" title="No me interesa" aria-label="No me interesa">✕</button>' +
    '<button type="button" class="btn round info" data-act="deck-info" title="Más info" aria-label="Ver más información de este perfil">i</button>' +
    '<button type="button" class="btn round super" data-act="deck-super"' + (superlikeDisponible() ? '' : ' disabled') + ' title="Super-like (1 por día)" aria-label="Super-like (1 por día)">⭐</button>' +
    '<button type="button" class="btn round like" data-act="deck-si" title="Me gusta" aria-label="Me gusta">♥</button>' +
    '</div></div>';
}

// Escritorio (≥1024px): cuadrícula de tarjetas; móvil: una tarjeta
// (vista swipe de siempre). Se decide en cada render, sin recargar.
function esDesktop() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia('(min-width: 1024px)').matches;
}

function renderDeckBody() {
  if (esDesktop()) renderGrid();
  else renderCard();
}

function gridCardHTML(c) {
  const p = c.other.profile;
  const chips = [...(p.valores || []), ...(p.intereses || [])].slice(0, 6)
    .map((v) => '<span class="chip mini">' + esc(v) + '</span>').join('');
  const pk = esc(c.other.pubkey);
  return '<div class="tarjeta grid-card">' +
    '<div class="t-foto">' + avatarImg(c.other.pubkey, p, 'avatar big') +
    '<div class="' + compatCls(c) + '">' + compatTxt(c) + '</div></div>' +
    '<div class="t-body">' +
    '<h3>' + nombreEdad(p) + '</h3>' +
    '<p class="muted">📍 ' + lugar(p) + '</p>' +
    (p.bio ? '<p class="bio">' + esc(p.bio) + '</p>' : '') +
    (p.tresPalabras ? '<p class="trespal">“' + esc(p.tresPalabras) + '”</p>' : '') +
    (chips ? '<div class="chips static">' + chips + '</div>' : '') +
    '</div>' +
    '<div class="t-actions">' +
    '<button type="button" class="btn round sm dislike" data-act="grid-no" data-peer="' + pk + '" title="No me interesa" aria-label="No me interesa">✕</button>' +
    '<button type="button" class="btn round sm info" data-act="grid-info" data-peer="' + pk + '" title="Más info" aria-label="Ver más información de este perfil">i</button>' +
    '<button type="button" class="btn round sm super" data-act="grid-super" data-peer="' + pk + '"' + (superlikeDisponible() ? '' : ' disabled') + ' title="Super-like (1 por día)" aria-label="Super-like (1 por día)">⭐</button>' +
    '<button type="button" class="btn round sm like" data-act="grid-si" data-peer="' + pk + '" title="Me gusta" aria-label="Me gusta">♥</button>' +
    '</div></div>';
}

// Aviso discreto cuando el pool vino relajado (pocos candidatos:
// se exploró más allá de las preferencias).
function relaxNoteHTML() {
  return S.candidatos.some((c) => c.relajado)
    ? '<p class="relax-note">🔭 Explorando más allá de tus preferencias</p>' : '';
}

function renderGrid() {
  const body = $('#deck-body');
  if (!body) return;
  const sub = $('#deck-sub');
  if (!S.candidatos.length) {
    if (sub) sub.textContent = 'Eso es todo por ahora.';
    body.innerHTML = '<div class="center-pad"><p class="big">👋</p>' +
      '<p>Ya viste todos los perfiles disponibles.<br>Vuelve más tarde o re-descubre la red.</p>' +
      '<button type="button" class="btn primary" data-act="deck-recargar">Re-descubrir</button></div>';
    return;
  }
  if (sub) sub.textContent = S.candidatos.length + (S.candidatos.length === 1 ? ' perfil para ti' : ' perfiles para ti');
  body.innerHTML = relaxNoteHTML() + '<div class="deck-grid">' + S.candidatos.slice(0, 12).map(gridCardHTML).join('') + '</div>';
}

// Like/dislike/super-like desde la cuadrícula: mismo envío a la red
// que el deck de una tarjeta; la tarjeta sale de la lista al actuar.
async function gridAction(peerPubkey, tipo) {
  const c = S.candidatos.find((x) => x.other.pubkey === peerPubkey);
  if (!c) return;
  if (tipo === 'super' && !superlikeDisponible()) {
    toast('Ya usaste tu super-like de hoy ⭐');
    return;
  }
  try {
    if (tipo === 'no') {
      await sendDislike(S.pool, peerPubkey);
      S.data.likes.sent[peerPubkey] = { tipo: '-', superlike: false, ts: Math.floor(Date.now() / 1000) };
    } else {
      await sendLike(S.pool, peerPubkey, { superlike: tipo === 'super' });
      if (tipo === 'super') marcarSuperlike();
      S.data.likes.sent[peerPubkey] = { tipo: '+', superlike: tipo === 'super', ts: Math.floor(Date.now() / 1000) };
    }
    marcarVisto(peerPubkey);
    S.candidatos = S.candidatos.filter((x) => x.other.pubkey !== peerPubkey);
    const mutuo = tipo !== 'no' && S.data.likes.received[peerPubkey] &&
      S.data.likes.received[peerPubkey].tipo === '+';
    if (mutuo) { renderGrid(); showMatchOverlay(peerPubkey); }
    else renderGrid();
  } catch {
    toast('Sin conexión a los relays. Intenta de nuevo.');
  }
}

function renderCard() {
  const body = $('#deck-body');
  if (!body) return;
  const c = curCand();
  const sub = $('#deck-sub');
  if (!c) {
    if (sub) sub.textContent = 'Eso es todo por ahora.';
    body.innerHTML = '<div class="center-pad"><p class="big">👋</p>' +
      '<p>Ya viste todos los perfiles disponibles.<br>Vuelve más tarde o re-descubre la red.</p>' +
      '<button type="button" class="btn primary" data-act="deck-recargar">Re-descubrir</button></div>';
    return;
  }
  if (sub) sub.textContent = 'Perfil ' + (S.idx + 1) + ' de ' + S.candidatos.length;
  body.innerHTML = relaxNoteHTML() + cardHTML(c);
}

function nextCard() {
  if (esDesktop()) { renderGrid(); return; }
  S.idx++;
  renderCard();
}

function setCardBusy(busy) {
  $$('#deck-body .t-actions .btn').forEach((b) => { b.disabled = busy; });
}

async function doLike(superlike) {
  const c = curCand();
  if (!c) return;
  if (superlike && !superlikeDisponible()) {
    toast('Ya usaste tu super-like de hoy ⭐');
    return;
  }
  setCardBusy(true);
  try {
    await sendLike(S.pool, c.other.pubkey, { superlike: !!superlike });
    if (superlike) marcarSuperlike();
    S.data.likes.sent[c.other.pubkey] = { tipo: '+', superlike: !!superlike, ts: Math.floor(Date.now() / 1000) };
    marcarVisto(c.other.pubkey);
    const mutuo = S.data.likes.received[c.other.pubkey] && S.data.likes.received[c.other.pubkey].tipo === '+';
    if (mutuo) showMatchOverlay(c.other.pubkey);
    else nextCard();
  } catch {
    toast('Sin conexión a los relays. Intenta de nuevo.');
    setCardBusy(false);
  }
}

async function doDislike() {
  const c = curCand();
  if (!c) return;
  setCardBusy(true);
  try {
    await sendDislike(S.pool, c.other.pubkey);
    S.data.likes.sent[c.other.pubkey] = { tipo: '-', superlike: false, ts: Math.floor(Date.now() / 1000) };
    marcarVisto(c.other.pubkey);
    nextCard();
  } catch {
    toast('Sin conexión a los relays. Intenta de nuevo.');
    setCardBusy(false);
  }
}

function showMatchOverlay(peerPubkey) {
  const prof = S.perfilCache.get(peerPubkey)?.profile;
  const nombre = prof ? prof.apodo : 'alguien';
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.id = 'match-overlay';
  ov.innerHTML = '<div class="sheet match">' +
    '<div class="big">💘</div><h2>¡Match!</h2>' +
    '<p>A ti y a <b>' + esc(nombre) + '</b> les gustó su perfil.<br>¡Escríbele!</p>' +
    '<div class="match-avatars">' + avatarImg(S.pubkey, S.miPerfil, 'avatar') +
    (prof ? avatarImg(peerPubkey, prof, 'avatar') : '') + '</div>' +
    '<button type="button" class="btn primary big" data-act="match-chatear" data-peer="' + esc(peerPubkey) + '">Chatear ahora</button>' +
    '<button type="button" class="btn ghost" data-act="match-seguir">Seguir descubriendo</button>' +
    '</div>';
  document.getElementById("app").appendChild(ov);
}

// ---------- detalle expandido + reportar/bloquear ----------
// Cuerpo con TODAS las características de un perfil (foto, edad,
// ubicación, bio, datos, personalidad, valores/intereses/tags). Lo
// comparten el overlay de Descubrir (showDetalle) y la pantalla de
// perfil del match dentro del chat (showChatPerfil).
function detalleCuerpoHTML(peerPubkey) {
  const entry = S.perfilCache.get(peerPubkey);
  if (!entry) return '';
  const p = entry.profile;
  const rasgos = RASGOS.map((r) => {
    const v = +(p.rasgos?.[r.id] ?? 3);
    return '<div class="rasgo"><span>' + esc(r.label) + '</span><div class="rbar"><div style="width:' + (v * 20) + '%"></div></div><b>' + v + '/5</b></div>';
  }).join('');
  const prompts = (p.prompts || []).filter((x) => x && x.q).map((x) =>
    '<div class="prompt"><b>' + esc(x.q) + '</b><span>' + esc(x.a || '—') + '</span></div>').join('');
  const chips = (t, arr) => (arr && arr.length)
    ? '<p class="fld-label">' + t + '</p><div class="chips static">' + arr.map((v) => '<span class="chip mini">' + esc(v) + '</span>').join('') + '</div>' : '';
  const dato = (l, v) => v ? '<div class="dato"><span>' + l + '</span><b>' + esc(v) + '</b></div>' : '';
  return avatarImg(peerPubkey, p, 'avatar big') +
    '<h3>' + nombreEdad(p) + '</h3><p class="muted">📍 ' + lugar(p) + '</p>' +
    (p.bio ? '<p class="bio">' + esc(p.bio) + '</p>' : '') +
    prompts +
    '<div class="datos">' +
    dato('Estatura', p.estatura ? p.estatura + ' cm' : '') + dato('Complexión', p.complexion) +
    dato('Ojos', p.ojos) + dato('Piel', p.piel) + dato('Cabello', p.cabello) +
    dato('Educación', p.educacion) + dato('Profesión', p.profesion) + dato('Sector', p.sector) +
    dato('Fuma', p.fumador) + dato('Bebe', p.bebedor) + dato('Deporte', p.deporte) +
    dato('Hijos', p.hijosTiene) + dato('Quiere hijos', p.hijosQuiere) + dato('Mascotas', p.mascotas) +
    '</div>' +
    '<p class="fld-label">Personalidad</p>' + rasgos +
    chips('Valores', p.valores) + chips('Intereses', p.intereses) + chips('Tags', p.tags) +
    (p.tresPalabras ? '<p class="trespal">“' + esc(p.tresPalabras) + '”</p>' : '');
}

function showDetalle(peerPubkey) {
  const entry = S.perfilCache.get(peerPubkey);
  if (!entry) return;
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.id = 'detalle-overlay';
  ov.innerHTML = '<div class="sheet detalle" role="dialog" aria-label="Detalle del perfil">' +
    '<button type="button" class="x" data-act="detalle-cerrar" aria-label="Cerrar detalle">✕</button>' +
    detalleCuerpoHTML(peerPubkey) +
    '<div class="row-btns">' +
    '<button type="button" class="btn warn" data-act="perfil-reportar" data-peer="' + esc(peerPubkey) + '">Reportar</button>' +
    '<button type="button" class="btn danger" data-act="perfil-bloquear" data-peer="' + esc(peerPubkey) + '">Bloquear</button>' +
    '</div></div>';
  ov.addEventListener('click', (e) => { if (e.target === ov) closeDetalle(); });
  document.getElementById("app").appendChild(ov);
}
function closeDetalle() {
  const ov = $('#detalle-overlay');
  if (ov) ov.remove();
}

// Pantalla de perfil del match (v1.8.0): se abre al tocar el
// avatar/apodo en la cabecera del chat. Muestra TODAS las
// características del otro (el mismo cuerpo que el detalle de
// Descubrir) y abajo viven Bloquear y Reportar — salieron de la
// cabecera, que desbordaba en pantallas estrechas. Volver regresa
// al chat (las suscripciones del chat no se tocan al navegar aquí).
function showChatPerfil(peerPubkey) {
  const entry = S.perfilCache.get(peerPubkey);
  if (!entry) { showChat(peerPubkey); return; }
  S.screen = 'chatperfil';
  $('#app').innerHTML = pantallaShell('matches',
    '<div class="chatperfil">' +
    '<div class="chat-head">' +
    '<button type="button" class="btn ghost sm" data-act="chatperfil-volver" data-peer="' + esc(peerPubkey) + '" aria-label="Volver al chat">←</button>' +
    '<span class="chat-peer-txt"><b class="chat-nombre">' + esc(entry.profile.apodo || 'Perfil') + '</b>' +
    '<small class="chat-presencia" id="chatperfil-presencia"></small></span>' +
    '</div>' +
    '<div class="detalle-page">' + detalleCuerpoHTML(peerPubkey) + '</div>' +
    '<div class="row-btns chatperfil-acts">' +
    '<button type="button" class="btn warn" data-act="perfil-reportar" data-peer="' + esc(peerPubkey) + '">Reportar</button>' +
    '<button type="button" class="btn danger" data-act="perfil-bloquear" data-peer="' + esc(peerPubkey) + '">Bloquear</button>' +
    '</div></div>');
  pintarPresencia();
  startPresenciaUi();
}

async function reportarPerfil(peerPubkey) {
  const motivo = prompt('¿Por qué reportas este perfil?');
  if (motivo === null) return;
  const m = motivo.trim();
  if (!m) { toast('Escribe un motivo para el reporte.'); return; }
  try {
    await sendReporte(S.pool, peerPubkey, m);
    toast('Reporte enviado. Gracias por cuidar la comunidad.');
  } catch {
    toast('Sin conexión a los relays. Intenta de nuevo.');
  }
}

function bloquearPerfil(peerPubkey) {
  const prof = S.perfilCache.get(peerPubkey)?.profile;
  const nombre = prof ? prof.apodo : 'este perfil';
  if (!confirm('¿Bloquear a ' + nombre + '? No verás más su perfil.')) return;
  if (!S.bloqueados.includes(peerPubkey)) {
    S.bloqueados.push(peerPubkey);
    LS.set('bloqueados', S.bloqueados);
  }
  marcarVisto(peerPubkey);
  closeDetalle();
  toast('Perfil bloqueado.');
  if (S.screen === 'deck') {
    const eraActual = curCand() && curCand().other.pubkey === peerPubkey;
    S.candidatos = S.candidatos.filter((x) => x.other.pubkey !== peerPubkey);
    if (esDesktop()) renderGrid();
    else if (eraActual) { if (S.idx >= S.candidatos.length) S.idx = Math.max(0, S.candidatos.length - 1); renderCard(); }
  }
  else if (S.screen === 'chat' || S.screen === 'chatperfil') showMatches();
}

// ---------- 5. top 10 ----------
async function showTop10() {
  setScreenScope('discovery');
  stopChat();
  S.screen = 'top10';
  $('#app').innerHTML = pantallaShell('top10',
    '<div class="deck-head"><h2>Top 10 del día</h2><p class="muted">Tu mejor compatibilidad hoy</p></div>' +
    '<div id="top-body">' + cargandoHTML('Calculando compatibilidad…') + '</div>');
  try {
    const d = await ensureData();
    S.top = topDaily(d.me, d.others, d.ctx, 10);
    renderTop();
  } catch {
    $('#top-body').innerHTML = '<div class="center-pad"><p>😕 Sin conexión a los relays.</p>' +
      '<button type="button" class="btn primary" data-act="nav-top10">Reintentar</button></div>';
  }
}

function renderTop() {
  const body = $('#top-body');
  if (!body) return;
  if (!S.top.length) {
    body.innerHTML = '<div class="center-pad"><p>No hay candidatos hoy.<br>Completa más tu perfil para mejores resultados.</p></div>';
    return;
  }
  body.innerHTML = '<div class="rows">' + S.top.map((t, i) => {
    const p = t.other.profile;
    return '<div class="row" data-peer="' + esc(t.other.pubkey) + '">' +
      '<span class="rank">' + (i + 1) + '</span>' +
      avatarImg(t.other.pubkey, p, 'avatar sm') +
      '<div class="r-main"><b>' + esc(p.apodo || '¿?') + '</b>' +
      '<small class="muted">' + lugar(p) + ' · <b class="pct">' + compatTxt(t) + '</b></small></div>' +
      '<button type="button" class="btn round sm dislike" data-act="top-no" title="No me interesa" aria-label="No me interesa">✕</button>' +
      '<button type="button" class="btn round sm like" data-act="top-si" title="Me gusta" aria-label="Me gusta">♥</button>' +
      '</div>';
  }).join('') + '</div>';
}

async function topAction(peerPubkey, like) {
  const row = document.querySelector('.row[data-peer="' + CSS.escape(peerPubkey) + '"]');
  try {
    if (like) {
      await sendLike(S.pool, peerPubkey, {});
      S.data.likes.sent[peerPubkey] = { tipo: '+', superlike: false, ts: Math.floor(Date.now() / 1000) };
      if (S.data.likes.received[peerPubkey]?.tipo === '+') {
        toast('💘 ¡Match! Ve a Matches para chatear.');
      }
    } else {
      await sendDislike(S.pool, peerPubkey);
      S.data.likes.sent[peerPubkey] = { tipo: '-', superlike: false, ts: Math.floor(Date.now() / 1000) };
    }
    marcarVisto(peerPubkey);
    S.top = S.top.filter((t) => t.other.pubkey !== peerPubkey);
    if (row) row.remove();
    if (!S.top.length) renderTop();
  } catch {
    toast('Sin conexión a los relays. Intenta de nuevo.');
  }
}

// ---------- 6. matches ----------
async function showMatches() {
  setScreenScope('discovery');
  stopChat();
  S.screen = 'matches';
  $('#app').innerHTML = pantallaShell('matches',
    '<div class="deck-head"><div><h2>Matches</h2><p class="muted">Les gustas y te gustan 💘</p></div>' +
    '<button type="button" class="btn ghost sm" data-act="matches-actualizar">Actualizar</button></div>' +
    '<div id="matches-body">' + cargandoHTML('Buscando matches…') + '</div>');
  await loadMatches();
}

async function loadMatches() {
  const body = $('#matches-body');
  try {
    const d = await ensureData();
    refreshPresenciaSub(); // ya hay matches conocidos: oírlos
    const mutuos = mutualMatches(d.likes.sent, d.likes.received)
      .filter((pk) => !S.bloqueados.includes(pk) && S.perfilCache.has(pk));
    if (!body) return;
    if (!mutuos.length) {
      body.innerHTML = '<div class="center-pad"><p class="big">💌</p>' +
        '<p>Aún no tienes matches.<br>Dale ♥ a perfiles en Descubrir y espera el flechazo mutuo.</p></div>';
      return;
    }
    body.innerHTML = '<div class="rows">' + mutuos.map((pk) => {
      const p = S.perfilCache.get(pk).profile;
      const unread = noLeidos(S.chats[pk] || LS.get('chats', {})[pk]);
      return '<div class="row">' +
        avatarImg(pk, p, 'avatar sm') +
        '<div class="r-main"><b>' + esc(p.apodo || '¿?') + '</b>' +
        '<small class="muted">' + lugar(p) + (unread ? ' · <b class="unread">' + unread + ' nuevo' + (unread > 1 ? 's' : '') + '</b>' : '') + '</small></div>' +
        '<button type="button" class="btn primary sm" data-act="match-chatear" data-peer="' + esc(pk) + '">Chatear</button>' +
        '</div>';
    }).join('') + '</div>';
  } catch {
    if (body) body.innerHTML = '<div class="center-pad"><p>😕 Sin conexión a los relays.</p></div>';
  }
}

// ---------- 7. chat ----------
function chatsLS() {
  return LS.get('chats', {});
}
function saveChats() {
  LS.set('chats', S.chats);
}

// Ids de eventos (DMs/receipts/beacons) cuya firma ya se verificó en
// esta sesión. Un mismo evento llega una vez por relay; se verifica
// una sola vez.
const sigOK = new Set();

// Verificación con caché (C1): la primera vez, firma completa. Si el
// id ya se verificó, se comprueba que el contenido sigue siendo el
// firmado (getEventHash === id): un id reutilizado con otro
// contenido NO hereda la verificación.
function firmaOK(ev, que) {
  if (!ev || typeof ev.id !== 'string') return false;
  if (sigOK.has(ev.id)) {
    let ok = false;
    try { ok = getEventHash(ev) === ev.id; } catch {}
    if (!ok) console.warn('[cubmatch] ' + que + ' con id reutilizado y contenido distinto, descartado:', ev.id);
    return ok;
  }
  if (!eventoValido(ev)) { console.warn('[cubmatch] ' + que + ' con firma inválida, descartado:', ev.id); return false; }
  sigOK.add(ev.id);
  return true;
}

async function dmToMsg(ev) {
  if (!ev || typeof ev.id !== 'string') return null;
  if (!firmaOK(ev, 'DM')) return null;
  const peer = ev.pubkey === S.pubkey
    ? (ev.tags.find((t) => t[0] === 'p') || [])[1]
    : ev.pubkey;
  if (!peer) return null;
  let text;
  try { text = await S.pool.messaging().decryptDM(ev); }
  catch { return null; }
  const msg = {
    peer,
    msg: {
      id: ev.id,
      from: ev.pubkey === S.pubkey ? 'me' : 'peer',
      ts: ev.created_at * 1000,
      text,
      // Semántica de read (C2):
      // - entrante: NO leído hasta que el usuario abre ese chat
      //   (showChat envía el receipt y lo marca).
      // - enviado: pendiente hasta que llegue su receipt (handleReceipt).
      read: false,
    },
  };
  // Si el evento es mío y volvió por la red, su publicación es un
  // hecho: estado 'enviado' (señal real, ver mensajes.js).
  if (msg.msg.from === 'me') msg.msg.estado = 'enviado';
  return msg;
}

function pushMsg(peer, msg) {
  // Fusión central (mensajes.js): dedup por id, el eco de un mensaje
  // optimista adopta su id real sin duplicar y se conserva el estado
  // más avanzado (enviando < enviado; read es OR).
  S.chats[peer] = fusionarMensajes(S.chats[peer] || [], msg);
  saveChats();
}

function handleReceipt(peer, ev) {
  if (!ev || typeof ev.id !== 'string') return false;
  if (!firmaOK(ev, 'receipt')) return false;
  const e = (ev.tags.find((t) => t[0] === 'e') || [])[1];
  if (!e) return false;
  const msgs = S.chats[peer] || [];
  const m = msgs.find((x) => x.id === e && x.from === 'me' && !x.read);
  if (m) { m.read = true; saveChats(); return true; }
  return false;
}

// Cuántos mensajes del peer siguen sin leer en un chat.
// (Es lo que muestra el badge "N nuevos" en Matches.)
function noLeidos(chat) {
  return (chat || []).filter((m) => m.from === 'peer' && !m.read).length;
}

// Historial incremental: pide solo lo nuevo desde el último sync
// (cubmatch_lastSync_chat) y fusiona con S.chats (dedup por id en pushMsg).
async function syncChatHistory() {
  const t0 = Math.floor(Date.now() / 1000);
  const since = LS.get('lastSync_chat', 0);
  const f = (base) => (since > 0 ? { ...base, since } : base);
  const events = [];
  const sub = S.pool.messaging().subscribe([
    f({ kinds: [4], '#p': [S.pubkey], limit: 200 }),
    f({ kinds: [4], authors: [S.pubkey], limit: 200 }),
    f({ kinds: [24503], '#p': [S.pubkey], limit: 200 }),
  ], (ev) => events.push(ev));
  await sub.eose();
  sub.unsub();
  for (const ev of events) {
    if (ev.kind === 4) {
      const r = await dmToMsg(ev);
      if (r) pushMsg(r.peer, r.msg);
    }
  }
  for (const ev of events) {
    if (ev.kind === 24503) {
      const peer = ev.pubkey;
      if (S.chats[peer]) handleReceipt(peer, ev);
    }
  }
  // Solape de 60 s: lo que nació durante el fetch se re-trae la próxima
  // vez (el dedup por id lo absorbe).
  LS.set('lastSync_chat', Math.max(0, t0 - 60));
}

function showChat(peerPubkey) {
  setScreenScope('messaging');
  stopChat();
  const d = S.data;
  const mutuos = d ? mutualMatches(d.likes.sent, d.likes.received) : [];
  const prof = S.perfilCache.get(peerPubkey)?.profile;
  const nombre = prof ? prof.apodo : peerPubkey.slice(0, 8) + '…';
  if (!mutuos.includes(peerPubkey)) {
    S.screen = 'chat';
    $('#app').innerHTML = pantallaShell('matches',
      '<div class="center-pad"><p class="big">🔒</p>' +
      '<p>Solo puedes chatear tras un <b>match mutuo</b>.<br>Cuando a los dos les guste su perfil, el chat se abre solo.</p>' +
      '<button type="button" class="btn primary" data-act="nav-matches">Ver matches</button></div>');
    return;
  }
  S.screen = 'chat';
  S.chatPeer = peerPubkey;
  S.stickerEdit = false;
  S.chats = chatsLS();
  // 'enviando' de una sesión anterior = envío interrumpido: a 'error'
  // para que se pueda reintentar (el sync de abajo fusiona el eco si
  // en realidad sí se había publicado).
  for (const lista of Object.values(S.chats)) marcarColgados(lista, Date.now());
  saveChats();
  refreshPresenciaSub();
  $('#app').innerHTML = pantallaShell('matches',
    '<div class="chat-wrap">' +
    '<div class="chat-head">' +
    '<button type="button" class="btn ghost sm" data-act="nav-matches" aria-label="Volver a matches">←</button>' +
    '<button type="button" class="chat-peer" data-act="chat-ver-perfil" data-peer="' + esc(peerPubkey) + '" aria-label="Ver el perfil de ' + esc(nombre) + '">' +
    (prof ? avatarImg(peerPubkey, prof, 'avatar xs') : '') +
    '<span class="chat-peer-txt"><b class="chat-nombre">' + esc(nombre) + '</b>' +
    '<small class="chat-presencia" id="chat-presencia"></small></span>' +
    '</button>' +
    '<span class="chat-acts">' +
    '<button type="button" class="btn ghost sm" data-act="chat-call-voz" aria-label="Llamada de voz" title="Llamada de voz">📞</button>' +
    '<button type="button" class="btn ghost sm" id="chat-video-btn" data-act="chat-call-video" aria-label="Videollamada" title="Videollamada">🎥</button>' +
    '</span></div>' +
    '<div class="chat-msgs" id="chat-msgs"></div>' +
    '<div class="sticker-panel" id="sticker-panel" hidden></div>' +
    '<form class="chat-form" id="chat-form">' +
    '<button type="button" class="btn ghost chat-ico" data-act="chat-loc" aria-label="Compartir ubicación" title="Compartir ubicación">📍</button>' +
    '<button type="button" class="btn ghost chat-ico" data-act="chat-stickers" aria-label="Enviar un sticker" title="Stickers">😊</button>' +
    '<input id="chat-input" type="text" placeholder="Escribe un mensaje…" autocomplete="off" maxlength="1000">' +
    '<button type="submit" class="btn primary">Enviar</button>' +
    '</form></div>');
  renderMsgs();
  pintarPresencia();
  startPresenciaUi();
  (async () => {
    try { await syncChatHistory(); } catch {}
    if (S.chatPeer !== peerPubkey) return;
    renderMsgs();
    // receipts por mensajes no leídos del peer
    const msgs = S.chats[peerPubkey] || [];
    let changed = false;
    for (const m of msgs) {
      if (m.from === 'peer' && !m.read) {
        try { S.pool.messaging().sendReceipt(peerPubkey, m.id, Math.floor(m.ts / 1000)); } catch {}
        m.read = true;
        changed = true;
      }
    }
    if (changed) { saveChats(); renderMsgs(); }
    // en vivo
    const since = Math.floor(Date.now() / 1000);
    const subDM = S.pool.messaging().subscribe([
      { kinds: [4], '#p': [S.pubkey], since },
      { kinds: [4], authors: [S.pubkey], since },
    ], async (ev) => {
      if (S.chatPeer !== peerPubkey) return;
      const r = await dmToMsg(ev);
      if (r && r.peer === peerPubkey) {
        pushMsg(peerPubkey, r.msg);
        renderMsgs();
        if (r.msg.from === 'peer') {
          try { S.pool.messaging().sendReceipt(peerPubkey, r.msg.id, Math.floor(r.msg.ts / 1000)); } catch {}
          r.msg.read = true;
          saveChats();
          renderMsgs();
        }
      }
    });
    const subR = S.pool.messaging().subscribe(
      [{ kinds: [24503], '#p': [S.pubkey], since }],
      (ev) => {
        if (S.chatPeer !== peerPubkey) return;
        if (ev.pubkey === peerPubkey && handleReceipt(peerPubkey, ev)) renderMsgs();
      }
    );
    S.chatSubs = [subDM, subR];
  })();
}

function renderMsgs() {
  const box = $('#chat-msgs');
  if (!box || !S.chatPeer) return;
  const msgs = S.chats[S.chatPeer] || [];
  if (!msgs.length) {
    box.innerHTML = '<p class="muted center-pad">Aún no hay mensajes.<br>¡Rompe el hielo! 🧊</p>';
    return;
  }
  box.innerHTML = msgs.map((m) => {
    // Registro local de llamadas (v1.7.0): línea centrada, sin ticks.
    if (m.tipo === 'call') {
      return '<div class="msg call-log"><span>' + esc(m.text) +
        ' <small class="muted">' + horaCorta(m.ts) + '</small></span></div>';
    }
    // Estados de envío (v1.8.0, mensajes.js): cada tick tiene detrás
    // una señal real — 🕐 publicando, ✓ ≥1 relay aceptó, ✓✓ en color
    // = receipt de lectura (kind 24503). Sin señal no hay estado.
    const ev = estadoVisible(m);
    const tick = ev === 'visto' ? '<span class="tick read">✓✓</span>'
      : ev === 'enviado' ? '<span class="tick">✓</span>'
      : ev === 'enviando' ? '<span class="tick pending" title="Enviando">🕐</span>' : '';
    const meta = '<span class="mmeta">' + horaCorta(m.ts) + ' ' + tick + '</span>';
    const retry = ev === 'error'
      ? '<button type="button" class="msg-retry" data-act="chat-reintentar" data-mid="' + esc(m.id) + '">⚠ No enviado · Toca para reintentar</button>' : '';
    const wrap = (bubble) => '<div class="msg ' + m.from + (retry ? ' con-error' : '') + '">' + bubble + retry + '</div>';
    // DMs especiales (v1.6.0): payloads JSON de chatx (ubicación/sticker).
    // Si el parseo falla (JSON hostil o cliente viejo), cae a texto plano.
    const p = parseChatPayload(m.text);
    if (p && p.tipo === 'loc') {
      return wrap('<div class="bubble loc-b">' +
        '<div class="loc-card"><span class="loc-ico" aria-hidden="true">📍</span>' +
        '<span class="loc-txt"><b>Ubicación compartida</b><br>' +
        '<a href="' + esc(osmUrl(p.lat, p.lon)) + '" target="_blank" rel="noopener">Abrir en el mapa</a></span></div>' +
        meta + '</div>');
    }
    if (p && p.tipo === 'sticker') {
      return wrap('<div class="bubble sticker-b">' +
        '<img class="msg-sticker" src="' + esc(p.url) + '" alt="Sticker" loading="lazy">' +
        meta + '</div>');
    }
    return wrap('<div class="bubble">' + esc(m.text) + meta + '</div>');
  }).join('');
  box.scrollTop = box.scrollHeight;
  refreshVideoBtn();
}

// El botón 🎥 refleja los candados del video en vivo: al llegar a los
// 10 mensajes se "enciende" solo (si el otro acepta videollamadas).
function refreshVideoBtn() {
  const btn = document.getElementById('chat-video-btn');
  if (!btn || !S.chatPeer) return;
  const prof = S.perfilCache.get(S.chatPeer)?.profile;
  const chk = videoDisponible(S.miPerfil, prof, numMensajesChat(S.chatPeer));
  btn.classList.toggle('call-off', !chk.ok);
  btn.title = chk.ok ? 'Videollamada' : chk.texto;
}

// Envía un DM al peer del chat abierto (texto plano o payload especial
// JSON) con pintado OPTIMISTA: el mensaje aparece al instante en estado
// 'enviando' (🕐) con un id temporal; al confirmarse la publicación
// adopta el id real del evento y pasa a 'enviado' (✓); si la
// publicación falla queda visible en estado 'error' con reintento.
// La referencia al objeto insertado sigue válida tras la fusión del
// eco (fusionarMensajes muta in situ), así que las actualizaciones de
// estado siempre caen sobre el mensaje correcto. Lanza si los relays
// fallan: cada llamante pone su propio mensaje de error.
let tmpSeq = 0;
async function sendChatPayload(texto) {
  const peer = S.chatPeer;
  const msgOpt = {
    id: 'tmp:' + Date.now().toString(36) + '-' + (++tmpSeq) + '-' + Math.random().toString(36).slice(2, 8),
    from: 'me', ts: Date.now(), text: texto, read: false, estado: 'enviando',
  };
  pushMsg(peer, msgOpt);
  renderMsgs();
  try {
    const { event } = await sendDMRouted(S.pool, peer, texto);
    msgOpt.id = event.id;
    msgOpt.estado = 'enviado';
    saveChats();
    if (S.chatPeer === peer) renderMsgs();
    return event;
  } catch (e) {
    msgOpt.estado = 'error';
    saveChats();
    if (S.chatPeer === peer) renderMsgs();
    throw e;
  }
}

// Reintento de un mensaje en estado 'error': republica el mismo texto
// (evento nuevo; si el intento original en realidad sí había llegado
// a algún relay pese al error, el otro podría verlo dos veces — es el
// precio honesto de no tener acuse de los relays).
async function reintentarMsg(id) {
  const peer = S.chatPeer;
  if (!peer) return;
  const m = (S.chats[peer] || []).find((x) => x.id === id);
  if (!m || m.from !== 'me' || estadoVisible(m) !== 'error') return;
  m.estado = 'enviando';
  saveChats();
  renderMsgs();
  try {
    const { event } = await sendDMRouted(S.pool, peer, m.text);
    m.id = event.id;
    m.estado = 'enviado';
  } catch {
    m.estado = 'error';
  }
  saveChats();
  if (S.chatPeer === peer) renderMsgs();
}

async function submitChat() {
  const input = $('#chat-input');
  const peer = S.chatPeer;
  if (!input || !peer) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  try {
    await sendChatPayload(text);
  } catch {
    // El mensaje ya quedó pintado con "No enviado · reintentar":
    // NO se devuelve el texto al input (se duplicaría al reintentar).
    toast('No se pudo enviar. Quedó en el chat para reintentar.');
  }
}

// ---------- ubicación en el chat ----------
// Compartir la ubicación es delicado (revela dónde vives): siempre
// pasa por una confirmación dentro de la app y se pide UNA sola vez
// con getCurrentPosition — nunca hay seguimiento en vivo.
function chatPeerNombre() {
  const prof = S.chatPeer ? S.perfilCache.get(S.chatPeer)?.profile : null;
  return prof ? (prof.apodo || 'esta persona') : 'esta persona';
}

function showLocConfirm() {
  if (!S.chatPeer) return;
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    toast('Tu navegador no tiene geolocalización.');
    return;
  }
  closeLocConfirm();
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.id = 'loc-overlay';
  ov.innerHTML = '<div class="sheet loc" role="dialog" aria-label="Compartir ubicación">' +
    '<button type="button" class="x" data-act="chat-loc-no" aria-label="Cancelar">✕</button>' +
    '<h3>📍 Compartir ubicación</h3>' +
    '<p>¿Compartir tu ubicación <b>exacta</b> con <b>' + esc(chatPeerNombre()) + '</b>?</p>' +
    '<p class="muted">Se enviará tu <b>ubicación actual</b>, una sola vez: no es seguimiento en vivo. ' +
    'Piénsalo bien: compartirla puede revelar dónde vives.</p>' +
    '<div class="share-btns">' +
    '<button type="button" class="btn primary big" data-act="chat-loc-si">Compartir mi ubicación</button>' +
    '<button type="button" class="btn ghost big" data-act="chat-loc-no">Cancelar</button>' +
    '</div></div>';
  ov.addEventListener('click', (e) => { if (e.target === ov) closeLocConfirm(); });
  document.getElementById('app').appendChild(ov);
}

function closeLocConfirm() {
  const ov = $('#loc-overlay');
  if (ov) ov.remove();
}

function enviarUbicacion() {
  closeLocConfirm();
  if (!S.chatPeer) return;
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    toast('Tu navegador no tiene geolocalización.');
    return;
  }
  toast('Obteniendo tu ubicación…');
  try {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await sendChatPayload(buildLocPayload(pos.coords.latitude, pos.coords.longitude));
        } catch {
          toast('No se pudo enviar la ubicación. Sin conexión a los relays.');
        }
      },
      (err) => toast(geoErrorTexto(err)),
      { timeout: 15000, maximumAge: 60000 }
    );
  } catch {
    toast('No se pudo obtener tu ubicación.');
  }
}

// ---------- stickers personales en el chat ----------
// Biblioteca local por cuenta (chatx + LS). Añadir = subir la imagen a
// Blossom SIN recomprimir a JPEG (se conserva el alfa); enviar = DM
// con payload {"t":"sticker",...}.
function toggleStickerPanel() {
  const panel = $('#sticker-panel');
  if (!panel) return;
  if (panel.hidden) { renderStickerPanel(); panel.hidden = false; }
  else panel.hidden = true;
}

function renderStickerPanel() {
  const panel = $('#sticker-panel');
  if (!panel || !S.pubkey) return;
  const lista = loadStickers(LS, S.pubkey);
  panel.innerHTML =
    '<div class="stk-head"><b>😊 Mis stickers</b>' +
    (lista.length
      ? '<button type="button" class="btn ghost sm" data-act="sticker-editar">' + (S.stickerEdit ? 'Listo' : 'Editar') + '</button>'
      : '') +
    '</div>' +
    '<p class="muted small">¿Tus favoritos de WhatsApp? Guárdalos como imagen y súbelos aquí.</p>' +
    '<div class="stk-grid">' +
    lista.map((url) =>
      '<span class="stk-cell">' +
      '<button type="button" class="stk" data-act="sticker-send" data-url="' + esc(url) + '" aria-label="Enviar sticker">' +
      '<img src="' + esc(url) + '" alt="" loading="lazy"></button>' +
      (S.stickerEdit
        ? '<button type="button" class="stk-x" data-act="sticker-del" data-url="' + esc(url) + '" aria-label="Quitar sticker">✕</button>'
        : '') +
      '</span>').join('') +
    '<label class="stk-add" for="sticker-file"><span class="stk-add-ico" aria-hidden="true">➕</span><small>Añadir desde la galería</small></label>' +
    '<input type="file" id="sticker-file" accept="image/*" hidden>' +
    '</div>' +
    (lista.length ? '' : '<p class="muted small">Todavía no tienes stickers: añade el primero.</p>') +
    '<p class="stk-estado" id="sticker-estado" role="status"></p>';
}

async function enviarSticker(url) {
  const panel = $('#sticker-panel');
  if (panel) panel.hidden = true;
  try {
    await sendChatPayload(buildStickerPayload(url));
  } catch {
    toast('No se pudo enviar el sticker. Sin conexión a los relays.');
  }
}

// El input #sticker-file vive dentro del panel: su change burbujea a
// este listener propio (como el de la foto, onFotoChange).
async function onStickerChange(e) {
  const input = e.target;
  if (!input || input.id !== 'sticker-file') return;
  if (!S.sk || !S.pubkey) return;
  const file = input.files && input.files[0];
  if (!file) return;
  const estado = $('#sticker-estado');
  if (estado) estado.textContent = 'Subiendo sticker…';
  try {
    const blob = await prepareStickerBlob(file);
    if (!stickerPesoOk(blob.size)) {
      if (estado) estado.textContent = 'Ese sticker pesa más de 1 MB; prueba con uno más ligero.';
      return;
    }
    const url = await uploadPhoto(blob, S.sk);
    addSticker(LS, S.pubkey, url);
    renderStickerPanel();
    const est2 = $('#sticker-estado');
    if (est2) est2.textContent = '¡Sticker añadido! ✅';
  } catch {
    if (estado) estado.textContent = 'No se pudo subir el sticker; revisa tu conexión.';
  } finally {
    input.value = ''; // permite volver a elegir el mismo archivo
  }
}

// ---------- presencia en el chat (v1.8.0) ----------
// Beacon efímero kind 21005 cada ~45 s mientras hay sesión (la
// lógica pura — TTL, textos, validación — vive en presencia.js).
// "En línea" = beacon hace <2 min: app abierta recientemente y
// nada más que eso. La última vez vista se persiste en localStorage
// (es lo que ESTE teléfono vio, no una verdad de red).
let presenciaSub = null;
let presenciaBeaconTimer = null;
let presenciaAutores = ''; // firma del set de autores suscrito

function publicarBeacon(contenido) {
  if (!S.pool || !S.sk) return Promise.resolve();
  return S.pool.messaging()
    .publish({ kind: KIND_PRESENCIA, tags: [], content: contenido || '' })
    .catch(() => {});
}

function startPresencia() {
  if (!S.pool || !S.sk) return;
  S.presencia = LS.get('presencia', {}) || {};
  void publicarBeacon('');
  if (presenciaBeaconTimer) clearInterval(presenciaBeaconTimer);
  presenciaBeaconTimer = setInterval(() => { void publicarBeacon(''); }, BEACON_CADA_MS);
  presenciaBeaconTimer.unref?.(); // no retener el proceso (tests/Node)
  S.timers.push(presenciaBeaconTimer);
  refreshPresenciaSub();
}

function stopPresencia() {
  if (presenciaBeaconTimer) { clearInterval(presenciaBeaconTimer); presenciaBeaconTimer = null; }
  if (presenciaSub) { try { presenciaSub.unsub(); } catch {} presenciaSub = null; }
  presenciaAutores = '';
}

function matchesPubkeys() {
  const d = S.data;
  if (!d || !d.likes) return [];
  return mutualMatches(d.likes.sent, d.likes.received)
    .filter((pk) => !S.bloqueados.includes(pk));
}

// (Re)suscribe a los beacons de mis matches solo si cambió el set.
function refreshPresenciaSub() {
  if (!S.pool || !S.sk) return;
  const autores = matchesPubkeys().sort();
  const firma = autores.join(',');
  if (firma === presenciaAutores) return;
  presenciaAutores = firma;
  if (presenciaSub) { try { presenciaSub.unsub(); } catch {} presenciaSub = null; }
  if (!autores.length) return;
  presenciaSub = S.pool.messaging().subscribe(
    [{ kinds: [KIND_PRESENCIA], authors: autores }],
    (ev) => { void handleBeaconEvent(ev); }
  );
}

async function handleBeaconEvent(ev) {
  if (!ev || typeof ev.id !== 'string') return;
  if (!firmaOK(ev, 'beacon')) return;
  const b = parseBeacon(ev, Date.now());
  if (!b || b.pubkey === S.pubkey) return;
  S.presencia[b.pubkey] = { ts: b.ts, off: b.off };
  guardarPresencia();
  pintarPresencia();
}

function guardarPresencia() {
  const keys = Object.keys(S.presencia);
  if (keys.length > 300) { // poda: los 300 vistos más recientemente
    keys.sort((a, b2) => (S.presencia[b2].ts || 0) - (S.presencia[a].ts || 0));
    for (const k of keys.slice(300)) delete S.presencia[k];
  }
  LS.set('presencia', S.presencia);
}

// Pinta el estado del peer del chat abierto (cabecera y pantalla de
// perfil comparten el mismo peer: S.chatPeer no cambia al navegar).
function pintarPresencia() {
  const peer = S.chatPeer;
  if (!peer) return;
  const info = textoPresencia(S.presencia[peer], Date.now());
  for (const id of ['chat-presencia', 'chatperfil-presencia']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = info.texto;
    el.classList.toggle('on', info.enLinea);
  }
}

// Refresco periódico de la línea de presencia (el TTL puede vencer
// sin que llegue ningún beacon nuevo).
let presenciaUiTimer = null;
function startPresenciaUi() {
  stopPresenciaUi();
  presenciaUiTimer = setInterval(pintarPresencia, 30000);
  presenciaUiTimer.unref?.();
  S.timers.push(presenciaUiTimer);
}
function stopPresenciaUi() {
  if (presenciaUiTimer) { clearInterval(presenciaUiTimer); presenciaUiTimer = null; }
}

// ---------- 7c. listener global de DMs y likes (hallazgo M3) ----------
// Antes: los DMs solo se escuchaban dentro del chat abierto y los likes
// solo aparecían al re-descubrir. La sesión mantiene ahora una
// suscripción en vivo por scope (DMs en messaging, likes en discovery;
// discovery se adquiere por sesión igual que la señalización de
// llamadas adquiere messaging):
// - DM entrante → se fusiona en S.chats (dedup por id); si su chat no
//   está abierto, avisa con toast y el badge "N nuevos" se actualiza.
//   El receipt sigue enviándose solo al abrir el chat (semántica C2).
// - Like entrante (firma verificada, C1) → se integra en S.data.likes;
//   si crea un match mutuo nuevo, avisa y refresca la pantalla visible.
let globalLiveSubs = [];
let globalLiveScopes = [];
let globalLivePool = null; // el pool sobre el que se adquirieron los scopes

function startGlobalLive() {
  if (!S.pool || !S.sk) return;
  stopGlobalLive(); // re-entrada (re-login): suelta la sesión anterior
  globalLivePool = S.pool;
  for (const scope of ['messaging', 'discovery']) {
    S.pool.acquire(scope);
    globalLiveScopes.push(scope);
  }
  const since = Math.floor(Date.now() / 1000);
  globalLiveSubs.push(S.pool.messaging().subscribe(
    [{ kinds: [KIND_DM], '#p': [S.pubkey], since }],
    (ev) => { void onGlobalDM(ev); }
  ));
  globalLiveSubs.push(S.pool.discovery().subscribe(
    [{ kinds: [KIND_LIKE], '#a': [profileAddr(S.pubkey)], since }],
    (ev) => { void onGlobalLike(ev); }
  ));
}

function stopGlobalLive() {
  for (const sub of globalLiveSubs) { try { sub.unsub(); } catch {} }
  globalLiveSubs = [];
  // Los scopes se liberan sobre el pool que los adquirió (puede no ser
  // el actual tras un restablecimiento de relays).
  const pool = globalLivePool;
  globalLivePool = null;
  for (const scope of globalLiveScopes) { try { if (pool) pool.release(scope); } catch {} }
  globalLiveScopes = [];
}

function nombreCorto(peerPubkey) {
  const entry = S.perfilCache.get(peerPubkey);
  const apodo = entry && entry.profile && entry.profile.apodo;
  return apodo || (peerPubkey.slice(0, 8) + '…');
}

async function onGlobalDM(ev) {
  const r = await dmToMsg(ev); // firma (C1) + descifrado; null si no vale
  if (!r) return;
  pushMsg(r.peer, r.msg); // dedup por id: si el chat está abierto, él lo pinta
  if (r.msg.from !== 'peer') return;
  if (S.screen === 'chat' && S.chatPeer === r.peer) return; // el chat ya lo muestra
  toast('💬 Nuevo mensaje de ' + nombreCorto(r.peer));
  if (S.screen === 'matches') { try { await loadMatches(); } catch {} }
}

function onGlobalLike(ev) {
  if (!ev || typeof ev.id !== 'string') return;
  if (!firmaOK(ev, 'like')) return; // C1: sin firma válida no existe
  const like = parseLikeEvent(ev, S.pubkey);
  if (!like || like.from === S.pubkey) return; // solo recibidos
  if (S.bloqueados.includes(like.peer)) return;
  const likes = (S.data && S.data.likes) || LS.get(LS_LIKES, { sent: {}, received: {} });
  const res = integrarLikeEntrante(likes, like);
  if (!res.changed) return;
  LS.set(LS_LIKES, likes);
  if (res.nuevoMatch) {
    toast('💘 ¡Nuevo match con ' + nombreCorto(like.peer) + '!');
    refreshPresenciaSub(); // el nuevo match entra a los beacons
  }
  if (S.screen === 'matches') { loadMatches().catch(() => {}); }
  else if (S.screen === 'deck' && S.data) {
    S.leGustas = likesYou(S.data.me, S.data.others, S.data.ctx);
    renderLeGustas();
  }
}

// ---------- 7b. llamadas de voz y video (v1.7.0) ----------
// WebRTC entre matches con señalización Nostr efímera (kind 21004,
// cifrada NIP-04). La suscripción vive lo que dura la sesión (no una
// pantalla): mantiene adquirido el scope de mensajería. La máquina de
// estados y los candados de video están en llamadas.js (puros); aquí
// viven el transporte real, el RTC real y la UI (overlays).
let callSession = null;
let callSub = null;
let callScopeHeld = false;
let callUiTimer = null;
const sigCallOK = new Set(); // ids de señalización ya verificados (C1)

// Dependencias reales de la sesión de llamada. Los tests las pueden
// sustituir vía _test.setCallDeps (RTC/transporte falsos).
const callDeps = {
  send: (peer, payload) => sendCallSignal(peer, payload),
  // La sesión pide la config ICE vigente (proveedor de llamadas.js:
  // Metered fresco + base) y la pasa aquí ANTES de crear el pc.
  createPC: (iceServers) => {
    if (typeof RTCPeerConnection === 'undefined') return null;
    try {
      return new RTCPeerConnection({
        iceServers: iceServers && iceServers.length ? iceServers : iceServersConfig(),
      });
    } catch { return null; }
  },
  getLocalStream: (media) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // Nombre propio: llamadas.js lo mapea a "abre la página en
      // Safari o Chrome" en vez del texto de permiso denegado.
      const e = new Error('getUserMedia no disponible');
      e.name = 'SinGetUserMedia';
      return Promise.reject(e);
    }
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: media === 'video' ? { facingMode: 'user' } : false,
    });
  },
};

async function sendCallSignal(peer, payload) {
  const content = await nip04.encrypt(S.sk, peer, JSON.stringify(payload));
  return S.pool.messaging().publish({ kind: KIND_CALL, tags: [['p', peer]], content });
}

function ensureCallSession() {
  if (callSession) return callSession;
  callSession = new CallSession({
    send: (peer, p) => callDeps.send(peer, p),
    createPC: (iceServers) => callDeps.createPC(iceServers),
    getLocalStream: (m) => callDeps.getLocalStream(m),
    onEvent: onCallEvent,
  });
  return callSession;
}

function startCalls() {
  stopCalls();
  if (!S.pool || !S.sk) return;
  S.pool.acquire('messaging'); // la señalización vive con la sesión
  callScopeHeld = true;
  ensureCallSession();
  const since = Math.floor(Date.now() / 1000);
  callSub = S.pool.messaging().subscribe(
    [{ kinds: [KIND_CALL], '#p': [S.pubkey], since }],
    (ev) => { void handleCallSignalEvent(ev); }
  );
}

function stopCalls() {
  if (callSub) { try { callSub.unsub(); } catch {} callSub = null; }
  if (callSession) { try { callSession.abortar(); } catch {} callSession = null; }
  closeCallOverlay();
  if (callScopeHeld && S.pool) { try { S.pool.release('messaging'); } catch {} }
  callScopeHeld = false;
}

function esMatch(peer) {
  const d = S.data;
  if (!d || !d.likes) return false;
  return mutualMatches(d.likes.sent, d.likes.received).includes(peer);
}

// Mensajes "de verdad" de un chat (los registros de llamada llevan
// tipo:'call' y no cuentan para la dinámica del video).
function numMensajesChat(peer) {
  return (S.chats[peer] || []).filter((m) => !m.tipo).length;
}

async function handleCallSignalEvent(ev) {
  if (!ev || typeof ev.id !== 'string') return;
  if (!sigCallOK.has(ev.id)) {
    if (!eventoValido(ev)) { console.warn('[cubmatch] señalización con firma inválida, descartada:', ev.id); return; }
    sigCallOK.add(ev.id);
  }
  const peer = ev.pubkey;
  // Mi propia señalización jamás es una llamada entrante para mí:
  // mis eventos solo me interesan como respuestas/ICE dirigidos a
  // mí, y vienen firmados por el OTRO. Lo mío se descarta aquí.
  if (!peer || peer === S.pubkey) return;
  if (S.bloqueados.includes(peer)) return;
  if (!esMatch(peer)) return; // solo llamadas de matches
  let payload;
  try { payload = parseCallPayload(await nip04.decrypt(S.sk, peer, ev.content)); }
  catch { return; }
  if (!payload) return;
  // Puerta de frescura: hay relays que ALMACENAN el kind 21004 (no
  // todos lo tratan como efímero) y lo reentregan al reconectar o
  // re-suscribir — una offer vieja NO es una llamada de ahora y se
  // ignora en silencio, sin sonar y sin rechazar nada. (La
  // suscripción ya pide since=ahora; esto caza lo que se cuele.)
  if (payload.op === 'offer' && !offerEsFresca(ev.created_at, Math.floor(Date.now() / 1000))) return;
  // Candado del lado receptor: una videollamada sin triple
  // consentimiento ni suena — rechazo silencioso con motivo.
  // (Una offer con restart:true NO es una llamada nueva: es la
  // renegociación de ICE de la llamada en curso, ya consentida —
  // pasa directa a la sesión, que la responde sin sonar.)
  if (payload.op === 'offer' && payload.media === 'video' && payload.restart !== true) {
    const motivo = rechazoEntranteVideo(S.miPerfil, numMensajesChat(peer));
    if (motivo) {
      try {
        await sendCallSignal(peer, buildCallPayload({ id: payload.id, op: 'reject', media: 'video', motivo }));
      } catch {}
      return;
    }
  }
  await ensureCallSession().recibir(peer, payload);
}

// Registro local de la llamada en su chat (solo en este teléfono).
function registrarLlamada(peer, texto) {
  if (!peer || !texto) return;
  pushMsg(peer, {
    id: 'call-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    from: 'me', ts: Date.now(), text: texto, read: true, tipo: 'call',
  });
  if (S.chatPeer === peer) renderMsgs();
}

function iniciarLlamada(media) {
  const peer = S.chatPeer;
  if (!peer) return;
  ensureCallSession().llamar(peer, media);
}

function callNombre(peer) {
  const prof = S.perfilCache.get(peer)?.profile;
  return prof ? (prof.apodo || 'Tu match') : 'Tu match';
}

// ---- overlays de llamada (viven en <body>: sobreviven a la
// navegación entre pantallas, a diferencia de los sheets de #app) ----
function closeCallOverlay() {
  if (callUiTimer) { clearInterval(callUiTimer); callUiTimer = null; }
  const ov = document.getElementById('call-overlay');
  if (ov) ov.remove();
}

// Reproducir un elemento de medios sin que un rechazo rompa
// nada: en Safari iOS `autoplay` no basta para que suene el audio
// remoto, y play() puede rechazar si el navegador aún lo retiene.
function callPlay(el) {
  if (!el || typeof el.play !== 'function') return;
  try {
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}

// Reintento de reproducción del remoto si quedó en pausa (gesto
// del usuario en el overlay = desbloqueo clásico de iOS).
function callPlayRemoto() {
  const rv = document.getElementById('call-remote');
  if (rv && rv.srcObject && rv.paused) callPlay(rv);
}

function callAttachStreams() {
  if (!callSession) return;
  const lv = document.getElementById('call-local');
  if (lv && callSession.localStream) {
    if (lv.srcObject !== callSession.localStream) {
      try { lv.srcObject = callSession.localStream; } catch {}
    }
    callPlay(lv);
  }
  const rv = document.getElementById('call-remote');
  if (rv && callSession.remoteStream) {
    if (rv.srcObject !== callSession.remoteStream) {
      try { rv.srcObject = callSession.remoteStream; } catch {}
    }
    // Explícito SIEMPRE (no solo al asignar): es también el
    // reintento al pasar a 'conectada' vía onCallEvent.
    callPlay(rv);
  }
}

function showCallOverlay(modo, peer, media) {
  closeCallOverlay();
  const prof = S.perfilCache.get(peer)?.profile;
  const nombre = callNombre(peer);
  const esVideo = media === 'video';
  const ov = document.createElement('div');
  ov.className = 'overlay call-overlay';
  ov.id = 'call-overlay';
  let acciones = '';
  if (modo === 'entrante') {
    acciones =
      '<button type="button" class="call-btn ok" data-call="aceptar" aria-label="Aceptar llamada">📞</button>' +
      '<button type="button" class="call-btn no" data-call="rechazar" aria-label="Rechazar llamada">✕</button>';
  } else {
    acciones =
      '<button type="button" class="call-btn mute" data-call="mute" aria-label="Silenciar micrófono">🎙️</button>' +
      '<button type="button" class="call-btn no" data-call="colgar" aria-label="Colgar">📞</button>';
  }
  ov.innerHTML =
    '<div class="sheet call" role="dialog" aria-label="' + (esVideo ? 'Videollamada' : 'Llamada de voz') + '">' +
    (esVideo
      ? '<div class="call-videos"><video id="call-remote" autoplay playsinline></video>' +
        '<video id="call-local" autoplay playsinline muted></video></div>'
      // En voz el remoto es un <audio>: sin elemento NO suena
      // (un stream WebRTC sin elemento conectado es mudo). Va en
      // el DOM aunque no se vea — clase sr, nunca display:none.
      : '<audio id="call-remote" class="call-audio-remoto" autoplay></audio>') +
    (prof ? avatarImg(peer, prof, 'avatar big') : '') +
    '<h3>' + esc(nombre) + '</h3>' +
    '<p class="call-tipo muted">' + (esVideo ? '🎥 Videollamada' : '📞 Llamada de voz') + '</p>' +
    '<p class="call-estado" id="call-estado">' +
    (modo === 'entrante' ? 'Llamada entrante…' : 'Llamando…') + '</p>' +
    '<div class="call-actions">' + acciones + '</div>' +
    '</div>';
  ov.addEventListener('click', (e) => {
    callPlayRemoto(); // cualquier toque: gesto que desbloquea el audio en iOS
    const btn = e.target.closest('[data-call]');
    if (!btn || !callSession) return;
    const act = btn.dataset.call;
    if (act === 'aceptar') {
      const box = ov.querySelector('.call-actions');
      if (box) box.innerHTML =
        '<button type="button" class="call-btn mute" data-call="mute" aria-label="Silenciar micrófono">🎙️</button>' +
        '<button type="button" class="call-btn no" data-call="colgar" aria-label="Colgar">📞</button>';
      const est = document.getElementById('call-estado');
      if (est) est.textContent = 'Conectando…';
      callSession.aceptar();
    } else if (act === 'rechazar') callSession.rechazar();
    else if (act === 'colgar') callSession.colgar();
    else if (act === 'mute') {
      const m = callSession.toggleMute();
      btn.textContent = m ? '🔇' : '🎙️';
      btn.setAttribute('aria-label', m ? 'Activar micrófono' : 'Silenciar micrófono');
    }
  });
  document.body.appendChild(ov);
  callAttachStreams();
}

// ---------- presupuesto de llamadas por relevo (v1.10.0) ----------
// La cubeta mensual vive en localStorage POR CUENTA (pubkey) y por
// mes (la clave de mes y la aritmética son de tiempollamadas.js).
// Solo descuenta el tiempo en que la llamada conectada va por
// relevo: la CallSession lo reporta con eventos 'relevo'.
function usoRelevoKey() { return S.pubkey ? 'uso_relevo:' + S.pubkey : null; }
function usoRelevoReg() {
  const k = usoRelevoKey();
  return k ? LS.get(k, null) : null;
}
function usoRelevoSumar(deltaMs) {
  const k = usoRelevoKey();
  if (!k || !(deltaMs > 0)) return usoRelevoReg();
  const reg = conUso(usoRelevoReg(), deltaMs, Date.now());
  LS.set(k, reg);
  return reg;
}

// Estado de la gracia del límite: aviso dado, corte en
// GRACIA_LIMITE_MS si la llamada sigue viva.
let limiteGracia = null; // {id, timer}
function gestionarRelevo(e) {
  const reg = usoRelevoSumar(e.deltaMs);
  if (!agotado(reg, Date.now())) return;
  if (limiteGracia && limiteGracia.id === e.id) return; // ya avisado en esta llamada
  toast(TEXTO_LIMITE_AVISO, 6000);
  const id = e.id;
  const timer = setTimeout(() => {
    limiteGracia = null;
    if (callSession && callSession.current && callSession.current.id === id) {
      callSession.terminarPorLimite();
    }
  }, GRACIA_LIMITE_MS);
  S.timers.push(timer);
  limiteGracia = { id, timer };
}
function cancelarGraciaLimite() {
  if (limiteGracia) { clearTimeout(limiteGracia.timer); limiteGracia = null; }
}

function onCallEvent(e) {
  if (!e || !e.tipo) return;
  if (e.tipo === 'entrante') {
    showCallOverlay('entrante', e.peer, e.media);
    try { if (navigator.vibrate) navigator.vibrate([300, 120, 300]); } catch {}
  } else if (e.tipo === 'saliente') {
    showCallOverlay('saliendo', e.peer, e.media);
  } else if (e.tipo === 'stream-local' || e.tipo === 'stream-remoto') {
    callAttachStreams();
  } else if (e.tipo === 'relevo') {
    gestionarRelevo(e);
  } else if (e.tipo === 'conectada') {
    callAttachStreams(); // reintento de play() ahora que hay llamada
    const est = document.getElementById('call-estado');
    if (est) est.textContent = 'En llamada · ' + fmtDuracion(callSession ? callSession.duracionSeg() : 0);
    if (callUiTimer) clearInterval(callUiTimer);
    callUiTimer = setInterval(() => {
      const el = document.getElementById('call-estado');
      if (el && callSession) el.textContent = 'En llamada · ' + fmtDuracion(callSession.duracionSeg());
    }, 500);
    S.timers.push(callUiTimer);
  } else if (e.tipo === 'terminada') {
    cancelarGraciaLimite();
    closeCallOverlay();
    const nombre = callNombre(e.peer);
    switch (e.resultado) {
      case 'completada':
        registrarLlamada(e.peer, textoRegistroLlamada({ media: e.media, resultado: 'completada', durSeg: e.durSeg }));
        break;
      case 'limite':
        registrarLlamada(e.peer, textoRegistroLlamada({ media: e.media, resultado: 'completada', durSeg: e.durSeg }));
        toast(TEXTO_LIMITE_CORTE, 9000);
        break;
      case 'perdida':
        registrarLlamada(e.peer, textoRegistroLlamada({ media: e.media, resultado: 'perdida' }));
        toast('📞 Llamada perdida de ' + nombre + '.');
        break;
      case 'sin-respuesta':
        registrarLlamada(e.peer, textoRegistroLlamada({ media: e.media, resultado: 'sin-respuesta' }));
        toast(nombre + ' no respondió.');
        break;
      case 'rechazada':
        registrarLlamada(e.peer, textoRegistroLlamada({ media: e.media, resultado: 'rechazada' }));
        toast(nombre + ' no pudo atender ahora.');
        break;
      case 'ocupado':
        registrarLlamada(e.peer, textoRegistroLlamada({ media: e.media, resultado: 'rechazada' }));
        toast(nombre + ' está en otra llamada.');
        break;
      case 'sin-conexion':
        registrarLlamada(e.peer, textoRegistroLlamada({ media: e.media, resultado: 'sin-conexion' }));
        toast('No se pudo conectar: no lo lograron ni la conexión directa ni el servidor de relevo. Revisa tu internet e inténtalo de nuevo.');
        break;
      case 'error':
        toast(e.mensaje || 'No se pudo completar la llamada.');
        break;
      default:
        break;
    }
  }
}

// ---------- 8. ajustes ----------
function showAjustes() {
  setScreenScope('both');
  stopChat();
  S.screen = 'ajustes';
  const dot = (st) => '<span class="rdot ' + (st === 'open' ? 'g' : st === 'connecting' ? 'y' : 'r') + '"></span>';
  const relayRow = (u) =>
    '<div class="relay-row" data-url="' + esc(u) + '">' + dot(S.relayStatus[u]) +
    '<span class="mono small">' + esc(u.replace('wss://', '')) + '</span></div>';
  const relayGroup = (titulo, urls) =>
    '<p class="muted small"><b>' + esc(titulo) + '</b></p>' +
    '<div class="relay-list">' + urls.map(relayRow).join('') + '</div>';
  $('#app').innerHTML = pantallaShell('ajustes',
    '<div class="aj-wrap"><h2>Ajustes</h2>' +
    '<section class="aj-sec"><h3>Cuenta</h3>' +
    '<div class="dato"><span>Usuario</span><b>@' + esc(S.username || '') + '</b></div>' +
    '<div class="dato"><span>Identidad (npub)</span><b class="mono">' + esc((S.npub || '').slice(0, 16) + '…') + '</b></div>' +
    '<button type="button" class="btn ghost" data-act="aj-logout">Cerrar sesión</button></div></section>' +
    '<section class="aj-sec"><h3>Relays</h3><p class="muted small">Estado de conexión con la red (4 relays con roles):</p>' +
    relayGroup('Descubrimiento — perfiles y likes', RELAYS.discovery) +
    relayGroup('Mensajes — chat e inbox (NIP-17)', RELAYS.messaging) +
    '<button type="button" class="btn ghost sm" data-act="aj-relays-reset">Restablecer relays</button></section>' +
    '<section class="aj-sec"><h3>Datos</h3>' +
    '<label class="check"><input type="checkbox" id="aj-datosbajos"' + (S.datosBajos ? ' checked' : '') + '> Modo datos bajos <small class="muted">(descubre menos perfiles por vez)</small></label>' +
    '</section>' +
    '<section class="aj-sec"><h3>Llamadas</h3>' +
    '<p class="muted small">Con tus matches puedes hablar por <b>voz</b> desde el primer mensaje. El <b>video</b> pide tres acuerdos: haber conversado ya (10+ mensajes en el chat), que actives esta opción y que aceptes cada videollamada cuando suene.</p>' +
    '<label class="check"><input type="checkbox" id="aj-videook"' + (S.miPerfil && S.miPerfil.videoOk ? ' checked' : '') + '> Acepto videollamadas <small class="muted">(tu preferencia viaja en tu perfil publicado, para que quien te llame la pueda ver)</small></label>' +
    '<p class="small" style="margin-top:12px"><b>' + esc(textoRestante(usoRelevoReg(), Date.now())) + '</b></p>' +
    '<p class="muted small">' + TEXTO_LIMITE_EXPL + '</p>' +
    '</section>' +
    '<section class="aj-sec"><h3>Compartir</h3>' +
    '<p class="muted small">Mientras más gente conozca CubMatch, mejores matches para todos.</p>' +
    '<button type="button" class="btn ghost" data-act="compartir">📤 Compartir CubMatch</button></section>' +
    '<section class="aj-sec"><h3>Ayuda y legal</h3>' +
    '<div class="row-btns">' +
    '<button type="button" class="btn ghost sm" data-act="info-seguridad">🛡️ Seguridad</button>' +
    '<button type="button" class="btn ghost sm" data-act="info-terminos">📄 Términos y privacidad</button>' +
    '</div></section>' +
    '<section class="aj-sec"><h3>Mi perfil</h3>' +
    '<p class="muted small">' + (S.perfilPublicado && S.miPerfil ? esc(S.miPerfil.apodo || '') + ' · ' + completitud(S.miPerfil) + '% completo' : 'Sin perfil publicado') +
    (S.miPerfil && S.miPerfil.oculto ? ' · <b>oculto</b>' : '') + '</p>' +
    '<div class="row-btns">' +
    '<button type="button" class="btn primary sm" data-act="aj-editar">Editar</button>' +
    '<button type="button" class="btn ghost sm" data-act="aj-publicar">Publicar actualización</button>' +
    (S.miPerfil && S.miPerfil.oculto
      ? '<button type="button" class="btn ghost sm" data-act="aj-mostrar">Mostrar mi perfil</button>'
      : '<button type="button" class="btn warn sm" data-act="aj-ocultar">Ocultar mi perfil</button>') +
    '</div></section>' +
    '<section class="aj-sec danger-zone"><h3>Zona de peligro</h3>' +
    '<button type="button" class="btn danger sm" data-act="aj-borrar">Borrar datos locales</button>' +
    '<p class="muted small">Borra sesión, borrador, vistos, bloqueados y chats de este teléfono. Tu perfil publicado en la red no se borra.</p>' +
    '</section>' +
    '<p class="fine">CubMatch v' + VERSION + '</p></div>');
  const tgl = $('#aj-datosbajos');
  if (tgl) tgl.addEventListener('change', () => {
    S.datosBajos = tgl.checked;
    LS.set('datosbajos', tgl.checked ? '1' : '0');
    S.data = null; // recargar con el nuevo límite la próxima vez
    toast(tgl.checked ? 'Modo datos bajos activado.' : 'Modo datos bajos desactivado.');
  });
  const tglV = $('#aj-videook');
  if (tglV) tglV.addEventListener('change', () => { void toggleVideoOk(tglV.checked); });
}

// Opt-in de videollamadas: vive en el perfil publicado (kind 30079)
// para que el que llama compruebe el consentimiento antes de marcar.
// Mismo patrón que toggleOculto: cambio optimista + republicar; si la
// red falla, se revierte.
async function toggleVideoOk(ok) {
  if (!S.perfilPublicado || !S.miPerfil) { toast('Primero publica tu perfil.'); showAjustes(); return; }
  S.miPerfil.videoOk = !!ok;
  try {
    await publishPerfilAndDocs(S.miPerfil);
    const b = LS.get('perfil', null);
    if (b) { b.videoOk = !!ok; LS.set('perfil', b); }
    toast(ok ? 'Ahora aceptas videollamadas 🎥' : 'Ya no aceptas videollamadas.');
  } catch {
    S.miPerfil.videoOk = !ok;
    toast('Sin conexión a los relays. Intenta de nuevo.');
    showAjustes();
  }
}

async function publicarActualizacion() {
  const d = LS.get('perfil', null) || (S.miPerfil ? clone(S.miPerfil) : null);
  if (!d) { toast('No hay perfil para publicar.'); return; }
  const errores = validateProfile(d);
  if (errores.length) {
    toast('Tu perfil tiene errores: ' + errores[0]);
    return;
  }
  try {
    d.oculto = !!(S.miPerfil && S.miPerfil.oculto);
    await publishPerfilAndDocs(d);
    S.miPerfil = clone(d);
    S.perfilPublicado = true;
    LS.set('perfil', d);
    toast('Perfil actualizado ✓');
    showAjustes();
  } catch {
    toast('Sin conexión a los relays. Intenta de nuevo.');
  }
}

async function toggleOculto(ocultar) {
  if (!S.perfilPublicado || !S.miPerfil) { toast('Primero publica tu perfil.'); return; }
  try {
    S.miPerfil.oculto = ocultar;
    await publishPerfilAndDocs(S.miPerfil);
    const b = LS.get('perfil', null);
    if (b) { b.oculto = ocultar; LS.set('perfil', b); }
    toast(ocultar ? 'Tu perfil está oculto.' : 'Tu perfil es visible de nuevo.');
    showAjustes();
  } catch {
    S.miPerfil.oculto = !ocultar;
    toast('Sin conexión a los relays. Intenta de nuevo.');
  }
}

function cerrarSesion() {
  if (!confirm('¿Cerrar sesión en este teléfono? Tu perfil sigue publicado en la red.')) return;
  void publicarBeacon('off'); // despedida: acorta el falso "en línea"
  stopChat();
  stopCalls();
  stopPresencia();
  try { if (S.pool) S.pool.shutdown(); } catch {}
  S.pool = null;
  LS.del('sesion');
  showInicio();
}

function restablecerRelays() {
  LS.del('relays');
  S.relayStatus = {};
  if (S.pool && S.sk) {
    stopCalls();
    stopPresencia();
    try { S.pool.shutdown(); } catch {}
    S.pool = makePool(S.sk);
    screenScope = null;
    setScreenScope('both');
    startCalls();
    startPresencia();
    startGlobalLive();
  }
  toast('Relays restablecidos. Reconectando…');
  showAjustes();
}

function borrarDatos() {
  if (!confirm('¿Borrar TODOS los datos locales de CubMatch en este teléfono? (incluye tu sesión)')) return;
  void publicarBeacon('off');
  stopChat();
  stopCalls();
  stopPresencia();
  try { if (S.pool) S.pool.shutdown(); } catch {}
  S.pool = null;
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('cubmatch_')) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
  toast('Datos locales borrados.');
  showInicio();
}

// ---------- compartir ----------
function showCompartir() {
  closeCompartir();
  const links = shareLinks();
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.id = 'compartir-overlay';
  ov.innerHTML = '<div class="sheet compartir" role="dialog" aria-label="Compartir CubMatch">' +
    '<button type="button" class="x" data-act="compartir-cerrar" aria-label="Cerrar">✕</button>' +
    '<h3>Comparte CubMatch 💘</h3>' +
    '<p class="muted">Invita a tus amigos y familia: mientras más gente se sume, mejores matches para todos.</p>' +
    '<div class="qr-box">' + qrSVG(190) + '</div>' +
    '<p class="center small muted">Escanea el código o comparte el enlace:</p>' +
    '<p class="mono small center share-url">' + esc(links.url) + '</p>' +
    '<div class="share-btns">' +
    '<button type="button" class="btn primary big" data-act="compartir-nativo">📤 Compartir…</button>' +
    '<a class="btn wa big" href="' + esc(links.whatsapp) + '" target="_blank" rel="noopener">💬 Compartir por WhatsApp</a>' +
    '<button type="button" class="btn ghost big" data-act="compartir-copiar">📋 Copiar enlace</button>' +
    '</div></div>';
  ov.addEventListener('click', (e) => { if (e.target === ov) closeCompartir(); });
  document.getElementById('app').appendChild(ov);
}
function closeCompartir() {
  const ov = $('#compartir-overlay');
  if (ov) ov.remove();
}

async function compartirNativo() {
  const links = shareLinks();
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ title: 'CubMatch', text: links.texto, url: links.url });
      return;
    } catch { return; /* el usuario canceló el diálogo */ }
  }
  await copiarEnlace();
}

async function copiarEnlace() {
  const links = shareLinks();
  try {
    await navigator.clipboard.writeText(links.url);
    toast('Enlace copiado ✓ ¡Compártelo donde quieras!');
  } catch {
    toast('Copia el enlace: ' + links.url);
  }
}

// ---------- páginas de información: seguridad / términos ----------
const SEGURIDAD_HTML =
  '<p>CubMatch no tiene una empresa detrás vigilando: la seguridad la hacemos entre todos. Aquí está lo que puedes hacer tú, sin rodeos.</p>' +
  '<h3>🚩 Cómo reportar un perfil</h3>' +
  '<p>En el detalle de cualquier perfil (botón <b>i</b> en Descubrir) y también desde el chat, tienes el botón <b>Reportar</b>. Al reportar:</p>' +
  '<ul>' +
  '<li>Se publica un <b>reporte firmado en la red</b> (un aviso público que queda registrado y que cualquiera puede consultar).</li>' +
  '<li>Tu reporte ayuda a que la comunidad sepa qué cuentas son falsas, acosadoras o peligrosas.</li>' +
  '<li>Reportar no borra la cuenta de nadie al instante: no hay un jefe que la apague. Por eso reporta <b>y</b> bloquea.</li>' +
  '</ul>' +
  '<h3>🚫 Cómo bloquear</h3>' +
  '<p>El botón <b>Bloquear</b> (en el detalle del perfil o en el chat) hace efecto <b>al momento y en tu teléfono</b>: esa persona desaparece de tu Descubrir, de tus matches y no vuelve a aparecerte. Nadie le avisa que la bloqueaste.</p>' +
  '<h3>🤝 Sin moderación central (la verdad)</h3>' +
  '<p>No hay un equipo de moderación revisando perfiles ni mensajes: CubMatch funciona sin servidores, así que <b>nadie puede leer tus chats ni borrar cuentas ajenas</b>. La protección real es la combinación de reportes públicos + bloqueos + tu criterio. Si un perfil te parece falso o peligroso, no arriesgues: bloquea.</p>' +
  '<h3>💡 Consejos para conocer gente</h3>' +
  '<ul>' +
  '<li>Primera cita siempre en un <b>lugar público</b> y con gente alrededor (un parque, una cafetería, el malecón).</li>' +
  '<li><b>Avisa a un amigo o familiar</b> con quién vas, dónde y a qué hora piensas volver.</li>' +
  '<li>No compartas tu dirección exacta, datos de dinero ni contraseñas con nadie que acabas de conocer.</li>' +
  '<li>Ve por tu cuenta: ten tu propio transporte o dinero para regresar.</li>' +
  '<li>Si algo te da mala espina, aunque no sepas por qué, <b>cancela la cita</b>. Tu seguridad vale más que un match.</li>' +
  '</ul>';

const TERMINOS_HTML =
  '<p>En palabras simples: esto es lo que aceptas al usar CubMatch.</p>' +
  '<h3>🔞 Solo mayores de 18 años</h3>' +
  '<p>CubMatch es una app de citas <b>solo para personas de 18 años o más</b>. Si eres menor, no la uses.</p>' +
  '<h3>🗄️ Tus datos: no hay servidores</h3>' +
  '<p>CubMatch no guarda tus datos en ningún servidor ni empresa. Tu perfil se publica en la <b>red abierta Nostr</b> y, por diseño, es <b>público</b>: cualquiera puede verlo, igual que una publicación abierta en internet. No pongas en tu perfil nada que no quieras que el mundo vea (dirección exacta, documentos, datos de menores, etc.).</p>' +
  '<h3>🔒 Lo que sí va cifrado</h3>' +
  '<p>Los <b>mensajes de chat</b> (que solo existen tras un match mutuo) viajan <b>cifrados</b>: solo tú y la otra persona pueden leerlos. Ni los relays que los transportan pueden abrirlos.</p>' +
  '<h3>🗑️ La realidad del borrado</h3>' +
  '<p>Puedes ocultar tu perfil y solicitar su borrado, y la app lo retira de los relays que conoce. Pero la red funciona con <b>copias repartidas</b>: relays de terceros que ya copiaron tu perfil pueden conservarlo un tiempo (o indefinidamente) fuera de nuestro alcance. Piensa antes de publicar: en una red abierta, <b>borrar del todo no se puede garantizar</b>.</p>' +
  '<h3>🔑 Tu contraseña es tu cuenta</h3>' +
  '<p>No hay recuperación de contraseña: si la olvidas, pierdes la cuenta y nadie puede devolvértela. Guárdala en un lugar seguro.</p>' +
  '<h3>⚖️ Sin garantías</h3>' +
  '<p>CubMatch es un proyecto comunitario y gratuito: se ofrece "tal cual", sin garantías de disponibilidad ni de resultados. Tú eres responsable de tus encuentros fuera de la app; lee la sección de <button type="button" class="link inline" data-act="info-seguridad">Seguridad</button> y cuídate.</p>' +
  '<p>¿Quieres entender la parte técnica sin tecnicismos? Mira <button type="button" class="link inline" data-act="info-como">¿Cómo funciona?</button> en la pantalla de inicio.</p>';

function showInfo(kind) {
  stopChat();
  const from = S.screen === 'ajustes' ? 'ajustes' : 'inicio';
  S.infoFrom = from;
  S.screen = 'info';
  setScreenScope(null);
  const titulo = kind === 'seguridad' ? '🛡️ Seguridad' : '📄 Términos y privacidad';
  const inner = '<div class="info-wrap">' +
    '<button type="button" class="link" data-act="info-volver">← Volver</button>' +
    '<h2>' + titulo + '</h2>' +
    (kind === 'seguridad' ? SEGURIDAD_HTML : TERMINOS_HTML) +
    '</div>';
  $('#app').innerHTML = from === 'ajustes'
    ? pantallaShell('ajustes', inner)
    : '<div class="screen"><div class="scroll">' + inner + '</div></div>';
}

// ---------- router de acciones (delegación en #app) ----------
const ACTIONS = {
  'ir-inicio': () => showInicio(),
  'ir-registro': () => showCuenta('registro'),
  'ir-login': () => showCuenta('login'),
  'toggle-clave': (el) => {
    const wrap = el.closest('.pw-wrap');
    const inp = wrap ? wrap.querySelector('input') : null;
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    el.textContent = show ? '🙈' : '👁️';
    el.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
  },
  'nav-deck': () => showDeck(),
  'nav-top10': () => showTop10(),
  'nav-matches': () => showMatches(),
  'nav-avisos': () => showAvisos(),
  'nav-ajustes': () => showAjustes(),
  'sug-ir': (el) => irAPasoEditor(Number(el.dataset.paso) || 1),
  'grid-si': (el) => gridAction(el.dataset.peer, 'si'),
  'grid-super': (el) => gridAction(el.dataset.peer, 'super'),
  'grid-no': (el) => gridAction(el.dataset.peer, 'no'),
  'grid-info': (el) => showDetalle(el.dataset.peer),
  'lg-si': (el) => lgAction(el.dataset.peer, true),
  'lg-no': (el) => lgAction(el.dataset.peer, false),
  'compartir': () => showCompartir(),
  'compartir-cerrar': () => closeCompartir(),
  'compartir-nativo': () => compartirNativo(),
  'compartir-copiar': () => copiarEnlace(),
  'info-seguridad': () => showInfo('seguridad'),
  'info-terminos': () => showInfo('terminos'),
  'info-volver': () => (S.infoFrom === 'ajustes' ? showAjustes() : showInicio()),
  'info-como': () => showInicio(),
  'ob-atras': () => obAtras(),
  'ob-siguiente': () => obSiguiente(),
  'deck-si': () => doLike(false),
  'deck-super': () => doLike(true),
  'deck-no': () => doDislike(),
  'deck-info': () => { const c = curCand(); if (c) showDetalle(c.other.pubkey); },
  'deck-recargar': () => { forceRefresh(); S.candidatos = []; showDeck(); },
  'detalle-cerrar': () => closeDetalle(),
  'perfil-reportar': (el) => reportarPerfil(el.dataset.peer),
  'perfil-bloquear': (el) => bloquearPerfil(el.dataset.peer),
  'top-si': (el) => topAction(el.closest('.row').dataset.peer, true),
  'top-no': (el) => topAction(el.closest('.row').dataset.peer, false),
  'matches-actualizar': () => { forceRefresh(); showMatches(); },
  'match-chatear': (el) => {
    const ov = $('#match-overlay');
    if (ov) ov.remove();
    showChat(el.dataset.peer);
  },
  'match-seguir': () => {
    const ov = $('#match-overlay');
    if (ov) ov.remove();
    nextCard();
  },
  'chat-ver-perfil': (el) => showChatPerfil(el.dataset.peer),
  'chatperfil-volver': (el) => showChat(el.dataset.peer),
  'chat-reintentar': (el) => reintentarMsg(el.dataset.mid),
  'chat-call-voz': () => iniciarLlamada('audio'),
  'chat-call-video': () => {
    const peer = S.chatPeer;
    if (!peer) return;
    const prof = S.perfilCache.get(peer)?.profile;
    const chk = videoDisponible(S.miPerfil, prof, numMensajesChat(peer));
    if (!chk.ok) { toast(chk.texto); return; }
    iniciarLlamada('video');
  },
  'chat-loc': () => showLocConfirm(),
  'chat-loc-si': () => enviarUbicacion(),
  'chat-loc-no': () => closeLocConfirm(),
  'chat-stickers': () => toggleStickerPanel(),
  'sticker-send': (el) => { if (!S.stickerEdit) enviarSticker(el.dataset.url); },
  'sticker-del': (el) => { removeSticker(LS, S.pubkey, el.dataset.url); renderStickerPanel(); },
  'sticker-editar': () => { S.stickerEdit = !S.stickerEdit; renderStickerPanel(); },
  'aj-editar': () => {
    S.borrador = LS.get('perfil', null) || (S.miPerfil ? clone(S.miPerfil) : newProfile());
    S.obPaso = 1;
    showOnboarding();
  },
  'aj-publicar': () => publicarActualizacion(),
  'aj-ocultar': () => toggleOculto(true),
  'aj-mostrar': () => toggleOculto(false),
  'aj-logout': () => cerrarSesion(),
  'aj-relays-reset': () => restablecerRelays(),
  'aj-borrar': () => borrarDatos(),
};

function onAppClick(e) {
  const chip = e.target.closest('[data-chip]');
  if (chip) { toggleChip(chip); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el, e);
}

// ---------- final ----------
const VERSION = '__APP_VERSION__';
window.__cubmatchApp = { boot, dispose, version: VERSION };
// Ganchos solo para tests (no usar en producción).
window.__cubmatchApp._test = { dmToMsg, handleReceipt, syncChatHistory, noLeidos, showDeck, renderLeGustas, lgAction, showOnboarding, onFotoChange, showChat, showChatPerfil, sendChatPayload, reintentarMsg, handleBeaconEvent, pintarPresencia, renderMsgs, renderStickerPanel, toggleStickerPanel, showLocConfirm, closeLocConfirm, enviarUbicacion, showAjustes, showAvisos, onCallEvent, getUsoRelevo: () => usoRelevoReg(), toggleVideoOk, startCalls, stopCalls, handleCallSignalEvent, numMensajesChat, refreshVideoBtn, getCallSession: () => callSession, setCallDeps: (d) => { Object.assign(callDeps, d); }, getS: () => S, onGlobalDM, onGlobalLike, startGlobalLive, stopGlobalLive, nombreCorto };

// Arranque automático si el módulo se carga directo (el build también puede llamar a boot).
if (typeof document !== 'undefined') {
  if (document.readyState !== 'loading') {
    queueMicrotask(() => { try { window.__cubmatchApp.boot(); } catch {} });
  } else {
    document.addEventListener('DOMContentLoaded', () => { try { window.__cubmatchApp.boot(); } catch {} });
  }
}
