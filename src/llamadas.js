// CUBMATCH — llamadas de voz y video entre matches (v1.7.0).
//
// WebRTC puro entre pares, SIN servidor de medios propio: la
// señalización viaja como eventos efímeros kind 21004 (rango
// 20000-29999) con el contenido cifrado NIP-04 al par, igual que
// los DMs. OJO: no todos los relays tratan ese rango como efímero
// de verdad — algunos lo almacenan y lo reentregan al reconectar o
// re-suscribir. Por eso la app defiende la entrada: puerta de
// frescura sobre created_at (app.js) + dedup por callId aquí: una
// offer vieja o repetida NUNCA suena dos veces.
//
// Rutas ICE: STUN público para la conexión directa y, de respaldo,
// TURN público comunitario (OpenRelay de Metered): con CGNAT en
// ambos lados (datos móviles) el solo-STUN no atraviesa y el relevo
// es la única vía. Cuando se usa TURN, el medio pasa por ese
// servidor, pero cifrado extremo a extremo (DTLS-SRTP): el relevo
// no puede escucharlo. Es un servicio gratuito de terceros: si
// también falla, la llamada no conecta y la UI lo dice con
// honestidad.
//
// Relevo prioritario (v1.9.1): Metered / Open Relay TURN con la
// cuenta propia del dueño, con credenciales pedidas a su API al
// momento de la llamada (módulo turnmd.js; solo activo si el build
// inyectó la cuenta). La configuración ICE se obtiene de un
// proveedor asíncrono (inyectable; por defecto obtenerIceServers):
// lo de Metered fresco primero, OpenRelay público + STUN de
// siempre después. Si Metered falla o está desactivado, la
// configuración es exactamente la anterior: la llamada NUNCA
// depende de la cuenta de Metered.
//
// Blindaje de estados (v1.8.3, anti-ocupado fantasma): ningún estado
// sin conexión viva puede vivir eternamente. Causas cazadas en la
// v1.8.1: `conectando` no tenía NINGÚN temporizador (al responder
// se desarmaba el de timbre y el ICE móvil puede quedarse en
// checking/disconnected sin llegar jamás a failed) y un end/reject
// que adelantaba a su offer se descartaba, dejando sonar llamadas
// ya muertas. Ahora: timbre entrante alineado (45 s), timeout de
// conexión, watchdog de ICE desconectado, memoria de señales
// terminales de ids desconocidos, un ÚNICO camino de reset y
// defensas para liberar un estado pegado al llamar o al recibir.
// Y si el primer intento de conexión muere en `conectando`, hay
// UNA segunda oportunidad: renegociación con restart de ICE
// (mismo callId, offer marcada restart:true) antes de rendirse.
//
// Reglas de producto (del dueño):
// - Voz: disponible desde el primer momento tras el match.
// - Video, triple consentimiento:
//   1) dinámica: >= 10 mensajes intercambiados en ese chat;
//   2) opt-in del receptor: su perfil publicado trae videoOk: true
//      (por defecto false; se cambia en Ajustes y se republica);
//   3) aceptación en el momento de cada llamada entrante.
//   Si el receptor no tiene videoOk, ni le suena: el que llama lo
//   sabe antes de marcar (su app lee el perfil) y el receptor, por
//   si el dato del llamante estaba viejo, rechaza en silencio.
//
// Presupuesto de relevo (v1.10.0): la app es para mucho público y
// el relevo tiene un cupo gratuito mensual compartido. Mientras la
// llamada está conectada, la sesión muestrea las estadísticas del
// pc cada ~10 s: si el par seleccionado es de tipo `relay`, ese
// tiempo se reporta con eventos 'relevo' (deltaMs) y la app lo
// descuenta del presupuesto mensual de la persona (la cubeta y los
// textos viven en tiempollamadas.js). Lo directo (host/srflx) NO
// descuenta. Si el presupuesto se agota, la app avisa, da una
// gracia corta y llama a terminarPorLimite().
//
// Este módulo es casi puro (sin DOM): la máquina de estados recibe
// el transporte (send), la fábrica de RTCPeerConnection, getUserMedia
// y el proveedor de configuración ICE inyectados, para probarla en
// Node con falsos. Las únicas dependencias son turnmd.js y
// tiempollamadas.js (también puros).

import { getMeteredIceServers } from './turnmd.js';
import { tipoDelParSeleccionado, MUESTREO_RELEVO_MS } from './tiempollamadas.js';

export const KIND_CALL = 21004; // efímero: señalización de llamada
export const CALL_V = 1;
export const MIN_MSGS_VIDEO = 10;
export const RING_TIMEOUT_MS = 45000;       // timbre saliente: 45 s
// Timbre entrante: 45 s, ALINEADO con el saliente (antes 60 s: el
// llamante ya había abandonado y el receptor seguía "ocupado" con
// una llamada muerta — falso ocupado en cada reintento rápido).
export const RING_IN_TIMEOUT_MS = 45000;
// `conectando` tampoco es eterno: si tras responder/aceptar el medio
// no llega a conectar en este plazo, la llamada se da por imposible.
export const CONNECT_TIMEOUT_MS = 45000;
// Watchdog de ICE: en redes móviles `disconnected` puede no pasar
// nunca a `failed`; si dura más que esta gracia seguida, se corta.
export const ICE_DISCONNECTED_GRACE_MS = 10000;
// Un estado no-idle sin pc viva, o más viejo que esto, está pegado:
// no puede bloquear ni la llamada propia ni una offer nueva.
export const ESTADO_PEGADO_MS = 60000;

// Puerta de frescura de las offers: la señalización caduca enseguida
// (el timbre saliente dura 45 s). Una offer con created_at más viejo
// que esto es un eco almacenado por un relay, no una llamada real.
export const OFFER_MAX_EDAD_SEG = 60;
// Tolerancia a relojes adelantados: más que esto ya es absurdo.
export const OFFER_MAX_FUTURO_SEG = 120;
// Buffer de ICE que llega antes que su offer (los relays no
// garantizan orden entre eventos): vive poco y se aplica al sonar.
export const ICE_BUFFER_TTL_MS = 60000;
export const ICE_BUFFER_MAX_IDS = 8;
export const ICE_BUFFER_MAX_POR_ID = 64;
// Memoria de callId ya cerrados: una offer repetida no resucita.
export const IDS_CERRADOS_TTL_MS = 10 * 60 * 1000;

