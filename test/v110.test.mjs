// v1.10.0: límite de llamadas por relevo (20 min/mes), landing con
// héroe compacto y pestaña 🔔 de sugerencias.
// - tiempollamadas.js (puro): cubeta mensual, restantes, corte y
//   lectura del par seleccionado de las estadísticas WebRTC.
// - CallSession: muestreo de relevo en llamada conectada (solo
//   `relay` descuenta) y terminarPorLimite().
// - Smoke jsdom: landing sin sesión (características + botones sin
//   scroll), arranque con sesión directo a la app (sin asistente ni
//   tarjeta), insignia 🔔, sugerencias que saltan al paso correcto
//   y contabilidad del relevo en la app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  LIMITE_RELEVO_MS, GRACIA_LIMITE_MS, MUESTREO_RELEVO_MS,
  mesClave, usoEnMes, conUso, restanteMs, agotado, minutosRestantes, textoRestante,
  tipoDelParSeleccionado, TEXTO_LIMITE_EXPL, TEXTO_LIMITE_AVISO, TEXTO_LIMITE_CORTE,
} from '../src/tiempollamadas.js';
import { CallSession, parseCallPayload } from '../src/llamadas.js';
import { newProfile, completitud, camposFaltantes } from '../src/perfil.js';

const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OCT15 = new Date(2026, 9, 15, 12, 0, 0).getTime(); // 2026-10 local
const NOV01 = new Date(2026, 10, 1, 0, 30, 0).getTime(); // 2026-11 local

// ------------------------------------------------------------ cubeta mensual

test('límite: constantes — 20 min/mes y gracia de 15 s', () => {
  assert.equal(LIMITE_RELEVO_MS, 20 * 60 * 1000);
  assert.equal(GRACIA_LIMITE_MS, 15000);
});

test('cubeta: mesClave en formato AAAA-MM (hora local)', () => {
  assert.equal(mesClave(OCT15), '2026-10');
  assert.equal(mesClave(new Date(2026, 9, 31, 23, 59).getTime()), '2026-10');
  assert.equal(mesClave(NOV01), '2026-11');
});

test('cubeta: sin registro o de otro mes, el uso es cero (reinicio solo)', () => {
  assert.equal(usoEnMes(null, OCT15), 0);
  assert.equal(usoEnMes(undefined, OCT15), 0);
  assert.equal(usoEnMes({ mes: '2026-09', ms: 999999 }, OCT15), 0);
  assert.equal(usoEnMes({ mes: '2026-10', ms: 12345 }, OCT15), 12345);
  assert.equal(usoEnMes({ mes: 'basura' }, OCT15), 0);
});

test('cubeta: conUso suma dentro del mes y nace de cero al cambiar', () => {
  let reg = conUso(null, 60000, OCT15);
  assert.deepEqual(reg, { mes: '2026-10', ms: 60000 });
  reg = conUso(reg, 30000, OCT15);
  assert.deepEqual(reg, { mes: '2026-10', ms: 90000 });
  reg = conUso(reg, 45000, NOV01); // cambió el mes: lo viejo no cuenta
  assert.deepEqual(reg, { mes: '2026-11', ms: 45000 });
  assert.deepEqual(conUso(reg, -5, NOV01), reg, 'deltas negativos no restan');
});

test('cubeta: restante y agotado en el borde exacto del límite', () => {
  const casi = { mes: '2026-10', ms: LIMITE_RELEVO_MS - 1 };
  assert.equal(restanteMs(casi, OCT15), 1);
  assert.equal(agotado(casi, OCT15), false);
  const justo = { mes: '2026-10', ms: LIMITE_RELEVO_MS };
  assert.equal(restanteMs(justo, OCT15), 0);
  assert.equal(agotado(justo, OCT15), true);
  const pasado = { mes: '2026-10', ms: LIMITE_RELEVO_MS * 3 };
  assert.equal(restanteMs(pasado, OCT15), 0, 'nunca negativo');
  assert.equal(agotado({ mes: '2026-09', ms: LIMITE_RELEVO_MS * 3 }, OCT15), false, 'otro mes = presupuesto nuevo');
});

