// v1.7.0: llamadas de voz y video entre matches.
// - Payloads de señalización (kind 21004): construir/validar/rechazar.
// - Candados del video (triple consentimiento): todas las combinaciones.
// - Máquina de estados CallSession con RTC + transporte + timers falsos:
//   offer→answer→ice→conectada→end, reject, timeout 45 s, ocupado con
//   segunda llamada, ICE failed, permiso denegado.
// - Smoke jsdom: botones en la cabecera del chat, textos de candado y
//   overlay de llamada entrante ante una offer simulada (NIP-04 real).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { generateSecretKey, getPublicKey, finalizeEvent, nip04 } from 'nostr-tools';
import {
  KIND_CALL, buildCallPayload, parseCallPayload, newCallId,
  videoDisponible, rechazoEntranteVideo, textoRegistroLlamada, fmtDuracion,
  iceServersConfig, CallSession, MIN_MSGS_VIDEO, RING_TIMEOUT_MS,
} from '../src/llamadas.js';

// ------------------------------------------------------------ payloads

test('payloads: build + parse de ida y vuelta (offer/answer/ice/end/reject)', () => {
  const offer = buildCallPayload({ id: 'call-0123456789abcdef', op: 'offer', media: 'video', sdp: 'v=0 sdp…' });
  assert.deepEqual(parseCallPayload(JSON.stringify(offer)), offer);
  const ice = buildCallPayload({ id: 'call-0123456789abcdef', op: 'ice', media: 'audio', candidate: { candidate: 'candidate:1 udp …', sdpMid: '0' } });
  assert.deepEqual(parseCallPayload(JSON.stringify(ice)), ice);
  const rej = buildCallPayload({ id: 'call-0123456789abcdef', op: 'reject', media: 'video', motivo: 'ocupado' });
  assert.equal(parseCallPayload(JSON.stringify(rej)).motivo, 'ocupado');
  const end = buildCallPayload({ id: 'call-0123456789abcdef', op: 'end', media: 'audio' });
  assert.deepEqual(parseCallPayload(JSON.stringify(end)), end);
});

test('payloads: basura se rechaza (null), nunca lanza', () => {
  const base = { t: 'call', v: 1, id: 'call-0123456789abcdef', op: 'offer', media: 'audio', sdp: 'x' };
  const malos = [
    null, undefined, 42, '', 'no-json{', '"call"', '[]', '{}',
    JSON.stringify({ ...base, t: 'dm' }),
    JSON.stringify({ ...base, v: 2 }),
    JSON.stringify({ ...base, id: 'corto' }),
    JSON.stringify({ ...base, id: 'con espacios y ñ' }),
    JSON.stringify({ ...base, op: 'ring' }),
    JSON.stringify({ ...base, media: 'smoke-signals' }),
    JSON.stringify({ ...base, sdp: '' }),                    // offer sin sdp
    JSON.stringify({ ...base, op: 'answer', sdp: 42 }),      // sdp no string
    JSON.stringify({ ...base, op: 'ice', sdp: undefined, candidate: null }),
    JSON.stringify({ ...base, op: 'ice', candidate: {} }),   // candidato sin .candidate
    JSON.stringify({ ...base, op: 'ice', candidate: '' }),
  ];
  for (const m of malos) assert.equal(parseCallPayload(m), null, JSON.stringify(m));
  // motivo desconocido: se descarta el campo, no el payload
  const p = parseCallPayload(JSON.stringify({ ...base, op: 'reject', sdp: undefined, motivo: 'me-cai' }));
  assert.equal(p.op, 'reject');
  assert.equal(p.motivo, undefined);
});

test('newCallId: formato y unicidad práctica', () => {
  const a = newCallId(), b = newCallId();
  assert.match(a, /^call-[0-9a-f]{16}$/);
  assert.notEqual(a, b);
  // rng inyectado = determinista
  assert.equal(newCallId(() => 0), 'call-0000000000000000');
});

test('iceServersConfig: los tres STUN pedidos', () => {
  const cfg = iceServersConfig();
  assert.equal(cfg.length, 1);
  assert.deepEqual(cfg[0].urls, [
    'stun:stun.cloudflare.com:3478',
    'stun:stunserver.stunprotocol.org:3478',
    'stun:stun.l.google.com:19302',
  ]);
  assert.equal(KIND_CALL, 21004);
});

// ------------------------------------------------------------ candados de video