// STUN públicos (solo descubrimiento de rutas; el audio/video va
// directo entre teléfonos, nunca pasa por estos servidores).
export const STUN_URLS = [
  'stun:stun.cloudflare.com:3478',
  'stun:stunserver.stunprotocol.org:3478',
  'stun:stun.l.google.com:19302',
];

// TURN público comunitario (proyecto OpenRelay de Metered, con
// credenciales públicas): el respaldo para datos móviles tras CGNAT.
// Varias puertas del MISMO servidor: UDP y TCP por el 80, TCP por el
// 443 (para redes que bloquean todo puerto que no sea el web) y TLS.
export const TURN_URLS = [
  'turn:openrelay.metered.ca:80',
  'turn:openrelay.metered.ca:80?transport=tcp',
  'turn:openrelay.metered.ca:443?transport=tcp',
  'turns:openrelay.metered.ca:443',
];
export const TURN_USER = 'openrelayproject';
export const TURN_PASS = 'openrelayproject';

export function iceServersConfig() {
  return [
    { urls: STUN_URLS.slice() },
    { urls: TURN_URLS.slice(), username: TURN_USER, credential: TURN_PASS },
  ];
}

// ------------------------------------------------------- fusión con Metered

// Fusiona los iceServers de Metered (si los hay) con la
// configuración base (OpenRelay público + STUN), Metered PRIMERO y
// sin URLs duplicadas: una URL ya aportada por un servidor anterior
// se quita de los siguientes. Con mdServers null/vacío devuelve la
// configuración base intacta.
export function fusionarIceServers(mdServers, base = iceServersConfig()) {
  const vistos = new Set();
  const salida = [];
  const empujar = (entry) => {
    if (!entry || entry.urls == null) return;
    const urls = (Array.isArray(entry.urls) ? entry.urls : [entry.urls])
      .filter((u) => typeof u === 'string' && u !== '' && !vistos.has(u));
    if (!urls.length) return;
    for (const u of urls) vistos.add(u);
    salida.push({ ...entry, urls });
  };
  if (Array.isArray(mdServers)) for (const e of mdServers) empujar(e);
  for (const e of base) empujar(e);
  return salida;
}

// Proveedor ICE por defecto de CallSession: pide a Metered las
// credenciales de la cuenta del dueño (turnmd.js) y fusiona con la
// base. Nunca lanza y nunca devuelve vacío: sin Metered
// (desactivado en el build, red caída, timeout) la configuración
// es EXACTAMENTE la de siempre — la llamada no depende de la
// cuenta de Metered.
export async function obtenerIceServers({ force = false, mdFn } = {}) {
  let md = null;
  try { md = await (typeof mdFn === 'function' ? mdFn : getMeteredIceServers)({ force }); } catch { md = null; }
  return fusionarIceServers(md);
}

// ------------------------------------------------------------ ids

// Id de llamada: 16 hex. rng inyectable para tests deterministas.
export function newCallId(rng) {
  const rand = typeof rng === 'function' ? rng : null;
  let hex = '';
  if (!rand && typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    hex = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  } else {
    const r = rand || Math.random;
    for (let i = 0; i < 16; i++) hex += Math.floor(r() * 16).toString(16);
  }
  return 'call-' + hex;
}

// ------------------------------------------------------------ payloads

export const CALL_OPS = ['offer', 'answer', 'ice', 'end', 'reject'];
export const CALL_MEDIAS = ['audio', 'video'];
export const CALL_MOTIVOS = ['ocupado', 'no-acepta-video', 'sin-dinamica'];

const idOk = (id) => typeof id === 'string' && id.length >= 8 && id.length <= 64 && /^[A-Za-z0-9-]+$/.test(id);
const sdpOk = (sdp) => typeof sdp === 'string' && sdp.length > 0 && sdp.length <= 65536;
const candOk = (c) =>
  (typeof c === 'string' && c.length > 0 && c.length <= 4096) ||
  (!!c && typeof c === 'object' && typeof c.candidate === 'string' && c.candidate.length <= 4096);

// Construye el payload de señalización (objeto listo para JSON).
// Solo incluye los campos opcionales cuando son válidos. `restart`
// marca una offer de renegociación con reinicio de ICE dentro de la
// MISMA llamada (mismo id): no es una llamada nueva.
export function buildCallPayload({ id, op, media, sdp, candidate, motivo, restart } = {}) {
  const p = { t: 'call', v: CALL_V, id, op, media };
  if (sdpOk(sdp)) p.sdp = sdp;
  if (candOk(candidate)) p.candidate = candidate;
  if (CALL_MOTIVOS.includes(motivo)) p.motivo = motivo;
  if (op === 'offer' && restart === true) p.restart = true;
  return p;
}

// Parsea y valida un payload recibido (texto descifrado). Devuelve el
// payload normalizado o null si es basura: cualquier desviación del
// formato se descarta en silencio (la señalización no es de fiar).
export function parseCallPayload(text) {
  if (typeof text !== 'string') return null;
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.t !== 'call' || o.v !== CALL_V) return null;
  if (!idOk(o.id)) return null;
  if (!CALL_OPS.includes(o.op)) return null;
  if (!CALL_MEDIAS.includes(o.media)) return null;
  const p = { t: 'call', v: CALL_V, id: o.id, op: o.op, media: o.media };
  if (o.op === 'offer' || o.op === 'answer') {
    if (!sdpOk(o.sdp)) return null;
    p.sdp = o.sdp;
  }
  if (o.op === 'offer' && o.restart === true) p.restart = true;
  if (o.op === 'ice') {
    if (!candOk(o.candidate)) return null;
    p.candidate = o.candidate;
  }
  if (CALL_MOTIVOS.includes(o.motivo)) p.motivo = o.motivo;
  return p;
}