test('cubeta: textoRestante — minutos hacia arriba y frase exacta', () => {
  assert.equal(textoRestante(null, OCT15), 'Te quedan 20 min de llamadas este mes');
  assert.equal(minutosRestantes({ mes: '2026-10', ms: 10 * 60000 + 30000 }, OCT15), 10);
  assert.equal(textoRestante({ mes: '2026-10', ms: 10 * 60000 + 30000 }, OCT15), 'Te quedan 10 min de llamadas este mes');
  assert.equal(textoRestante({ mes: '2026-10', ms: LIMITE_RELEVO_MS - 30000 }, OCT15), 'Te quedan 1 min de llamadas este mes');
  assert.equal(textoRestante({ mes: '2026-10', ms: LIMITE_RELEVO_MS }, OCT15), 'Ya no te quedan minutos de llamadas este mes');
});

test('textos del límite: lenguaje simple, sin jerga técnica', () => {
  for (const t of [TEXTO_LIMITE_EXPL, TEXTO_LIMITE_AVISO, TEXTO_LIMITE_CORTE]) {
    assert.ok(!/TURN|CGNAT|\bICE\b|STUN/.test(t), 'sin jerga: ' + t);
  }
  assert.match(TEXTO_LIMITE_EXPL, /20 minutos de voz/);
  assert.match(TEXTO_LIMITE_EXPL, /5 minutos de videollamadas/);
  assert.match(TEXTO_LIMITE_EXPL, /se renueva el día 1/);
  assert.match(TEXTO_LIMITE_EXPL, /WiFi/);
  assert.match(TEXTO_LIMITE_CORTE, /se renuevan el día 1/);
});

// ------------------------------------------------------------ par seleccionado

const LC = (id, tipo) => ({ type: 'local-candidate', id, candidateType: tipo });
const RC = (id, tipo) => ({ type: 'remote-candidate', id, candidateType: tipo });
const PAR = (local, extra = {}) => ({ type: 'candidate-pair', id: 'cp', state: 'succeeded', localCandidateId: local, remoteCandidateId: 'rc1', ...extra });

test('stats: el tipo sale del candidato local del par seleccionado', () => {
  assert.equal(tipoDelParSeleccionado([LC('a', 'relay'), LC('b', 'host'), RC('rc1', 'srflx'), PAR('a')]), 'relay');
  assert.equal(tipoDelParSeleccionado([LC('b', 'host'), RC('rc1', 'host'), PAR('b')]), 'host');
  assert.equal(tipoDelParSeleccionado([LC('c', 'srflx'), RC('rc1', 'srflx'), PAR('c')]), 'srflx');
});

test('stats: `selected` manda sobre otro par succeeded', () => {
  const stats = [
    LC('a', 'relay'), LC('b', 'host'), RC('rc1', 'host'),
    PAR('b'), // succeeded pero no seleccionado
    PAR('a', { selected: true }),
  ];
  assert.equal(tipoDelParSeleccionado(stats), 'relay');
});

test('stats: sin par utilizable o sin datos → null (no se descuenta a ciegas)', () => {
  assert.equal(tipoDelParSeleccionado(null), null);
  assert.equal(tipoDelParSeleccionado([]), null);
  assert.equal(tipoDelParSeleccionado([LC('a', 'relay')]), null);
  assert.equal(tipoDelParSeleccionado([LC('a', 'relay'), PAR('zz')]), null, 'candidato desconocido');
  assert.equal(tipoDelParSeleccionado([{ type: 'candidate-pair', state: 'failed', localCandidateId: 'a' }, LC('a', 'relay')]), null);
});

test('stats: acepta el reporte real de getStats (Map con forEach)', () => {
  const m = new Map();
  m.set('lc1', LC('lc1', 'relay'));
  m.set('cp1', PAR('lc1'));
  assert.equal(tipoDelParSeleccionado(m), 'relay');
});

// ------------------------------------------------------------ muestreo en CallSession

