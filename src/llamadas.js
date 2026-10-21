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
// Este módulo es puro (sin DOM): la máquina de estados recibe el
// transporte (send), la fábrica de RTCPeerConnection y getUserMedia
// inyectados, para probarla en Node con falsos.

export const KIND_CALL = 21004; // efímero: señalización de llamada
export const CALL_V = 1;
export const MIN_MSGS_VIDEO = 10;
export const RING_TIMEOUT_MS = 45000;       // timbre saliente: 45 s
export const RING_IN_TIMEOUT_MS = 60000;    // timbre entrante: 60 s

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
export const TURN_URLS = [
  'turn:openrelay.metered.ca:80',
  'turn:openrelay.metered.ca:80?transport=tcp',
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
// Solo incluye los campos opcionales cuando son válidos.
export function buildCallPayload({ id, op, media, sdp, candidate, motivo } = {}) {
  const p = { t: 'call', v: CALL_V, id, op, media };
  if (sdpOk(sdp)) p.sdp = sdp;
  if (candOk(candidate)) p.candidate = candidate;
  if (CALL_MOTIVOS.includes(motivo)) p.motivo = motivo;
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
//   {tipo:'terminada', peer, media, id, durSeg, resultado, mensaje?}
// resultado: 'completada' | 'perdida' | 'sin-respuesta' | 'rechazada'
//          | 'ocupado' | 'sin-conexion' | 'error'
export class CallSession {
  constructor({ send, createPC, getLocalStream, onEvent, setTimeoutFn, clearTimeoutFn, nowFn, rng } = {}) {
    if (typeof send !== 'function') throw new Error('CallSession: falta send');
    if (typeof createPC !== 'function') throw new Error('CallSession: falta createPC');
    if (typeof getLocalStream !== 'function') throw new Error('CallSession: falta getLocalStream');
    this._send = send;
    this._createPC = createPC;
    this._getLocalStream = getLocalStream;
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
    this._ringTimer = null;
    this._iceQueue = [];
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

  _emit(e) { try { this._onEvent(e); } catch {} }

  _sendSafe(peer, payload) {
    try {
      const r = this._send(peer, payload);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {}
  }

  _armRingTimer(ms, fn) {
    this._disarmRingTimer();
    this._ringTimer = this._setT(() => { this._ringTimer = null; fn(); }, ms);
  }

  _disarmRingTimer() {
    if (this._ringTimer != null) { try { this._clearT(this._ringTimer); } catch {} this._ringTimer = null; }
  }

  // Cierre local SIN avisar ni emitir (logout, cambio de cuenta).
  abortar() {
    if (this.current) this._recordarId(this.current.id);
    this._teardown();
    this.state = 'idle';
    this.current = null;
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

  _teardown() {
    this._disarmRingTimer();
    this._iceQueue = [];
    this._connectedAt = 0;
    this.muted = false;
    if (this.localStream) {
      try { for (const t of this.localStream.getTracks()) t.stop(); } catch {}
      this.localStream = null;
    }
    this.remoteStream = null;
    if (this.pc) {
      try { this.pc.onicecandidate = null; this.pc.ontrack = null; this.pc.onconnectionstatechange = null; } catch {}
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
  }

  // Termina la llamada actual emitiendo 'terminada'.
  _terminar(resultado, mensaje) {
    const cur = this.current;
    const durSeg = this.duracionSeg();
    if (cur) this._recordarId(cur.id);
    this._teardown();
    this.state = 'idle';
    this.current = null;
    if (cur) {
      this._emit({
        tipo: 'terminada', peer: cur.peer, media: cur.media, id: cur.id,
        durSeg, resultado, ...(mensaje ? { mensaje } : {}),
      });
    }
  }

  _wirePC(pc, cur) {
    pc.onicecandidate = (e) => {
      if (!e || !e.candidate) return;
      const cand = typeof e.candidate.toJSON === 'function' ? e.candidate.toJSON() : e.candidate;
      this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'ice', media: cur.media, candidate: cand }));
    };
    pc.ontrack = (e) => {
      const stream = (e.streams && e.streams[0]) || null;
      if (stream) {
        this.remoteStream = stream;
        this._emit({ tipo: 'stream-remoto', stream });
      }
    };
    pc.onconnectionstatechange = () => {
      if (!this.current || this.current.id !== cur.id) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        if (this.state !== 'conectada') {
          this.state = 'conectada';
          this._connectedAt = this._now();
          this._disarmRingTimer();
          this._emit({ tipo: 'conectada', peer: cur.peer, media: cur.media, id: cur.id });
        }
      } else if (st === 'failed') {
        // Ni directo ni con el TURN de respaldo: las redes no
        // dejaron pasar el medio.
        this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'end', media: cur.media }));
        this._terminar('sin-conexion');
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
    if (this.state !== 'idle' || !peer || !CALL_MEDIAS.includes(media)) return false;
    const cur = { id: newCallId(this._rng), peer, media, dir: 'saliente' };
    this.current = cur;
    this.state = 'saliendo';
    let stream;
    try {
      stream = await this._getLocalStream(media);
    } catch {
      if (this.current !== cur) return false; // abortada mientras pedía el medio
      this.current = null; this.state = 'idle';
      this._emit({
        tipo: 'terminada', peer, media, id: cur.id, durSeg: 0, resultado: 'error',
        mensaje: media === 'video'
          ? 'Permiso de cámara o micrófono denegado. Revisa los permisos del navegador.'
          : 'Permiso de micrófono denegado. Revisa los permisos del navegador.',
      });
      return false;
    }
    if (this.current !== cur) { // abortada mientras pedía el medio
      try { for (const t of stream.getTracks()) t.stop(); } catch {}
      return false;
    }
    this.localStream = stream;
    this._emit({ tipo: 'stream-local', stream });
    let pc;
    try { pc = this._createPC(); } catch { pc = null; }
    if (!pc) {
      this._teardown(); this.current = null; this.state = 'idle';
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
      this._sendSafe(peer, buildCallPayload({ id: cur.id, op: 'end', media }));
      this._terminar('sin-conexion');
      return false;
    }
    this._emit({ tipo: 'saliente', peer, media, id: cur.id });
    this._armRingTimer(RING_TIMEOUT_MS, () => {
      if (this.current === cur && this.state === 'saliendo') {
        this._sendSafe(peer, buildCallPayload({ id: cur.id, op: 'end', media }));
        this._terminar('sin-respuesta');
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
      if (this.current && payload.id === this.current.id) return;
      if (this._idCerrado(payload.id)) return;
      if (this.state !== 'idle') {
        // Segunda llamada estando en una: ocupado, sin sonar.
        this._sendSafe(peer, buildCallPayload({ id: payload.id, op: 'reject', media: payload.media, motivo: 'ocupado' }));
        return;
      }
      const cur = { id: payload.id, peer, media: payload.media, dir: 'entrante', sdp: payload.sdp };
      this.current = cur;
      this.state = 'entrante';
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
      this.state = 'conectando';
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
      if (this.state === 'saliendo') {
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
    } catch {
      if (this.current !== cur) return false; // abortada mientras pedía el medio
      this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'end', media: cur.media }));
      this._terminar('error',
        cur.media === 'video'
          ? 'Permiso de cámara o micrófono denegado. Revisa los permisos del navegador.'
          : 'Permiso de micrófono denegado. Revisa los permisos del navegador.');
      return false;
    }
    if (this.current !== cur) {
      try { for (const t of stream.getTracks()) t.stop(); } catch {}
      return false;
    }
    this.localStream = stream;
    this._emit({ tipo: 'stream-local', stream });
    let pc;
    try { pc = this._createPC(); } catch { pc = null; }
    if (!pc) {
      this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'end', media: cur.media }));
      this._terminar('error', 'Este navegador no soporta llamadas (WebRTC no disponible).');
      return false;
    }
    this.pc = pc;
    this._wirePC(pc, cur);
    this.state = 'conectando';
    try {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      await pc.setRemoteDescription({ type: 'offer', sdp: cur.sdp });
      await this._flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'answer', media: cur.media, sdp: answer.sdp }));
    } catch {
      this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'end', media: cur.media }));
      this._terminar('sin-conexion');
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
    this._sendSafe(cur.peer, buildCallPayload({ id: cur.id, op: 'end', media: cur.media }));
    if (this.state === 'conectada' || this._connectedAt) this._terminar('completada');
    else if (this.state === 'entrante') this._terminar('perdida');
    else if (cur.dir === 'saliente') this._terminar('sin-respuesta');
    else this._terminar('completada');
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