// ------------------------------------------------------------ frescura

// ¿La offer es de AHORA? createdAtSeg y nowSeg en segundos (el
// created_at del evento Nostr y el reloj local). Fresca si no tiene
// más de OFFER_MAX_EDAD_SEG en el pasado ni más de
// OFFER_MAX_FUTURO_SEG en el futuro (relojes desajustados). Todo lo
// demás — vieja reproducida por un relay, fecha absurda, basura —
// no es fresca y la offer se ignora en silencio.
export function offerEsFresca(createdAtSeg, nowSeg) {
  const c = Number(createdAtSeg), n = Number(nowSeg);
  if (!Number.isFinite(c) || !Number.isFinite(n) || c <= 0) return false;
  return n - c <= OFFER_MAX_EDAD_SEG && c - n <= OFFER_MAX_FUTURO_SEG;
}

// ------------------------------------------------------------ candados de video

// ¿Puedo INICIAR una videollamada con esta persona? Revisa la
// dinámica y el opt-in DEL RECEPTOR (su perfil). El consentimiento
// del que llama es la propia acción de llamar; su videoOk manda
// cuando a él le llaman (ver rechazoEntranteVideo).
// Devuelve {ok:true} | {ok:false, motivo, texto}.
export function videoDisponible(miPerfil, suPerfil, numMensajes) {
  const n = Number(numMensajes) || 0;
  if (n < MIN_MSGS_VIDEO) {
    return {
      ok: false, motivo: 'dinamica',
      texto: 'Sigan conversando: el video se activa con 10+ mensajes.',
    };
  }
  if (!suPerfil || suPerfil.videoOk !== true) {
    return {
      ok: false, motivo: 'no-acepta',
      texto: 'Esta persona no acepta videollamadas.',
    };
  }
  return { ok: true };
}

// Lado receptor: si llega una offer de video, ¿puede sonar? Revisa
// MI opt-in y la dinámica según mi historial local. Devuelve null si
// puede sonar, o el motivo de rechazo silencioso ('no-acepta-video'
// | 'sin-dinamica'): al receptor no le suena y el llamante recibe el
// motivo (su dato de mi perfil podía estar viejo).
export function rechazoEntranteVideo(miPerfil, numMensajes) {
  if (!miPerfil || miPerfil.videoOk !== true) return 'no-acepta-video';
  if ((Number(numMensajes) || 0) < MIN_MSGS_VIDEO) return 'sin-dinamica';
  return null;
}

// ------------------------------------------------------------ textos de registro