class FakeTrack {
  constructor(kind) { this.kind = kind; this.enabled = true; }
  stop() {}
}
class FakeStream {
  constructor(media) { this.tracks = [new FakeTrack('audio')]; if (media === 'video') this.tracks.push(new FakeTrack('video')); }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
}
const statsRelay = [LC('lr', 'relay'), RC('rc1', 'srflx'), PAR('lr')];
const statsHost = [LC('lh', 'host'), RC('rc1', 'host'), PAR('lh')];
class FakePC {
  constructor(stats) {
    this.connectionState = 'new'; this.iceConnectionState = 'new';
    this.stats = stats || statsHost;
    this.onicecandidate = null; this.ontrack = null;
    this.onconnectionstatechange = null; this.oniceconnectionstatechange = null;
  }
  addTrack() {}
  async createOffer() { return { type: 'offer', sdp: 'SDP-OFFER' }; }
  async createAnswer() { return { type: 'answer', sdp: 'SDP-ANSWER' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate() {}
  close() { this.closed = true; }
  async getStats() { return this.stats; }
  setConnState(st) { this.connectionState = st; if (this.onconnectionstatechange) this.onconnectionstatechange(); }
}
function fakeTimers() {
  let seq = 1; const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = seq++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    fire: (ms) => { for (const [id, t] of [...pending]) if (t.ms === ms) { pending.delete(id); t.fn(); } },
    count: () => pending.size,
  };
}
const ID = 'call-8888888888888888'; // rng () => 0.5
function mkSession(pc) {
  const sent = []; const eventos = []; const timers = fakeTimers();
  let reloj = 1000000;
  const ses = new CallSession({
    send: (peer, payload) => { sent.push({ peer, payload }); },
    createPC: () => pc,
    getLocalStream: async (media) => new FakeStream(media),
    onEvent: (e) => eventos.push(e),
    setTimeoutFn: timers.setTimeout, clearTimeoutFn: timers.clearTimeout,
    nowFn: () => reloj, rng: () => 0.5,
  });
  return { ses, sent, eventos, timers, avanzar: (ms) => { reloj += ms; } };
}
async function conectar(ses, pc) {
  assert.equal(await ses.llamar('peerPK', 'audio'), true);
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER' })));
  pc.setConnState('connected');
  assert.equal(ses.state, 'conectada');
}
const relevoEventos = (eventos) => eventos.filter((e) => e.tipo === 'relevo');

test('muestreo: par relay suma — un evento por intervalo con su delta', async () => {
  const pc = new FakePC(statsRelay);
  const { ses, eventos, timers, avanzar } = mkSession(pc);
  await conectar(ses, pc);
  avanzar(MUESTREO_RELEVO_MS); timers.fire(MUESTREO_RELEVO_MS); await tick(); await tick();
  let rel = relevoEventos(eventos);
  assert.equal(rel.length, 1);
  assert.equal(rel[0].deltaMs, MUESTREO_RELEVO_MS);
  assert.equal(rel[0].id, ID);
  avanzar(MUESTREO_RELEVO_MS); timers.fire(MUESTREO_RELEVO_MS); await tick(); await tick();
  rel = relevoEventos(eventos);
  assert.equal(rel.length, 2, 'cada intervalo por relevo descuenta');
  assert.equal(rel.reduce((a, e) => a + e.deltaMs, 0), 2 * MUESTREO_RELEVO_MS);
  ses.colgar();
});

test('muestreo: par directo (host) NO descuenta nunca', async () => {
  const pc = new FakePC(statsHost);
  const { ses, eventos, timers, avanzar } = mkSession(pc);
  await conectar(ses, pc);
  for (let i = 0; i < 3; i++) { avanzar(MUESTREO_RELEVO_MS); timers.fire(MUESTREO_RELEVO_MS); await tick(); await tick(); }
  assert.equal(relevoEventos(eventos).length, 0);
  ses.colgar();
});

test('muestreo: si la llamada pasa de relevo a directa, deja de descontar', async () => {
  const pc = new FakePC(statsRelay);
  const { ses, eventos, timers, avanzar } = mkSession(pc);
  await conectar(ses, pc);
  avanzar(MUESTREO_RELEVO_MS); timers.fire(MUESTREO_RELEVO_MS); await tick(); await tick();
  assert.equal(relevoEventos(eventos).length, 1);
  pc.stats = statsHost; // renegocia y conecta directo
  avanzar(MUESTREO_RELEVO_MS); timers.fire(MUESTREO_RELEVO_MS); await tick(); await tick();
  assert.equal(relevoEventos(eventos).length, 1, 'el tramo directo no sumó');
  ses.colgar();
});

test('muestreo: sin getStats en el pc no rompe ni emite (RTC antiguos/falsos)', async () => {
  const pc = new FakePC(statsRelay);
  pc.getStats = undefined;
  const { ses, eventos, timers, avanzar } = mkSession(pc);
  await conectar(ses, pc);
  avanzar(MUESTREO_RELEVO_MS); timers.fire(MUESTREO_RELEVO_MS); await tick(); await tick();
  assert.equal(relevoEventos(eventos).length, 0);
  assert.equal(ses.state, 'conectada');
  ses.colgar();
});

test('corte por límite: terminarPorLimite avisa al par y cierra como "limite"', async () => {
  const pc = new FakePC(statsRelay);
  const { ses, sent, eventos } = mkSession(pc);
  await conectar(ses, pc);
  ses.terminarPorLimite();
  assert.equal(ses.state, 'idle');
  assert.ok(sent.some((s) => s.payload.op === 'end'), 'el par recibe un end cordial');
  const fin = eventos.find((e) => e.tipo === 'terminada');
  assert.equal(fin.resultado, 'limite');
  ses.terminarPorLimite(); // sin llamada: no-op, no lanza
  assert.equal(ses.state, 'idle');
});

// ------------------------------------------------------------ smoke jsdom

// WebSocket falso tipo "relay perfecto": abre al instante, responde
// EOSE a cada REQ y OK a cada EVENT. Sin red real.
class RelayWS {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    queueMicrotask(() => { if (this.onopen) this.onopen(); });
  }
  send(text) {
    let msg; try { msg = JSON.parse(text); } catch { return; }
    if (msg[0] === 'REQ') {
      const subId = msg[1];
      queueMicrotask(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify(['EOSE', subId]) }); });
    } else if (msg[0] === 'EVENT' && msg[1] && msg[1].id) {
      const id = msg[1].id;
      queueMicrotask(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify(['OK', id, true, '']) }); });
    }
  }
  close() { this.readyState = 3; }
}

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.CSS = dom.window.CSS; // app.js lo usa (CSS.escape) al pintar relays
globalThis.WebSocket = RelayWS;