test('videoDisponible: dinámica primero — menos de 10 mensajes no hay video', () => {
  const su = { videoOk: true };
  for (const n of [0, 1, 9, undefined, null, 'x']) {
    const r = videoDisponible({}, su, n);
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'dinamica');
    assert.match(r.texto, /Sigan conversando: el video se activa con 10\+ mensajes/);
  }
});

test('videoDisponible: sin opt-in del receptor no hay video (ni con dinámica)', () => {
  for (const su of [{ videoOk: false }, {}, { videoOk: undefined }, null, undefined]) {
    const r = videoDisponible({ videoOk: true }, su, MIN_MSGS_VIDEO);
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'no-acepta');
    assert.equal(r.texto, 'Esta persona no acepta videollamadas.');
  }
});

test('videoDisponible: dinámica + opt-in = ok (mi propio videoOk no bloquea llamar)', () => {
  assert.deepEqual(videoDisponible({}, { videoOk: true }, 10), { ok: true });
  assert.deepEqual(videoDisponible({ videoOk: false }, { videoOk: true }, 25), { ok: true });
});

test('rechazoEntranteVideo: el receptor sin opt-in ni suena; con todo ok, suena', () => {
  assert.equal(rechazoEntranteVideo({ videoOk: false }, 50), 'no-acepta-video');
  assert.equal(rechazoEntranteVideo({}, 50), 'no-acepta-video');
  assert.equal(rechazoEntranteVideo(null, 50), 'no-acepta-video');
  assert.equal(rechazoEntranteVideo({ videoOk: true }, 3), 'sin-dinamica');
  assert.equal(rechazoEntranteVideo({ videoOk: true }, 10), null);
  assert.equal(rechazoEntranteVideo({ videoOk: true }, 99), null);
});

test('textoRegistroLlamada y fmtDuracion', () => {
  assert.equal(fmtDuracion(204), '3:24');
  assert.equal(fmtDuracion(0), '0:00');
  assert.equal(fmtDuracion(65), '1:05');
  assert.equal(textoRegistroLlamada({ media: 'audio', resultado: 'completada', durSeg: 204 }), '📞 Llamada de voz · 3:24');
  assert.equal(textoRegistroLlamada({ media: 'video', resultado: 'completada', durSeg: 65 }), '🎥 Videollamada · 1:05');
  assert.equal(textoRegistroLlamada({ media: 'audio', resultado: 'perdida' }), '📞 Llamada perdida');
  assert.equal(textoRegistroLlamada({ media: 'video', resultado: 'perdida' }), '🎥 Videollamada perdida');
});

// ------------------------------------------------------------ máquina de estados