// Duración M:SS (p. ej. 3:24), para el cronómetro y el registro.
export function fmtDuracion(seg) {
  const s = Math.max(0, Math.floor(Number(seg) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// Texto del registro local en el chat (solo vive en el dispositivo).
export function textoRegistroLlamada({ media, resultado, durSeg } = {}) {
  const esVideo = media === 'video';
  const ico = esVideo ? '🎥' : '📞';
  const nombre = esVideo ? 'Videollamada' : 'Llamada de voz';
  switch (resultado) {
    case 'completada': return ico + ' ' + nombre + ' · ' + fmtDuracion(durSeg);
    case 'perdida': return ico + ' ' + nombre.replace(' de voz', '') + ' perdida';
    case 'sin-respuesta': return ico + ' ' + nombre + ' sin respuesta';
    case 'rechazada': return ico + ' ' + nombre + ' rechazada';
    case 'sin-conexion': return ico + ' La llamada no se pudo conectar';
    default: return ico + ' ' + nombre;
  }
}

// Texto en español para un fallo de getUserMedia según el error
// real del navegador: el usuario merece distinguir un permiso
// denegado de un micrófono inexistente o de uno ocupado por otra
// app — no un genérico que no dice nada.
export function mensajeErrorMedios(err, media) {
  const video = media === 'video';
  const name = err && typeof err.name === 'string' ? err.name : '';
  const msg = err && typeof err.message === 'string' ? err.message : '';
  // Sin getUserMedia no hay llamada posible en este navegador o
  // contexto (WebView, página no segura): app.js rechaza con
  // name 'SinGetUserMedia' (o, en su defecto, este mensaje exacto).
  if (name === 'SinGetUserMedia' || msg === 'getUserMedia no disponible') {
    return 'Tu navegador no permite llamadas aquí. Abre la página en Safari o Chrome.';
  }
  switch (name) {
    case 'NotReadableError':
    case 'AbortError':
      return video
        ? 'La cámara o el micrófono están ocupados por otra aplicación.'
        : 'El micrófono está ocupado por otra aplicación.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return video
        ? 'No se encontró micrófono o cámara en este dispositivo.'
        : 'No se encontró micrófono en este dispositivo.';
    case 'NotAllowedError':
    case 'SecurityError':
    default:
      return video
        ? 'Permiso de cámara o micrófono denegado. Revisa los permisos del navegador.'
        : 'Permiso de micrófono denegado. Revisa los permisos del navegador.';
  }
}

// ------------------------------------------------------------ máquina de estados

// Estados: idle → saliendo → conectando → conectada
//          idle → entrante → conectando → conectada
// Cualquier estado vuelve a idle al terminar (con evento 'terminada').
//
// Eventos (onEvent):
//   {tipo:'saliente',  peer, media, id}
//   {tipo:'entrante',  peer, media, id}
//   {tipo:'stream-local',  stream}
//   {tipo:'stream-remoto', stream}
//   {tipo:'conectada', peer, media, id}
//   {tipo:'relevo', peer, media, id, deltaMs}  (tiempo por relevo a descontar)
//   {tipo:'terminada', peer, media, id, durSeg, resultado, mensaje?}
// resultado: 'completada' | 'perdida' | 'sin-respuesta' | 'rechazada'
//          | 'ocupado' | 'sin-conexion' | 'error' | 'limite'
export class CallSession {
  constructor({ send, createPC, getLocalStream, onEvent, setTimeoutFn, clearTimeoutFn, nowFn, rng, getIceServers } = {}) {
    if (typeof send !== 'function') throw new Error('CallSession: falta send');
    if (typeof createPC !== 'function') throw new Error('CallSession: falta createPC');
    if (typeof getLocalStream !== 'function') throw new Error('CallSession: falta getLocalStream');
    this._send = send;
    this._createPC = createPC;
    this._getLocalStream = getLocalStream;
    // Proveedor asíncrono de configuración ICE (v1.9.0): se consulta
    // ANTES de crear cada RTCPeerConnection y en el restart de ICE.
    // Inyectable en tests; por defecto, obtenerIceServers (Metered
    // fresco + base). La fábrica createPC recibe la config resultante.
    this._getIceServers = typeof getIceServers === 'function' ? getIceServers : null;
    this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this._setT = setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    this._clearT = clearTimeoutFn || ((t) => clearTimeout(t));
    this._now = nowFn || (() => Date.now());
    this._rng = rng;
    this.state = 'idle';
    this.current = null; // {id, peer, media, dir, sdp?}
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.muted = false;
    this._connectedAt = 0;
    this._ringTimer = null;      // timbre (saliendo o entrante)
    this._connectTimer = null;   // plazo para que `conectando` conecte
    this._iceWatchdog = null;    // gracia de ICE `disconnected`
    this._statsTimer = null;     // muestreo de relevo (v1.10.0)
    this._ultimaMuestra = 0;     // instante de la última muestra de stats
    this._iceQueue = [];
    this._stateSince = this._now(); // nacimiento del estado actual
    // Defensa ante reentregas de los relays (el mismo evento llega
    // por varios, o un relay lo guardó y lo suelta al reconectar):
    // ids de llamadas ya cerradas (no resucitan) y buffer de ICE
    // que llegó antes que su offer (sin orden garantizado).
    this._idsCerrados = new Map(); // id -> instante (ms, reloj inyectado)
    this._iceHuerfano = new Map(); // id -> {peer, candidates: [], t0}
  }

  duracionSeg() {
    return this._connectedAt ? Math.max(0, Math.floor((this._now() - this._connectedAt) / 1000)) : 0;
  }

  // Configuración ICE vigente vía el proveedor (inyectado o el por
  // defecto). Nunca lanza ni devuelve vacío: en el peor caso, la
  // configuración base de siempre (OpenRelay + STUN).
  async _pedirIceServers(opts) {
    try {
      const cfg = this._getIceServers
        ? await this._getIceServers(opts)
        : await obtenerIceServers(opts);
      if (Array.isArray(cfg) && cfg.length) return cfg;
    } catch {}
    return iceServersConfig();
  }

  _emit(e) { try { this._onEvent(e); } catch {} }

  // Única vía para cambiar de estado: deja constancia de cuándo
  // nació el estado (la antigüedad decide si está pegado).
  _setState(s) {
    this.state = s;
    this._stateSince = this._now();
  }

  _sendSafe(peer, payload) {
    try {
      const r = this._send(peer, payload);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {}
  }

  _armTimer(key, ms, fn) {
    this._disarmTimer(key);
    this[key] = this._setT(() => { this[key] = null; fn(); }, ms);
  }

  _disarmTimer(key) {
    if (this[key] != null) { try { this._clearT(this[key]); } catch {} this[key] = null; }
  }

  _armRingTimer(ms, fn) { this._armTimer('_ringTimer', ms, fn); }
  _disarmRingTimer() { this._disarmTimer('_ringTimer'); }
  _disarmConnectTimer() { this._disarmTimer('_connectTimer'); }
  _disarmIceWatchdog() { this._disarmTimer('_iceWatchdog'); }
  _disarmStatsTimer() { this._disarmTimer('_statsTimer'); }

  _disarmAllTimers() {
    this._disarmRingTimer();
    this._disarmConnectTimer();
    this._disarmIceWatchdog();
    this._disarmStatsTimer();
  }

  // Cierre local SIN avisar ni emitir (logout, cambio de cuenta).
  abortar() {
    this._reset();
  }

  // Anota un callId como cerrado: si su offer se reentrega, no suena.
  _recordarId(id) {
    if (!id) return;
    this._idsCerrados.set(id, this._now());
    this._iceHuerfano.delete(id);
    this._podarMemoria();
  }

  // Poda por TTL la memoria anti-reentrega (ids cerrados y buffer
  // de ICE huérfano). Se llama al anotar y al recibir señalización.
  _podarMemoria() {
    const ahora = this._now();
    for (const [id, ts] of this._idsCerrados) {
      if (ahora - ts > IDS_CERRADOS_TTL_MS) this._idsCerrados.delete(id);
    }
    for (const [id, b] of this._iceHuerfano) {
      if (ahora - b.t0 > ICE_BUFFER_TTL_MS) this._iceHuerfano.delete(id);
    }
  }

  _idCerrado(id) {
    const ts = this._idsCerrados.get(id);
    if (ts === undefined) return false;
    if (this._now() - ts > IDS_CERRADOS_TTL_MS) { this._idsCerrados.delete(id); return false; }
    return true;
  }

  // Guarda un candidato ICE que llegó antes que su offer (o sin
  // sesión): se aplicará cuando la offer cree la sesión.
  _buferizarIce(peer, payload) {
    if (this._idCerrado(payload.id)) return; // llamada ya muerta
    this._podarMemoria();
    let b = this._iceHuerfano.get(payload.id);
    if (!b) {
      if (this._iceHuerfano.size >= ICE_BUFFER_MAX_IDS) {
        // Fuera el más viejo (el Map conserva orden de inserción).
        this._iceHuerfano.delete(this._iceHuerfano.keys().next().value);
      }
      b = { peer, candidates: [], t0: this._now() };
      this._iceHuerfano.set(payload.id, b);
    }
    if (b.peer !== peer) return;
    if (b.candidates.length < ICE_BUFFER_MAX_POR_ID) b.candidates.push(payload.candidate);
  }

  // ---------------------------------------------------------- reset único
  // EL camino de vuelta a idle. TODAS las salidas pasan por aquí
  // (colgar, rechazo, timeouts, errores, ICE muerto, aborto):
  // anota el callId como cerrado, cancela TODOS los temporizadores,
  // cierra el pc, detiene los tracks y limpia el estado. Si una
  // salida futura olvida este método, el blindaje se rompe: no
  // resetees a mano en ningún otro sitio.
  _reset() {
    const cur = this.current;
    if (cur) this._recordarId(cur.id);
    this._disarmAllTimers();
    this._iceQueue = [];
    this._connectedAt = 0;
    this.muted = false;
    if (this.localStream) {
      this._pararPistas(this.localStream);
      this.localStream = null;
    }
    this.remoteStream = null;
    if (this.pc) {
      try {
        this.pc.onicecandidate = null; this.pc.ontrack = null;
        this.pc.onconnectionstatechange = null; this.pc.oniceconnectionstatechange = null;
      } catch {}
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
    this._setState('idle');
    this.current = null;
    return cur;
  }

  // Termina la llamada actual emitiendo 'terminada'.
  _terminar(resultado, mensaje) {
    if (!this.current) { this._reset(); return; }
    const cur = this.current;
    const durSeg = this.duracionSeg(); // antes del reset: limpia _connectedAt
    this._reset();
    this._emit({
      tipo: 'terminada', peer: cur.peer, media: cur.media, id: cur.id,
      durSeg, resultado, ...(mensaje ? { mensaje } : {}),
    });
  }

  // Cierre avisado en una sola vía (v1.12.9, punto 4: ligereza):
  // avisa al par con `end` y termina con el resultado dado. El par
  // `end` + `_terminar` vivía copiado en timeouts, ICE muerto,
  // errores de medios, límite y colgar; ahora vive solo aquí.
  _cortar(cur, resultado, mensaje) {
    this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'end', media: cur.media }));
    this._terminar(resultado, mensaje);
  }


  // Vigencia de una llamada en curso (v1.12.10, punto 4: ligereza):
  // la guarda "hay pc Y la llamada actual sigue siendo esta" vivía
  // copiada en 11 sitios con los operandos en distinto orden (las
  // dos escrituras niegan lo mismo). Ahora vive solo aquí. NO
  // sustituye a las guardas por id de los handlers de
  // señalización, que comparan otra cosa, ni a las guardas de
  // identidad sin pc de antes de crear el pc (llamar y aceptar):
  // ahí todavía no hay pc que exigir.
  _vigente(cur) {
    return !!this.pc && this.current === cur;
  }

  // Parada de pistas de un stream (v1.12.10): detener todos los
  // tracks tragándose errores, como vivía copiado en _reset, al
  // llamar y al aceptar cuando la llamada se aborta a mitad de
  // camino. Sin stream no hay nada que parar.
  _pararPistas(stream) {
    if (!stream) return;
    try { for (const t of stream.getTracks()) t.stop(); } catch {}
  }

  // ------------------------------------------------- estados pegados

  // ¿Hay una conexión WebRTC con vida? Sin pc (timbre entrante,
  // permiso pendiente) o con el pc cerrado/fallido, NO.
  _pcViva() {
    if (!this.pc) return false;
    const st = this.pc.connectionState;
    return st !== 'closed' && st !== 'failed';
  }

  // ¿Puedo forzar una llamada saliente sobre el estado actual? La
  // regla: sin pc viva, o estado más viejo que ESTADO_PEGADO_MS.
  // Matiz deliberado: una `conectada` con pc viva es una llamada
  // REAL en curso y nunca se sacrifica, lleve lo que lleve.
  _puedoForzarSalida() {
    if (this.state === 'idle') return true;
    if (this.state === 'conectada' && this._pcViva()) return false;
    return !this._pcViva() || (this._now() - this._stateSince > ESTADO_PEGADO_MS);
  }

  // ¿La "llamada" que ocupa la sesión está muerta para una offer
  // nueva? Un timbre entrante que ya superó su propio plazo (su
  // timer pudo no correr: en móvil los timers de una pestaña en
  // segundo plano se estrangulan) o un estado sin pc viva igual de
  // viejo. Con pc viva y fresco, es un ocupado REAL.
  _ocupacionMuerta() {
    if (this.state === 'idle') return true;
    const edad = this._now() - this._stateSince;
    if (this.state === 'entrante') return edad >= RING_IN_TIMEOUT_MS;
    return !this._pcViva() && edad >= RING_IN_TIMEOUT_MS;
  }

  // Suelta el estado actual avisando al par por el camino que
  // corresponda, y termina por el reset único. Compartido por el
  // forzado saliente y por el anti-falso-ocupado entrante.
  _liberarPegada() {
    const cur = this.current;
    if (!cur) { this._reset(); return; }
    if (this.state === 'entrante') {
      // Estaba sonando (o su fantasma): el llamante recibe el
      // ocupado que le corresponde y queda como perdida local.
      this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'reject', media: cur.media, motivo: 'ocupado' }));
      this._terminar('perdida');
      return;
    }
    // El resultado depende de hasta dónde llegó la llamada; el
    // aviso `end` es el mismo en los tres casos (_cortar).
    const resultado = (this.state === 'conectada' || this._connectedAt) ? 'completada'
      : cur.dir === 'saliente' ? 'sin-respuesta' : 'sin-conexion';
    this._cortar(cur, resultado);
  }

  // ------------------------------------------------- watchdogs

  // `conectando` con plazo: si el medio no conecta a tiempo, fuera.
  _armConnectTimer(cur) {
    this._armTimer('_connectTimer', CONNECT_TIMEOUT_MS, () => {
      if (this.current === cur && this.state === 'conectando') {
        this._cortar(cur, 'sin-conexion');
      }
    });
  }

  // ICE `disconnected` sostenido: en datos móviles puede quedarse
  // ahí para siempre sin llegar a `failed`; tras la gracia se corta
  // como sin-conexion. Se arma una sola vez por episodio (la gracia
  // corre desde el PRIMER disconnected, no se renueva).
  _armIceWatchdog(cur) {
    if (this._iceWatchdog != null) return;
    this._armTimer('_iceWatchdog', ICE_DISCONNECTED_GRACE_MS, () => {
      if (!this._vigente(cur)) return;
      const sigueCortado = this.pc.iceConnectionState === 'disconnected'
        || this.pc.connectionState === 'disconnected';
      if (!sigueCortado) return; // se recuperó sin avisar: nada que cortar
      this._cortar(cur, 'sin-conexion');
    });
  }

  // ------------------------------------------------- muestreo de relevo (v1.10.0)

  // Mientras la llamada está conectada, cada MUESTREO_RELEVO_MS se
  // mira el par de candidatos seleccionado: si es `relay`, el
  // tiempo desde la muestra anterior se reporta como evento
  // 'relevo' (la app lo descuenta del presupuesto mensual de la
  // persona; ver tiempollamadas.js). Sin getStats (RTC falso de
  // tests viejos) el muestreo se apaga en silencio. El delta se
  // capa a 2 intervalos: si el teléfono durmió, no se inventa
  // tiempo que no se vivió despierto.
  _iniciarMuestreo(cur) {
    this._ultimaMuestra = this._now();
    this._armTimer('_statsTimer', MUESTREO_RELEVO_MS, () => { void this._muestrear(cur); });
  }

  async _muestrear(cur) {
    if (!this._vigente(cur) || this.state !== 'conectada') return;
    const ahora = this._now();
    const delta = ahora - this._ultimaMuestra;
    this._ultimaMuestra = ahora;
    if (typeof this.pc.getStats === 'function' && delta > 0) {
      let tipo = null;
      try { tipo = tipoDelParSeleccionado(await this.pc.getStats()); } catch {}
      if (this.current === cur && tipo === 'relay') {
        this._emit({
          tipo: 'relevo', peer: cur.peer, media: cur.media, id: cur.id,
          deltaMs: Math.min(delta, MUESTREO_RELEVO_MS * 2),
        });
      }
    }
    if (this.current === cur && this.state === 'conectada') {
      this._armTimer('_statsTimer', MUESTREO_RELEVO_MS, () => { void this._muestrear(cur); });
    }
  }

  // Corte por presupuesto de relevo agotado: lo invoca la app tras
  // la gracia (el aviso y los textos los pone ella). Avisa al par
  // con un `end` normal: para el otro lado es un cierre cordial.
  terminarPorLimite() {
    const cur = this.current;
    if (!cur || this.state === 'idle') return;
    this._cortar(cur, 'limite');
  }

  // ------------------------------------------------- restart de ICE

  // Pide la configuración ICE de nuevo y la aplica al pc en curso
  // con setConfiguration. El proveedor (turnmd) solo renueva las
  // credenciales de Metered si su caché pasó de 6 h; con la
  // caché joven reutiliza las que hay. Si el pc no soporta
  // setConfiguration, se sigue con la config de nacimiento.
  async _refrescarConfigPc(cur) {
    if (!this._vigente(cur)) return;
    const iceServers = await this._pedirIceServers();
    if (!this._vigente(cur)) return;
    if (typeof this.pc.setConfiguration === 'function') {
      try { this.pc.setConfiguration({ iceServers }); } catch {}
    }
  }

  // ICE llegó a `failed`. En `conectando` hay UNA segunda
  // oportunidad: renegociar con restart de ICE (credenciales nuevas,
  // candidatos nuevos — a menudo el primer intento muere por una
  // ruta que el segundo, vía TURN, sí encuentra). Si el segundo
  // intento también falla, o si ya estábamos `conectada`, manda el
  // corte de siempre. Los dos handlers (connectionState e
  // iceConnectionState) pueden avisar del MISMO fallo: el restart
  // en curso actúa de cerrojo para no contarlo dos veces.
  _onIceFailed(cur) {
    if (!this.current || this.current.id !== cur.id) return;
    if (cur.restartEnCurso) return; // este fallo ya se está atendiendo
    if (this.state === 'conectando' && !cur.restartUsado) {
      cur.restartUsado = true;
      void this._reiniciarIce(cur);
      return;
    }
    // Ni directo ni con el TURN de respaldo (o segundo fallo, o la
    // llamada ya estaba conectada): las redes no dejaron pasar.
    this._cortar(cur, 'sin-conexion');
  }

  // Lado que detecta el fallo: se convierte en oferente de la
  // renegociación (sea cual sea su rol original) y manda una offer
  // NUEVA con el MISMO callId y restart:true. La respuesta llega
  // por el camino normal de `answer`.
  async _reiniciarIce(cur) {
    cur.restartEnCurso = true;
    try {
      if (!this._vigente(cur)) return;
      await this._refrescarConfigPc(cur); // config ICE fresca antes de renegociar
      if (!this._vigente(cur)) return;
      const offer = await this.pc.createOffer({ iceRestart: true });
      if (!this._vigente(cur)) return;
      await this.pc.setLocalDescription(offer);
      if (this.current !== cur) return;
      this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'offer', media: cur.media, sdp: offer.sdp, restart: true }));
    } catch {
      if (this.current === cur) this._cortar(cur, 'sin-conexion');
    } finally {
      cur.restartEnCurso = false;
    }
  }

  // Lado que recibe la offer de restart de la llamada en curso: la
  // responde como answerer de esta ronda. NO es una llamada nueva:
  // no suena, no pasa por los candados; es la misma conversación.
  async _responderRestart(cur, payload) {
    cur.restartEnCurso = true;
    try {
      if (!this._vigente(cur)) return;
      await this._refrescarConfigPc(cur); // también reúne candidatos con config fresca
      if (!this._vigente(cur)) return;
      await this.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      if (!this._vigente(cur)) return;
      await this._flushIce();
      const answer = await this.pc.createAnswer();
      if (!this._vigente(cur)) return;
      await this.pc.setLocalDescription(answer);
      if (this.current !== cur) return;
      this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'answer', media: cur.media, sdp: answer.sdp }));
    } catch {
      if (this.current === cur) this._cortar(cur, 'sin-conexion');
    } finally {
      cur.restartEnCurso = false;
    }
  }

  _wirePC(pc, cur) {
    pc.onicecandidate = (e) => {
      if (!e || !e.candidate) return;
      const cand = typeof e.candidate.toJSON === 'function' ? e.candidate.toJSON() : e.candidate;
      this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'ice', media: cur.media, candidate: cand }));
    };
    pc.ontrack = (e) => {
      let stream = (e.streams && e.streams[0]) || null;
      // Blindaje: si una pista llega sin stream asociado (pasa en
      // algunos WebView), sin esto remoteStream quedaba null y la
      // llamada "conectaba" muda. Se arma un stream con la pista.
      if (!stream && e.track && typeof MediaStream === 'function') {
        stream = this.remoteStream || new MediaStream();
        try { stream.addTrack(e.track); } catch {}
      }
      if (stream && stream !== this.remoteStream) {
        this.remoteStream = stream;
        this._emit({ tipo: 'stream-remoto', stream });
      }
    };
    pc.onconnectionstatechange = () => {
      if (!this.current || this.current.id !== cur.id) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        if (this.state !== 'conectada') {
          this._setState('conectada');
          this._connectedAt = this._now();
          this._disarmRingTimer();
          this._disarmConnectTimer();
          this._disarmIceWatchdog();
          this._emit({ tipo: 'conectada', peer: cur.peer, media: cur.media, id: cur.id });
          this._iniciarMuestreo(cur); // presupuesto de relevo (v1.10.0)
        }
      } else if (st === 'failed') {
        this._onIceFailed(cur);
      } else if (st === 'disconnected') {
        this._armIceWatchdog(cur);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (!this.current || this.current.id !== cur.id) return;
      const st = pc.iceConnectionState;
      if (st === 'disconnected') {
        this._armIceWatchdog(cur);
      } else if (st === 'connected' || st === 'completed') {
        this._disarmIceWatchdog();
      } else if (st === 'failed') {
        // Hay navegadores que solo mueven el estado ICE.
        this._onIceFailed(cur);
      }
    };
  }

  async _flushIce() {
    const q = this._iceQueue;
    this._iceQueue = [];
    for (const cand of q) {
      try { await this.pc.addIceCandidate(cand); } catch {}
    }
  }

  async _addIce(candidate) {
    // Sin pc todavía (suena el timbre y el pc nace al aceptar): el
    // candidato se ENCOLA, no se pierde — se aplica tras
    // setRemoteDescription vía _flushIce. Perderlo aquí era perder
    // justo los primeros candidatos del llamante.
    if (!this.pc || !this.pc.remoteDescription) { this._iceQueue.push(candidate); return; }
    try { await this.pc.addIceCandidate(candidate); } catch {}
  }

  // ---- lado que llama ----
  async llamar(peer, media) {
    if (!peer || !CALL_MEDIAS.includes(media)) return false;
    if (this.state !== 'idle') {
      // Un fantasma no bloquea al propio usuario: si el estado está
      // pegado (sin pc viva o demasiado viejo), se libera por el
      // camino único y la llamada procede. Con una llamada viva de
      // verdad, no se toca nada.
      if (!this._puedoForzarSalida()) return false;
      this._liberarPegada();
    }
    const cur = { id: newCallId(this._rng), peer, media, dir: 'saliente' };
    this.current = cur;
    this._setState('saliendo');
    let stream;
    try {
      stream = await this._getLocalStream(media);
    } catch (err) {
      if (this.current !== cur) return false; // abortada mientras pedía el medio
      this._reset();
      this._emit({
        tipo: 'terminada', peer, media, id: cur.id, durSeg: 0, resultado: 'error',
        mensaje: mensajeErrorMedios(err, media),
      });
      return false;
    }
    if (this.current !== cur) { // abortada mientras pedía el medio
      this._pararPistas(stream);
      return false;
    }
    this.localStream = stream;
    this._emit({ tipo: 'stream-local', stream });
    // Config ICE vigente (Metered fresco si lo hay) ANTES de
    // crear el pc: la fábrica la recibe y construye con ella.
    const iceServers = await this._pedirIceServers();
    if (this.current !== cur) { // abortada mientras pedía la config
      this._pararPistas(stream);
      return false;
    }
    let pc;
    try { pc = this._createPC(iceServers); } catch { pc = null; }
    if (!pc) {
      this._reset();
      this._emit({
        tipo: 'terminada', peer, media, id: cur.id, durSeg: 0, resultado: 'error',
        mensaje: 'Este navegador no soporta llamadas (WebRTC no disponible).',
      });
      return false;
    }
    this.pc = pc;
    this._wirePC(pc, cur);
    try {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._sendSafe(peer, buildCallPayload({ id: cur.id, op: 'offer', media, sdp: offer.sdp }));
    } catch {
      this._cortar(cur, 'sin-conexion');
      return false;
    }
    this._emit({ tipo: 'saliente', peer, media, id: cur.id });
    this._armRingTimer(RING_TIMEOUT_MS, () => {
      if (this.current === cur && this.state === 'saliendo') {
        this._cortar(cur, 'sin-respuesta');
      }
    });
    return true;
  }

  // ---- entrada de señalización ----
  async recibir(peer, payload) {
    if (!payload || !peer) return;
    const { op } = payload;

    if (op === 'offer') {
      // Reentregas de los relays: la MISMA offer puede llegar por
      // varios relays, o resucitar de un almacén al reconectar. Una
      // copia de la llamada en curso NO es "segunda llamada" (nada
      // de reject ocupado) y una ya cerrada no vuelve a sonar.
      if (this.current && payload.id === this.current.id) {
        // Excepción: una offer con restart:true del mismo id y del
        // mismo par, estando `conectando`, es la renegociación con
        // restart de ICE de ESTA llamada — se responde, no suena.
        if (payload.restart === true && peer === this.current.peer && this.state === 'conectando') {
          await this._responderRestart(this.current, payload);
        }
        return;
      }
      if (this._idCerrado(payload.id)) return;
      if (this.state !== 'idle') {
        // Anti-falso-ocupado: antes de rechazar, mirar si la
        // "llamada" que ocupa la sesión está muerta (timbre ya
        // caducado con el timer estrangulado en segundo plano, o
        // estado sin pc viva igual de viejo). Si lo está, se libera
        // y la offer nueva se atiende como corresponde; si la
        // llamada actual es real, ocupado y punto.
        if (!this._ocupacionMuerta()) {
          this._sendSafe(peer, buildCallPayload({ id: payload.id, op: 'reject', media: payload.media, motivo: 'ocupado' }));
          return;
        }
        this._liberarPegada();
        if (this.state !== 'idle') return; // no se pudo liberar: no suena
      }
      const cur = { id: payload.id, peer, media: payload.media, dir: 'entrante', sdp: payload.sdp };
      this.current = cur;
      this._setState('entrante');
      // ICE que llegó ANTES que esta offer: a la cola de la sesión,
      // se aplica tras setRemoteDescription al aceptar.
      const huerfano = this._iceHuerfano.get(payload.id);
      if (huerfano) {
        this._iceHuerfano.delete(payload.id);
        if (huerfano.peer === peer) this._iceQueue.push(...huerfano.candidates);
      }
      this._emit({ tipo: 'entrante', peer, media: cur.media, id: cur.id });
      this._armRingTimer(RING_IN_TIMEOUT_MS, () => {
        if (this.current === cur && this.state === 'entrante') this._terminar('perdida');
      });
      return;
    }

    const cur = this.current;
    if (!cur || payload.id !== cur.id || peer !== cur.peer) {
      // Señales terminales de un callId AÚN desconocido: llegaron
      // ANTES que su offer (los relays no garantizan orden). Se
      // memorizan como cerradas — si la offer aparece después,
      // nace muerta y no suena (ver el chequeo _idCerrado arriba).
      if (op === 'end' || op === 'reject') { this._recordarId(payload.id); return; }
      // ICE sin sesión todavía (llegó antes que la offer o durante
      // un hueco entre relays): se buferiza por callId con TTL y se
      // aplica cuando la offer cree la sesión. El resto de ops sin
      // sesión no significan nada y se descartan.
      if (op === 'ice' && this.state === 'idle') this._buferizarIce(peer, payload);
      return;
    }

    if (op === 'answer') {
      if (this.state !== 'saliendo' && this.state !== 'conectando') return;
      this._disarmRingTimer(); // ya respondió: el timbre no aplica
      this._setState('conectando');
      this._armConnectTimer(cur); // …pero conectar sí tiene plazo
      try {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        await this._flushIce();
      } catch { /* ICE/ontrack decidirán el destino de la llamada */ }
      return;
    }

    if (op === 'ice') {
      await this._addIce(payload.candidate);
      return;
    }

    if (op === 'reject') {
      // Un reject del par cierra mi llamada saliente en cualquier
      // estado previo a conectar (saliendo o ya conectando).
      if (cur.dir === 'saliente' && (this.state === 'saliendo' || this.state === 'conectando')) {
        this._terminar(payload.motivo === 'ocupado' ? 'ocupado' : 'rechazada');
      }
      return;
    }

    if (op === 'end') {
      if (this.state === 'entrante') { this._terminar('perdida'); return; }
      if (this._connectedAt) { this._terminar('completada'); return; }
      // Colgó antes de conectar: para el que llamaba es un rechazo;
      // para el que recibía (ya aceptó, conectando) fue un intento.
      this._terminar(cur.dir === 'saliente' ? 'rechazada' : 'sin-respuesta');
    }
  }

  // ---- lado que recibe ----
  async aceptar() {
    const cur = this.current;
    if (!cur || this.state !== 'entrante') return false;
    this._disarmRingTimer();
    let stream;
    try {
      stream = await this._getLocalStream(cur.media);
    } catch (err) {
      if (this.current !== cur) return false; // abortada mientras pedía el medio
      this._cortar(cur, 'error', mensajeErrorMedios(err, cur.media));
      return false;
    }
    if (this.current !== cur) {
      this._pararPistas(stream);
      return false;
    }
    this.localStream = stream;
    this._emit({ tipo: 'stream-local', stream });
    // Igual que al llamar: config ICE vigente antes de crear el pc.
    const iceServers = await this._pedirIceServers();
    if (this.current !== cur) { // abortada mientras pedía la config
      this._pararPistas(stream);
      return false;
    }
    let pc;
    try { pc = this._createPC(iceServers); } catch { pc = null; }
    if (!pc) {
      this._cortar(cur, 'error', 'Este navegador no soporta llamadas (WebRTC no disponible).');
      return false;
    }
    this.pc = pc;
    this._wirePC(pc, cur);
    this._setState('conectando');
    this._armConnectTimer(cur); // aceptar no es conectar: hay plazo
    try {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      await pc.setRemoteDescription({ type: 'offer', sdp: cur.sdp });
      await this._flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'answer', media: cur.media, sdp: answer.sdp }));
    } catch {
      this._cortar(cur, 'sin-conexion');
      return false;
    }
    return true;
  }

  rechazar() {
    const cur = this.current;
    if (!cur || this.state !== 'entrante') return;
    this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'reject', media: cur.media }));
    this._terminar('perdida');
  }

  // Cuelga en cualquier estado activo.
  colgar() {
    const cur = this.current;
    if (!cur || this.state === 'idle') return;
    // El aviso `end` es el mismo; solo cambia el resultado según
    // hasta dónde llegó la llamada (_cortar).
    const resultado = (this.state === 'conectada' || this._connectedAt) ? 'completada'
      : this.state === 'entrante' ? 'perdida'
      : cur.dir === 'saliente' ? 'sin-respuesta' : 'completada';
    this._cortar(cur, resultado);
  }

  // Silencia/activa el micrófono local. Devuelve el estado resultante.
  toggleMute() {
    this.muted = !this.muted;
    if (this.localStream) {
      try {
        for (const t of this.localStream.getAudioTracks()) t.enabled = !this.muted;
      } catch {}
    }
    return this.muted;
  }
}