await import('../src/app.js');
await wait(200);
const T = window.__cubmatchApp._test;
assert.ok(T, 'hook _test expuesto');
const S = () => T.getS();

test('landing sin sesión: características primero y botones visibles antes que la explicación', () => {
  assert.equal(S().screen, 'inicio');
  const texto = document.body.textContent;
  for (const t of ['Perfiles de toda Cuba', 'Chat privado y cifrado', 'Llamadas de voz y video', 'Gratis y sin intermediarios']) {
    assert.ok(texto.includes(t), 'característica presente: ' + t);
  }
  const hero = document.querySelector('.hero-features');
  const btns = document.querySelector('.inicio-btns');
  const como = document.querySelector('.como-funciona');
  assert.ok(hero && btns && como, 'héroe, botones y explicación presentes');
  const DESPUES = 4; // Node.DOCUMENT_POSITION_FOLLOWING
  assert.ok(hero.compareDocumentPosition(btns) & DESPUES, 'las características van antes de los botones');
  assert.ok(btns.compareDocumentPosition(como) & DESPUES, 'los botones van antes del "¿Cómo funciona?" (sin scroll para actuar)');
  assert.ok(document.querySelector('[data-act="ir-registro"]'), 'botón Crear cuenta');
  assert.ok(document.querySelector('[data-act="ir-login"]'), 'botón Ya tengo cuenta');
  assert.ok(texto.includes('¿Cómo funciona?') && texto.includes('¿Qué es Nostr?'), 'la explicación sigue debajo, sin duplicar');
});

// Sesión de prueba para el arranque directo.
const skU = generateSecretKey();
const pkU = getPublicKey(skU);