class FakeTrack {
  constructor(kind) { this.kind = kind; this.enabled = true; this.stopped = false; }
  stop() { this.stopped = true; }
}
class FakeStream {
  constructor(media) {
    this.tracks = [new FakeTrack('audio')];
    if (media === 'video') this.tracks.push(new FakeTrack('video'));
  }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
}
class FakePC {
  constructor() {
    this.connectionState = 'new';
    this.remoteDescription = null;
    this.localDescription = null;
    this.added = [];
    this.closed = false;
    this.onicecandidate = null; this.ontrack = null; this.onconnectionstatechange = null;
  }
  addTrack(track, stream) { this.added.push(track.kind); }
  async createOffer() { return { type: 'offer', sdp: 'SDP-OFFER' }; }
  async createAnswer() { return { type: 'answer', sdp: 'SDP-ANSWER' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate(c) { this.candidates = this.candidates || []; this.candidates.push(c); }
  close() { this.closed = true; }
  setConnState(st) { this.connectionState = st; if (this.onconnectionstatechange) this.onconnectionstatechange(); }
  emitIce(cand) { if (this.onicecandidate) this.onicecandidate({ candidate: cand }); }
  emitTrack() { if (this.ontrack) this.ontrack({ streams: [{ remoto: true }] }); }
}
const fakeCandidate = { candidate: 'candidate:xyz', sdpMid: '0', toJSON() { return { candidate: this.candidate, sdpMid: this.sdpMid }; } };

function fakeTimers() {
  let seq = 1; const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = seq++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    fire: (ms) => { for (const [id, t] of [...pending]) if (t.ms === ms) { pending.delete(id); t.fn(); } },
    count: () => pending.size,
  };
}

function mkSession(extra = {}) {
  const sent = [];
  const eventos = [];
  const timers = fakeTimers();
  let reloj = 1000000;
  const ses = new CallSession({
    send: (peer, payload) => { sent.push({ peer, payload }); },
    createPC: () => new FakePC(),
    getLocalStream: async (media) => new FakeStream(media),
    onEvent: (e) => eventos.push(e),
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    nowFn: () => reloj,
    rng: () => 0.5,
    ...extra,
  });
  return { ses, sent, eventos, timers, avanzar: (ms) => { reloj += ms; } };
}
const tick = () => new Promise((r) => setImmediate(r));
const ID = 'call-8888888888888888'; // rng () => 0.5 → 0x8 repetido

test('sesión: flujo completo saliente offer→answer→ice→conectada→colgar', async () => {
  const { ses, sent, eventos, avanzar } = mkSession();
  assert.equal(await ses.llamar('peerPK', 'audio'), true);
  assert.equal(ses.state, 'saliendo');
  const offer = sent.find((s) => s.payload.op === 'offer');
  assert.ok(offer && offer.peer === 'peerPK');
  assert.equal(offer.payload.id, ID);
  assert.equal(offer.payload.sdp, 'SDP-OFFER');
  assert.equal(ses.pc.localDescription.sdp, 'SDP-OFFER');

  // ICE del otro antes del answer: se encola y se aplica tras setRemote
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'ice', media: 'audio', candidate: { candidate: 'candidate:remoto' } })));
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER' })));
  assert.equal(ses.state, 'conectando');
  assert.equal(ses.pc.remoteDescription.sdp, 'SDP-ANSWER');
  assert.deepEqual(ses.pc.candidates, [{ candidate: 'candidate:remoto' }], 'ICE encolado aplicado');

  // mi ICE saliente se señaliza
  ses.pc.emitIce(fakeCandidate);
  const iceOut = sent.find((s) => s.payload.op === 'ice');
  assert.deepEqual(iceOut.payload.candidate, { candidate: 'candidate:xyz', sdpMid: '0' });

  ses.pc.emitTrack();
  assert.equal(eventos.filter((e) => e.tipo === 'stream-remoto').length, 1);
  ses.pc.setConnState('connected');
  assert.equal(ses.state, 'conectada');
  assert.equal(eventos.filter((e) => e.tipo === 'conectada').length, 1);

  avanzar(204000); // 3:24 de llamada
  assert.equal(ses.duracionSeg(), 204);
  // mute
  assert.equal(ses.toggleMute(), true);
  assert.equal(ses.localStream.getAudioTracks()[0].enabled, false);
  assert.equal(ses.toggleMute(), false);

  ses.colgar();
  assert.equal(ses.state, 'idle');
  assert.ok(sent.some((s) => s.payload.op === 'end'));
  const fin = eventos.find((e) => e.tipo === 'terminada');
  assert.equal(fin.resultado, 'completada');
  assert.equal(fin.durSeg, 204);
  assert.equal(ses.localStream, null, 'tracks detenidos y soltados');
});

test('sesión: flujo entrante — offer suena, aceptar responde answer, end remoto cierra', async () => {
  const { ses, sent, eventos, avanzar } = mkSession();
  const offerIn = parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-aaaaaaaabbbbbbbb', op: 'offer', media: 'video', sdp: 'SDP-REMOTA' }));
  await ses.recibir('peerPK', offerIn);
  assert.equal(ses.state, 'entrante');
  assert.equal(eventos.find((e) => e.tipo === 'entrante').media, 'video');

  assert.equal(await ses.aceptar(), true);
  assert.equal(ses.state, 'conectando');
  assert.equal(ses.pc.remoteDescription.sdp, 'SDP-REMOTA');
  const ans = sent.find((s) => s.payload.op === 'answer');
  assert.equal(ans.payload.sdp, 'SDP-ANSWER');
  assert.equal(ans.payload.id, 'call-aaaaaaaabbbbbbbb');

  ses.pc.setConnState('connected');
  avanzar(5000);
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-aaaaaaaabbbbbbbb', op: 'end', media: 'video' })));
  assert.equal(ses.state, 'idle');
  const fin = eventos.find((e) => e.tipo === 'terminada');
  assert.equal(fin.resultado, 'completada');
  assert.equal(fin.durSeg, 5);
});

test('sesión: rechazar entrante envía reject y registra perdida', async () => {
  const { ses, sent, eventos } = mkSession();
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-aaaaaaaabbbbbbbb', op: 'offer', media: 'audio', sdp: 'SDP' })));
  ses.rechazar();
  assert.equal(ses.state, 'idle');
  assert.ok(sent.some((s) => s.payload.op === 'reject'));
  assert.equal(eventos.find((e) => e.tipo === 'terminada').resultado, 'perdida');
});