test('con sesión se entra directo: sin landing, sin asistente y sin tarjeta', async () => {
  localStorage.setItem('cubmatch_sesion', JSON.stringify({ username: 'prueba110', nsec: nip19.nsecEncode(skU) }));
  window.__cubmatchApp.boot();
  await wait(600);
  assert.equal(S().screen, 'deck', 'entra a la app, no a la landing ni al asistente');
  assert.equal(S().perfilPublicado, false, 'sin perfil en la red (los relays falsos no devuelven ninguno)');
  assert.ok(document.querySelector('#deck-body'), 'el mazo se pintó');
  assert.equal(document.querySelector('#ob-paso'), null, 'el asistente NO se abrió solo');
  assert.ok(!document.body.textContent.includes('Completa tu perfil'), 'sin tarjeta ni banner de completar perfil');
  assert.equal(document.querySelector('.guia-card'), null);
  assert.equal(document.querySelector('.banner-warn'), null);
  // la regla del 70% sigue, pero en silencio: una sola línea discreta
  const linea = document.querySelector('.deck-aviso');
  assert.ok(linea, 'línea discreta presente con perfil incompleto');
  assert.match(linea.textContent, /aún no aparece en el matching/);
  assert.match(linea.textContent, /🔔/);
});

test('🔔: la insignia cuenta las sugerencias del perfil y la pestaña no lleva texto', () => {
  const tab = document.querySelector('[data-act="nav-avisos"]');
  assert.ok(tab, 'pestaña 🔔 presente en la navegación');
  assert.match(tab.textContent.trim(), /^🔔\d+$/, 'solo el símbolo y la insignia, sin texto');
  const esperadas = camposFaltantes(S().miPerfil).length;
  assert.ok(esperadas >= 25, 'el perfil vacío tiene muchas sugerencias: ' + esperadas);
  const badge = tab.querySelector('.tab-badge');
  assert.ok(badge, 'insignia visible');
  assert.equal(Number(badge.textContent), esperadas, 'la insignia = nº de campos faltantes');
});

test('🔔: la pantalla lista una sugerencia por campo y Completar salta al paso correcto', async () => {
  const faltan = camposFaltantes(S().miPerfil);
  document.querySelector('[data-act="nav-avisos"]').click();
  await wait(30);
  assert.equal(S().screen, 'avisos');
  const items = document.querySelectorAll('.guia-item');
  assert.equal(items.length, faltan.length, 'una fila por sugerencia');
  const primera = faltan[0];
  const btn = items[0].querySelector('[data-act="sug-ir"]');
  assert.ok(btn, 'botón Completar en la primera sugerencia');
  assert.equal(Number(btn.dataset.paso), primera.paso);
  btn.click();
  await wait(30);
  assert.equal(S().screen, 'onboarding', 'saltó al editor');
  assert.equal(S().obPaso, primera.paso, 'al paso correcto (' + primera.paso + ')');
  assert.match(document.querySelector('#ob-paso').textContent, new RegExp('Paso ' + primera.paso + ' de 8'));
});

function perfil50() {
  const p = newProfile();
  Object.assign(p, {
    apodo: 'Lía', edad: 24, genero: 'mujer', orientacion: 'hetero',
    provincia: 'La Habana', municipio: 'Playa',
    educacion: 'Universitario', profesion: 'Diseñadora', sector: 'Cultura',
    valores: ['familia'], intereses: ['música'],
  });
  return p;
}
function perfilCompleto() {
  const p = newProfile();
  Object.assign(p, {
    apodo: 'Ana', edad: 26, genero: 'mujer', orientacion: 'hetero',
    provincia: 'La Habana', municipio: 'Playa',
    estatura: 168, complexion: 'Promedio', ojos: 'Marrones', piel: 'Trigueña', cabello: 'Negro',
    educacion: 'Universitario', profesion: 'Enfermera', sector: 'Salud',
    fumador: 'No', bebedor: 'Ocasionalmente', deporte: 'Sí', religion: 'Ninguna',
    hijosTiene: 'No tengo', hijosQuiere: 'Tal vez', mascotas: 'Sí',
    valores: ['familia', 'humor'], intereses: ['música', 'playa'], tags: ['café'],
    bio: 'Hola, soy Ana.', tresPalabras: 'alegre, sincera, cubana', fotoURL: 'https://x.test/f.jpg',
    prompts: [{ q: 'Un domingo perfecto para mí es…', a: 'playa y dominó' }],
  });
  p.rasgos.apertura = 5;
  p.prefs = { edadMin: 24, edadMax: 40, generos: ['hombre'], distancia: 'cuba', relacion: ['romance'] };
  return p;
}

test('perfil al ~50%: ni asistente ni tarjeta en Descubrir; la 🔔 refleja lo que falta', () => {
  const p = perfil50();
  const pct = completitud(p);
  assert.ok(pct >= 40 && pct < 70, 'perfil a medias: ' + pct + '%');
  S().miPerfil = p;
  S().perfilPublicado = true;
  T.showDeck();
  assert.equal(S().screen, 'deck');
  assert.equal(document.querySelector('#ob-paso'), null, 'el asistente no se abre');
  assert.equal(document.querySelector('.guia-card'), null, 'sin tarjeta');
  assert.equal(document.querySelector('.banner-warn'), null, 'sin banner');
  const linea = document.querySelector('.deck-aviso');
  assert.ok(linea && linea.textContent.includes(pct + '%'), 'la línea discreta dice el %');
  const badge = document.querySelector('[data-act="nav-avisos"] .tab-badge');
  assert.equal(Number(badge.textContent), camposFaltantes(p).length, 'insignia actualizada tras cambiar el perfil');
});

test('perfil completo: sin línea en Descubrir, sin insignia y campana en estado completo', async () => {
  S().miPerfil = perfilCompleto();
  S().perfilPublicado = true;
  T.showDeck();
  assert.equal(document.querySelector('.deck-aviso'), null, 'sin línea discreta al estar completo');
  assert.equal(document.querySelector('[data-act="nav-avisos"] .tab-badge'), null, 'sin insignia');
  T.showAvisos();
  await wait(20);
  assert.ok(document.body.textContent.includes('Tu perfil está completo 🎉'));
  assert.equal(document.querySelectorAll('.guia-item').length, 0, 'sin lista de sugerencias');
});

test('relevo en la app: los eventos suman a la cubeta del mes y al agotarse avisa', async () => {
  localStorage.removeItem('cubmatch_uso_relevo:' + pkU);
  assert.equal(T.getUsoRelevo(), null);
  T.onCallEvent({ tipo: 'relevo', id: 'call-prueba-1', deltaMs: 5 * 60000 });
  let reg = T.getUsoRelevo();
  assert.equal(reg.ms, 5 * 60000);
  assert.equal(reg.mes, mesClave(Date.now()));
  T.onCallEvent({ tipo: 'relevo', id: 'call-prueba-1', deltaMs: 15 * 60000 });
  reg = T.getUsoRelevo();
  assert.equal(reg.ms, LIMITE_RELEVO_MS, 'cubeta llena: 20 minutos');
  await wait(30);
  assert.match(document.body.textContent, /Ya usaste tus 20 minutos de llamadas de este mes/, 'aviso de gracia visible');
  // Ajustes → Llamadas muestra el restante (cero) y la explicación sencilla
  T.showAjustes();
  assert.match(document.body.textContent, /Ya no te quedan minutos de llamadas de voz este mes/);
  assert.match(document.body.textContent, /Te quedan 5 min de videollamadas este mes/, 'la cubeta de video no se tocó al gastar la de voz');
  assert.ok(document.body.textContent.includes('servicio de relevo gratuito'), 'explicación del límite visible');
  // v1.12.1: el video descuenta de SU cubeta (5 min), sin tocar la de voz
  localStorage.removeItem('cubmatch_uso_relevo_video:' + pkU);
  assert.equal(T.getUsoRelevo('video'), null);
  T.onCallEvent({ tipo: 'relevo', id: 'call-prueba-video', media: 'video', deltaMs: 4 * 60000 });
  let regV = T.getUsoRelevo('video');
  assert.equal(regV.ms, 4 * 60000);
  assert.equal(T.getUsoRelevo('audio').ms, LIMITE_RELEVO_MS, 'la voz sigue en su saldo, no en el del video');
  T.onCallEvent({ tipo: 'relevo', id: 'call-prueba-video', media: 'video', deltaMs: 1 * 60000 });
  assert.equal(T.getUsoRelevo('video').ms, 5 * 60000, 'cubeta de video llena: 5 minutos');
  await wait(30);
  assert.match(document.body.textContent, /Ya usaste tus 5 minutos de videollamadas de este mes/, 'aviso de gracia de video visible');
  T.showAjustes();
  assert.match(document.body.textContent, /Ya no te quedan minutos de videollamadas este mes/);
  window.__cubmatchApp.dispose(); // limpia el temporizador de gracia
});