test('sesión: reject recibido (y ocupado con motivo) cierra la saliente', async () => {
  const a = mkSession();
  await a.ses.llamar('peerPK', 'audio');
  await a.ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'reject', media: 'audio' })));
  assert.equal(a.ses.state, 'idle');
  assert.equal(a.eventos.find((e) => e.tipo === 'terminada').resultado, 'rechazada');

  const b = mkSession();
  await b.ses.llamar('peerPK', 'video');
  await b.ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'reject', media: 'video', motivo: 'ocupado' })));
  assert.equal(b.eventos.find((e) => e.tipo === 'terminada').resultado, 'ocupado');
});

test('sesión: timeout de timbre saliente a los 45 s → end + sin-respuesta', async () => {
  const { ses, sent, eventos, timers } = mkSession();
  await ses.llamar('peerPK', 'audio');
  assert.equal(timers.count(), 1);
  timers.fire(RING_TIMEOUT_MS);
  assert.equal(ses.state, 'idle');
  assert.ok(sent.some((s) => s.payload.op === 'end'));
  assert.equal(eventos.find((e) => e.tipo === 'terminada').resultado, 'sin-respuesta');
});

test('sesión: segunda llamada estando en una → reject ocupado, la actual sigue', async () => {
  const { ses, sent } = mkSession();
  await ses.llamar('peerPK', 'audio');
  await ses.recibir('otroPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-cccccccdddddddd0', op: 'offer', media: 'audio', sdp: 'SDP' })));
  const rej = sent.find((s) => s.payload.op === 'reject');
  assert.ok(rej);
  assert.equal(rej.peer, 'otroPK');
  assert.equal(rej.payload.motivo, 'ocupado');
  assert.equal(ses.state, 'saliendo', 'la llamada actual no se tocó');
});

test('sesión: ICE failed → end + sin-conexion (sin TURN no hay plan B)', async () => {
  const { ses, sent, eventos } = mkSession();
  await ses.llamar('peerPK', 'video');
  ses.pc.setConnState('failed');
  assert.equal(ses.state, 'idle');
  assert.ok(sent.some((s) => s.payload.op === 'end'));
  assert.equal(eventos.find((e) => e.tipo === 'terminada').resultado, 'sin-conexion');
});

test('sesión: permiso denegado al llamar → error claro, sin offer, queda idle', async () => {
  const { ses, sent, eventos } = mkSession({
    getLocalStream: async () => { throw new Error('NotAllowedError'); },
  });
  assert.equal(await ses.llamar('peerPK', 'video'), false);
  assert.equal(ses.state, 'idle');
  assert.equal(sent.length, 0, 'no se señalizó nada');
  const fin = eventos.find((e) => e.tipo === 'terminada');
  assert.equal(fin.resultado, 'error');
  assert.match(fin.mensaje, /Permiso de cámara o micrófono denegado/);
});

test('sesión: señalización de otra llamada (id distinto) se ignora', async () => {
  const { ses, eventos } = mkSession();
  await ses.llamar('peerPK', 'audio');
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-9999999999999999', op: 'end', media: 'audio' })));
  assert.equal(ses.state, 'saliendo', 'un end ajeno no cuelga mi llamada');
  assert.equal(eventos.filter((e) => e.tipo === 'terminada').length, 0);
});

// ------------------------------------------------------------ smoke jsdom

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const skA = generateSecretKey(); const pkA = getPublicKey(skA);
const skB = generateSecretKey(); const pkB = getPublicKey(skB);

await import('../src/app.js');
await new Promise((r) => setTimeout(r, 100));
const T = window.__cubmatchApp._test;
assert.ok(T, 'hook _test expuesto');
const S = () => T.getS();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakePool() {
  const client = {
    subscribe: () => ({ unsub() {}, eose: () => Promise.resolve() }),
    publish: async () => ({}),
    sendReceipt: () => {},
  };
  return {
    acquire() {}, release() {},
    messaging: () => client,
    discovery: () => client,
    roles: { discovery: [], messaging: [] },
    shutdown() {},
  };
}

function prepararChat(nMensajes, peerProfile) {
  const s = S();
  s.pool = fakePool();
  s.sk = skB;
  s.pubkey = pkB;
  s.miPerfil = { apodo: 'Yo', videoOk: true };
  s.bloqueados = [];
  s.data = { likes: { sent: { [pkA]: { tipo: '+' } }, received: { [pkA]: { tipo: '+' } } } };
  s.perfilCache = new Map([[pkA, { profile: peerProfile, pubkey: pkA }]]);
  s.chats = {};
  T.showChat(pkA);
  const msgs = [];
  for (let i = 0; i < nMensajes; i++) {
    msgs.push({ id: 'm' + i, from: i % 2 ? 'me' : 'peer', ts: Date.now() + i, text: 'mensaje ' + i, read: true });
  }
  s.chats[pkA] = msgs;
  return s;
}

test('smoke: la cabecera del chat trae 📞 y 🎥; el 🎥 explica el candado de dinámica', async () => {
  prepararChat(3, { apodo: 'Ana', videoOk: true });
  assert.ok(document.querySelector('[data-act="chat-call-voz"]'), 'botón de voz presente');
  const btnV = document.querySelector('[data-act="chat-call-video"]');
  assert.ok(btnV, 'botón de video presente');
  T.refreshVideoBtn();
  assert.ok(btnV.classList.contains('call-off'), 'con 3 mensajes el video se ve bloqueado');
  assert.match(btnV.title, /Sigan conversando/);
  btnV.click();
  await wait(30);
  const toastTxt = document.body.textContent;
  assert.match(toastTxt, /Sigan conversando: el video se activa con 10\+ mensajes/);
});

test('smoke: con dinámica pero sin opt-in del otro, el candado dice que no acepta', async () => {
  prepararChat(12, { apodo: 'Ana', videoOk: false });
  document.querySelector('[data-act="chat-call-video"]').click();
  await wait(30);
  assert.match(document.body.textContent, /Esta persona no acepta videollamadas/);
});

test('smoke: offer entrante (NIP-04 real) de un match abre el overlay; rechazar lo cierra', async () => {
  const s = prepararChat(0, { apodo: 'Ana', videoOk: true });
  const captured = [];
  let fakePC = null;
  T.setCallDeps({
    send: async (peer, payload) => { captured.push({ peer, payload }); },
    createPC: () => { fakePC = new FakePC(); return fakePC; },
    getLocalStream: async (media) => new FakeStream(media),
  });
  T.stopCalls();
  T.startCalls(); // crea la sesión con las deps falsas y la suscripción (pool falso)

  const payload = { t: 'call', v: 1, id: 'call-1234567890abcdef', op: 'offer', media: 'audio', sdp: 'SDP-DE-A' };
  const ev = finalizeEvent({
    kind: KIND_CALL, created_at: Math.floor(Date.now() / 1000),
    tags: [['p', pkB]], content: await nip04.encrypt(skA, pkB, JSON.stringify(payload)),
  }, skA);
  await T.handleCallSignalEvent(JSON.parse(JSON.stringify(ev)));
  const ov = document.getElementById('call-overlay');
  assert.ok(ov, 'el overlay de llamada entrante apareció');
  assert.match(ov.textContent, /Ana/);
  assert.match(ov.textContent, /Llamada de voz/);
  assert.match(ov.textContent, /Llamada entrante/);

  ov.querySelector('[data-call="rechazar"]').click();
  await wait(30);
  assert.equal(document.getElementById('call-overlay'), null, 'el overlay se cerró');
  const rej = captured.find((c) => c.payload.op === 'reject');
  assert.ok(rej && rej.peer === pkA, 'se envió el reject al que llamaba');
  // y la llamada perdida quedó registrada en el chat local
  const reg = (s.chats[pkA] || []).find((m) => m.tipo === 'call');
  assert.ok(reg && /Llamada perdida/.test(reg.text), 'registro local de llamada perdida');
  T.stopCalls();
});

test('smoke: offer de un NO-match se ignora en silencio', async () => {
  const s = prepararChat(0, { apodo: 'Ana', videoOk: true });
  s.data = { likes: { sent: {}, received: {} } }; // ya no es match
  T.setCallDeps({
    send: async () => {},
    createPC: () => new FakePC(),
    getLocalStream: async (media) => new FakeStream(media),
  });
  T.stopCalls(); T.startCalls();
  const payload = { t: 'call', v: 1, id: 'call-abcdefabcdefabcd', op: 'offer', media: 'audio', sdp: 'SDP' };
  const ev = finalizeEvent({
    kind: KIND_CALL, created_at: Math.floor(Date.now() / 1000),
    tags: [['p', pkB]], content: await nip04.encrypt(skA, pkB, JSON.stringify(payload)),
  }, skA);
  await T.handleCallSignalEvent(JSON.parse(JSON.stringify(ev)));
  assert.equal(document.getElementById('call-overlay'), null, 'sin overlay para no-matches');
  T.stopCalls();
});
