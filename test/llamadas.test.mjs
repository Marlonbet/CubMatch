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
  iceServersConfig, fusionarIceServers, obtenerIceServers, offerEsFresca, CallSession, MIN_MSGS_VIDEO, RING_TIMEOUT_MS,
  RING_IN_TIMEOUT_MS, CONNECT_TIMEOUT_MS, ICE_DISCONNECTED_GRACE_MS,
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

test('iceServersConfig: STUN para directo + TURN OpenRelay de respaldo (datos móviles)', () => {
  const cfg = iceServersConfig();
  assert.equal(cfg.length, 2);
  assert.deepEqual(cfg[0].urls, [
    'stun:stun.cloudflare.com:3478',
    'stun:stunserver.stunprotocol.org:3478',
    'stun:stun.l.google.com:19302',
  ]);
  // TURN público de OpenRelay (Metered): UDP y TCP en el 80, TCP en
  // el 443 (puerta para redes que solo dejan pasar el puerto web) y
  // TLS en el 443, con sus credenciales públicas.
  assert.deepEqual(cfg[1].urls, [
    'turn:openrelay.metered.ca:80',
    'turn:openrelay.metered.ca:80?transport=tcp',
    'turn:openrelay.metered.ca:443?transport=tcp',
    'turns:openrelay.metered.ca:443',
  ]);
  assert.equal(cfg[1].username, 'openrelayproject');
  assert.equal(cfg[1].credential, 'openrelayproject');
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
    this.iceConnectionState = 'new';
    this.remoteDescription = null;
    this.localDescription = null;
    this.added = [];
    this.closed = false;
    this.onicecandidate = null; this.ontrack = null; this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
  }
  addTrack(track, stream) { this.added.push(track.kind); }
  async createOffer(opts) { this.offerOpts = this.offerOpts || []; this.offerOpts.push(opts); return { type: 'offer', sdp: 'SDP-OFFER' }; }
  async createAnswer() { return { type: 'answer', sdp: 'SDP-ANSWER' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate(c) { this.candidates = this.candidates || []; this.candidates.push(c); }
  setConfiguration(cfg) { this.configurations = this.configurations || []; this.configurations.push(cfg); }
  close() { this.closed = true; }
  setConnState(st) { this.connectionState = st; if (this.onconnectionstatechange) this.onconnectionstatechange(); }
  setIceState(st) { this.iceConnectionState = st; if (this.oniceconnectionstatechange) this.oniceconnectionstatechange(); }
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

test('sesión: ICE failed → end + sin-conexion (ni directo ni con TURN)', async () => {
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

// ------------------------------------------------- fix v1.8.1: fantasmas

test('offerEsFresca: ventana de 60 s atrás y 120 s adelante, con bordes', () => {
  const now = 1_000_000;
  assert.equal(offerEsFresca(now, now), true, 'recién creada');
  assert.equal(offerEsFresca(now - 59, now), true, '59 s: fresca');
  assert.equal(offerEsFresca(now - 60, now), true, '60 s exactos: fresca');
  assert.equal(offerEsFresca(now - 61, now), false, '61 s: vieja, es un eco');
  assert.equal(offerEsFresca(now - 3600, now), false, 'una hora: fantasma');
  assert.equal(offerEsFresca(now + 119, now), true, '119 s de futuro: reloj adelantado, pasa');
  assert.equal(offerEsFresca(now + 121, now), false, '121 s de futuro: absurdo');
  assert.equal(offerEsFresca(0, now), false);
  assert.equal(offerEsFresca(undefined, now), false);
  assert.equal(offerEsFresca(now, NaN), false);
  assert.equal(offerEsFresca('basura', now), false);
});

test('sesión: la MISMA offer reentregada mientras suena no manda reject ocupado ni suena dos veces', async () => {
  const { ses, sent, eventos } = mkSession();
  const offer = parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-aaaaaaaabbbbbbbb', op: 'offer', media: 'audio', sdp: 'SDP' }));
  await ses.recibir('peerPK', offer);
  assert.equal(ses.state, 'entrante');
  // El pool la entrega otra vez (segundo relay): silencio total.
  await ses.recibir('peerPK', offer);
  await ses.recibir('peerPK', offer);
  assert.equal(ses.state, 'entrante', 'sigue sonando la misma llamada');
  assert.equal(eventos.filter((e) => e.tipo === 'entrante').length, 1, 'sonó una sola vez');
  assert.equal(sent.filter((s) => s.payload.op === 'reject').length, 0, 'NADA de reject ocupado por un duplicado');
});

test('sesión: offer reproducida tras cerrarse la llamada no resucita (dedup por callId)', async () => {
  const { ses, eventos } = mkSession();
  const offer = parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-aaaaaaaabbbbbbbb', op: 'offer', media: 'audio', sdp: 'SDP' }));
  await ses.recibir('peerPK', offer);
  ses.rechazar(); // la llamada se cierra de verdad
  assert.equal(ses.state, 'idle');
  const antes = eventos.length;
  // Un relay que la almacenó la reentrega al reconectar: no suena.
  await ses.recibir('peerPK', offer);
  assert.equal(ses.state, 'idle', 'no resucitó');
  assert.equal(eventos.slice(antes).filter((e) => e.tipo === 'entrante').length, 0);
});

test('sesión: el eco de mi propia offer (mismo callId que mi saliente) no me suena ni me la cuelga', async () => {
  const { ses, sent, eventos } = mkSession();
  await ses.llamar('peerPK', 'audio'); // mi llamada saliente tiene id ID
  // Un relay me reentrega mi propia offer como si viniera del par:
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'offer', media: 'audio', sdp: 'SDP-OFFER' })));
  assert.equal(ses.state, 'saliendo', 'mi saliente sigue viva');
  assert.equal(eventos.filter((e) => e.tipo === 'entrante').length, 0, 'nunca sonó como entrante');
  assert.equal(sent.filter((s) => s.payload.op === 'reject').length, 0);
});

test('sesión: ICE que llega ANTES que la offer se aplica al aceptar (conecta igual)', async () => {
  const { ses } = mkSession();
  const idX = 'call-1111111122222222';
  // Los relays no garantizan orden: primero el ICE, sin sesión aún.
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idX, op: 'ice', media: 'audio', candidate: { candidate: 'candidate:temprano' } })));
  assert.equal(ses.state, 'idle');
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idX, op: 'offer', media: 'audio', sdp: 'SDP-REMOTA' })));
  assert.equal(ses.state, 'entrante');
  assert.equal(await ses.aceptar(), true);
  assert.equal(ses.pc.remoteDescription.sdp, 'SDP-REMOTA');
  assert.deepEqual(ses.pc.candidates, [{ candidate: 'candidate:temprano' }], 'el ICE buferizado se aplicó tras setRemoteDescription');
});

test('sesión: ICE que llega DURANTE el timbre (aún sin pc) no se pierde', async () => {
  const { ses } = mkSession();
  const idX = 'call-3333333344444444';
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idX, op: 'offer', media: 'audio', sdp: 'SDP-REMOTA' })));
  // Suena el teléfono; el llamante ya manda candidatos y el pc del
  // receptor aún no existe (nace al aceptar): antes se descartaban.
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idX, op: 'ice', media: 'audio', candidate: { candidate: 'candidate:del-timbre' } })));
  assert.equal(await ses.aceptar(), true);
  assert.deepEqual(ses.pc.candidates, [{ candidate: 'candidate:del-timbre' }], 'el ICE del timbre se aplicó al aceptar');
});

test('sesión: buffer de ICE huérfano caduca (TTL) y no contamina llamadas posteriores', async () => {
  const { ses, avanzar } = mkSession();
  const idViejo = 'call-5555555566666666';
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idViejo, op: 'ice', media: 'audio', candidate: { candidate: 'candidate:stale' } })));
  avanzar(61000); // pasa el TTL de 60 s
  // Llega otra señalización cualquiera: la poda corre y el buffer murió.
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idViejo, op: 'ice', media: 'audio', candidate: { candidate: 'candidate:nuevo' } })));
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idViejo, op: 'offer', media: 'audio', sdp: 'SDP' })));
  assert.equal(await ses.aceptar(), true);
  assert.deepEqual(ses.pc.candidates, [{ candidate: 'candidate:nuevo' }], 'solo entró el candidato vivo, no el caducado');
});

// --------------------------------------- fix v1.8.3: anti-ocupado fantasma

test('sesión: el timbre entrante caduca a los 45 s (alineado) y la siguiente llamada SÍ suena', async () => {
  const { ses, eventos, timers } = mkSession();
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-aaaaaaaabbbbbbbb', op: 'offer', media: 'audio', sdp: 'SDP' })));
  assert.equal(ses.state, 'entrante');
  assert.equal(timers.count(), 1);
  timers.fire(RING_IN_TIMEOUT_MS); // antes eran 60 s: quedaba "ocupado" tras abandonarse
  assert.equal(ses.state, 'idle');
  assert.equal(eventos.find((e) => e.tipo === 'terminada').resultado, 'perdida');
  assert.equal(timers.count(), 0, 'el reset no deja timers huérfanos');
  // La re-llamada inmediata ya NO recibe un ocupado fantasma:
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-ccccccccdddddddd', op: 'offer', media: 'audio', sdp: 'SDP' })));
  assert.equal(ses.state, 'entrante', 'la segunda llamada suena');
});

test('sesión: un end/reject que adelanta a su offer mata la offer tardía (nace muerta)', async () => {
  const { ses, eventos } = mkSession();
  const idX = 'call-12121212abababab';
  // Los relays no ordenan: primero llega el end de una llamada que
  // aquí aún no "existe". Antes se descartaba y la offer sonaba.
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idX, op: 'end', media: 'audio' })));
  assert.equal(ses.state, 'idle');
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idX, op: 'offer', media: 'audio', sdp: 'SDP' })));
  assert.equal(ses.state, 'idle', 'la offer tardía no suena');
  assert.equal(eventos.filter((e) => e.tipo === 'entrante').length, 0);
  // Igual con un reject temprano:
  const idY = 'call-34343434cdcdcdcd';
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idY, op: 'reject', media: 'audio', motivo: 'ocupado' })));
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idY, op: 'offer', media: 'audio', sdp: 'SDP' })));
  assert.equal(ses.state, 'idle');
  // Y una llamada distinta no se contamina:
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-56565656efefefef', op: 'offer', media: 'audio', sdp: 'SDP' })));
  assert.equal(ses.state, 'entrante', 'otra llamada sí suena');
});

test('sesión: conectando tiene plazo — si el medio nunca llega, se corta solo', async () => {
  const { ses, sent, eventos, timers } = mkSession();
  await ses.llamar('peerPK', 'audio');
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER' })));
  assert.equal(ses.state, 'conectando');
  assert.equal(timers.count(), 1, 'solo queda el plazo de conexión');
  timers.fire(CONNECT_TIMEOUT_MS);
  assert.equal(ses.state, 'idle');
  assert.equal(eventos.find((e) => e.tipo === 'terminada').resultado, 'sin-conexion');
  assert.ok(sent.some((s) => s.payload.op === 'end'));
  assert.equal(timers.count(), 0);
});

test('sesión: watchdog de ICE — disconnected breve se perdona, sostenido corta', async () => {
  const { ses, sent, eventos, timers } = mkSession();
  await ses.llamar('peerPK', 'audio');
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER' })));
  ses.pc.setConnState('connected');
  assert.equal(ses.state, 'conectada');
  // v1.10.0: en conectada vive UN temporizador legítimo, el
  // muestreador de relevo (presupuesto de llamadas). Los demás
  // (timbre, plazo, watchdog) deben estar muertos.
  assert.equal(timers.count(), 1, 'conectada solo deja vivo el muestreador de relevo');
  // Un bache de red: disconnected… y se recupera antes de la gracia.
  ses.pc.setIceState('disconnected');
  assert.equal(timers.count(), 2, 'watchdog armado (más el muestreador)');
  ses.pc.setIceState('connected');
  assert.equal(timers.count(), 1, 'watchdog desarmado al recuperarse; queda el muestreador');
  assert.equal(ses.state, 'conectada');
  // Segundo bache, este sostenido: a la gracia, corte limpio.
  ses.pc.setIceState('disconnected');
  timers.fire(ICE_DISCONNECTED_GRACE_MS);
  assert.equal(ses.state, 'idle');
  assert.equal(eventos.find((e) => e.tipo === 'terminada').resultado, 'sin-conexion');
  assert.ok(sent.some((s) => s.payload.op === 'end'));
  assert.equal(timers.count(), 0);
});

test('sesión: watchdog de ICE también vigila el conectando del receptor', async () => {
  const { ses, eventos, timers } = mkSession();
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-aaaaaaaabbbbbbbb', op: 'offer', media: 'audio', sdp: 'SDP' })));
  assert.equal(await ses.aceptar(), true);
  assert.equal(ses.state, 'conectando');
  ses.pc.setIceState('disconnected');
  timers.fire(ICE_DISCONNECTED_GRACE_MS);
  assert.equal(ses.state, 'idle');
  assert.equal(eventos.find((e) => e.tipo === 'terminada').resultado, 'sin-conexion');
  assert.equal(timers.count(), 0, 'también cayó el plazo de conexión: reset total');
});

test('sesión: llamar desde un estado pegado libera el fantasma y procede; desde una viva, no', async () => {
  // Caso 1: acepté y la conexión murió en silencio (pc cerrada, sin eventos).
  const a = mkSession();
  await a.ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-aaaaaaaabbbbbbbb', op: 'offer', media: 'audio', sdp: 'SDP' })));
  assert.equal(await a.ses.aceptar(), true);
  a.ses.pc.connectionState = 'closed'; // el pc murió sin avisar
  assert.equal(await a.ses.llamar('otroPK', 'audio'), true, 'un fantasma no bloquea mi propia llamada');
  assert.equal(a.ses.state, 'saliendo');
  assert.ok(a.sent.some((s) => s.payload.op === 'end' && s.payload.id === 'call-aaaaaaaabbbbbbbb'), 'al fantasma se le avisó el cierre');
  assert.ok(a.eventos.some((e) => e.tipo === 'terminada' && e.id === 'call-aaaaaaaabbbbbbbb'));
  assert.ok(a.sent.some((s) => s.payload.op === 'offer' && s.peer === 'otroPK'), 'salió la offer nueva');

  // Caso 2: conectando con pc "viva" pero estado viejísimo (>60 s).
  const b = mkSession();
  await b.ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-aaaaaaaabbbbbbbb', op: 'offer', media: 'audio', sdp: 'SDP' })));
  assert.equal(await b.ses.aceptar(), true);
  b.avanzar(61000);
  assert.equal(await b.ses.llamar('otroPK', 'audio'), true);
  assert.equal(b.ses.state, 'saliendo');

  // Caso 3 (negativo): llamada CONECTADA y viva — llamar no la toca.
  const c = mkSession();
  await c.ses.llamar('peerPK', 'audio');
  await c.ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER' })));
  c.ses.pc.setConnState('connected');
  assert.equal(c.ses.state, 'conectada');
  assert.equal(await c.ses.llamar('otroPK', 'audio'), false, 'una llamada viva no se sacrifica');
  assert.equal(c.ses.state, 'conectada');
});

test('sesión: offer nueva frente a timbre caducado (timer dormido) — suena, no sale ocupado', async () => {
  const { ses, sent, eventos, avanzar, timers } = mkSession();
  const id1 = 'call-aaaaaaaabbbbbbbb', id2 = 'call-ccccccccdddddddd';
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: id1, op: 'offer', media: 'audio', sdp: 'SDP' })));
  assert.equal(ses.state, 'entrante');
  avanzar(46000); // el reloj pasó el plazo, pero el TIMER no corrió (app en segundo plano)
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: id2, op: 'offer', media: 'audio', sdp: 'SDP' })));
  assert.equal(ses.state, 'entrante', 'la offer nueva suena');
  assert.equal(ses.current.id, id2);
  assert.equal(eventos.filter((e) => e.tipo === 'entrante').length, 2, 'sonaron la vieja y la nueva');
  assert.equal(eventos.find((e) => e.tipo === 'terminada' && e.id === id1).resultado, 'perdida');
  assert.ok(sent.some((s) => s.payload.op === 'reject' && s.payload.id === id1 && s.payload.motivo === 'ocupado'), 'al llamante viejo se le avisó ocupado');
  assert.equal(sent.filter((s) => s.payload.op === 'reject' && s.payload.id === id2).length, 0, 'a la llamada NUEVA no se le mandó ocupado');
  assert.equal(timers.count(), 1, 'solo vive el timbre de la llamada nueva');
});

test('sesión: ocupado REAL en llamada conectada y viva sigue existiendo', async () => {
  const { ses, sent } = mkSession();
  await ses.llamar('peerPK', 'audio');
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER' })));
  ses.pc.setConnState('connected');
  await ses.recibir('otroPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-9999999988888888', op: 'offer', media: 'audio', sdp: 'SDP' })));
  const rej = sent.find((s) => s.payload.op === 'reject' && s.payload.id === 'call-9999999988888888');
  assert.ok(rej && rej.payload.motivo === 'ocupado', 'ocupado de verdad para la segunda llamada');
  assert.equal(ses.state, 'conectada', 'la llamada viva no se tocó');
});

// --------------------------------------- v1.8.3: restart de ICE (datos móviles)

test('payloads: el flag restart solo vive en offers y sobrevive al parse', () => {
  const ro = buildCallPayload({ id: 'call-0123456789abcdef', op: 'offer', media: 'audio', sdp: 'SDP', restart: true });
  assert.equal(ro.restart, true);
  assert.deepEqual(parseCallPayload(JSON.stringify(ro)), ro);
  const sin = buildCallPayload({ id: 'call-0123456789abcdef', op: 'offer', media: 'audio', sdp: 'SDP' });
  assert.equal('restart' in sin, false);
  const ans = parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-0123456789abcdef', op: 'answer', media: 'audio', sdp: 'SDP', restart: true }));
  assert.equal(ans.restart, undefined, 'en un answer el flag no significa nada y se descarta');
});

test('sesión: ICE failed en conectando → UN restart con el mismo callId, y conecta', async () => {
  const { ses, sent, eventos } = mkSession();
  await ses.llamar('peerPK', 'audio');
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER' })));
  assert.equal(ses.state, 'conectando');
  ses.pc.setIceState('failed'); // primer fallo: NO se corta, se renegocia
  await tick();
  assert.equal(ses.state, 'conectando', 'la llamada sigue viva tras el primer failed');
  assert.equal(eventos.filter((e) => e.tipo === 'terminada').length, 0);
  const offers = sent.filter((s) => s.payload.op === 'offer');
  assert.equal(offers.length, 2, 'salió una segunda offer');
  assert.equal(offers[1].payload.id, ID, 'con el MISMO callId');
  assert.equal(offers[1].payload.restart, true, 'marcada como restart');
  assert.deepEqual(ses.pc.offerOpts.at(-1), { iceRestart: true }, 'createOffer pidió restart de ICE');
  // El par responde al restart y esta vez el medio sí pasa:
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER-2' })));
  assert.equal(ses.pc.remoteDescription.sdp, 'SDP-ANSWER-2');
  ses.pc.setConnState('connected');
  assert.equal(ses.state, 'conectada');
});

test('sesión: el mismo failed avisado por ICE y por connectionState cuenta UNA vez', async () => {
  const { ses, sent } = mkSession();
  await ses.llamar('peerPK', 'audio');
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER' })));
  ses.pc.setIceState('failed');
  ses.pc.setConnState('failed'); // el navegador avisa por las dos vías
  await tick();
  assert.equal(sent.filter((s) => s.payload.op === 'offer' && s.payload.restart).length, 1, 'un solo restart');
  assert.equal(ses.state, 'conectando', 'el segundo aviso no mató el restart en curso');
});

test('sesión: segundo failed tras el restart → sin-conexion de siempre', async () => {
  const { ses, sent, eventos } = mkSession();
  await ses.llamar('peerPK', 'audio');
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER' })));
  ses.pc.setIceState('failed');
  await tick(); // el restart sale
  assert.equal(sent.filter((s) => s.payload.op === 'offer' && s.payload.restart).length, 1);
  ses.pc.setIceState('failed'); // el segundo intento también muere
  await tick();
  assert.equal(ses.state, 'idle');
  assert.equal(eventos.find((e) => e.tipo === 'terminada').resultado, 'sin-conexion');
  assert.ok(sent.some((s) => s.payload.op === 'end'), 'se avisó el cierre al par');
  assert.equal(sent.filter((s) => s.payload.op === 'offer' && s.payload.restart).length, 1, 'no hubo tercer intento');
});

test('sesión: si el ICE muere en el RECEPTOR tras aceptar, él inicia el restart', async () => {
  const { ses, sent } = mkSession();
  const idX = 'call-aaaaaaaabbbbbbbb';
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idX, op: 'offer', media: 'audio', sdp: 'SDP-REMOTA' })));
  assert.equal(await ses.aceptar(), true);
  assert.equal(ses.state, 'conectando');
  ses.pc.setIceState('failed');
  await tick();
  const re = sent.filter((s) => s.payload.op === 'offer' && s.payload.restart);
  assert.equal(re.length, 1, 'el receptor se volvió oferente de la renegociación');
  assert.equal(re[0].payload.id, idX);
  // El llamante responde con un answer a MI restart:
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idX, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER-DEL-OTRO' })));
  assert.equal(ses.pc.remoteDescription.sdp, 'SDP-ANSWER-DEL-OTRO');
  ses.pc.setConnState('connected');
  assert.equal(ses.state, 'conectada');
});

test('sesión: offer de restart del par se responde con answer nuevo, sin sonar ni duplicar', async () => {
  const { ses, sent, eventos } = mkSession();
  const idX = 'call-aaaaaaaabbbbbbbb';
  const offer = parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idX, op: 'offer', media: 'audio', sdp: 'SDP-REMOTA' }));
  await ses.recibir('peerPK', offer);
  assert.equal(await ses.aceptar(), true);
  assert.equal(sent.filter((s) => s.payload.op === 'answer').length, 1);
  // Llega la renegociación del llamante: mismo id, restart:true.
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: idX, op: 'offer', media: 'audio', sdp: 'SDP-RESTART', restart: true })));
  assert.equal(ses.pc.remoteDescription.sdp, 'SDP-RESTART', 'se aplicó la offer nueva');
  assert.equal(sent.filter((s) => s.payload.op === 'answer').length, 2, 'salió un segundo answer');
  assert.equal(ses.state, 'conectando');
  assert.equal(eventos.filter((e) => e.tipo === 'entrante').length, 1, 'NO volvió a sonar: es la misma llamada');
  // Y un duplicado ordinario del mismo id sigue ignorándose:
  await ses.recibir('peerPK', offer);
  assert.equal(sent.filter((s) => s.payload.op === 'answer').length, 2, 'sin tercer answer');
});

test('sesión: en conectada NO hay restart — un failed corta como siempre', async () => {
  const { ses, sent, eventos } = mkSession();
  await ses.llamar('peerPK', 'audio');
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER' })));
  ses.pc.setConnState('connected');
  assert.equal(ses.state, 'conectada');
  ses.pc.setIceState('failed');
  await tick();
  assert.equal(ses.state, 'idle');
  assert.equal(eventos.find((e) => e.tipo === 'terminada').resultado, 'sin-conexion');
  assert.equal(sent.filter((s) => s.payload.op === 'offer').length, 1, 'no salió ninguna offer de restart');
});

// --------------------------------------- v1.9.1: Metered TURN prioritario

test('fusionarIceServers: Metered primero, sin URLs duplicadas; sin Metered = base intacta', () => {
  const md = [
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: ['turn:global.relay.metered.ca:80', 'turn:global.relay.metered.ca:443', 'turns:global.relay.metered.ca:443?transport=tcp'],
      username: 'temporal', credential: 'temporal',
    },
    { urls: 'stun:stun.l.google.com:19302' }, // se solapa con un STUN de la base
  ];
  const m = fusionarIceServers(md);
  assert.equal(m.length, 5);
  assert.deepEqual(m[0], { urls: ['stun:stun.relay.metered.ca:80'] }, 'el STUN de Metered va primero (urls en string se normaliza)');
  assert.deepEqual(m[1], md[1], 'el TURN de Metered va segundo, tal cual');
  assert.deepEqual(m[2], { urls: ['stun:stun.l.google.com:19302'] }, 'la entrada solapada de Metered también queda, una sola vez');
  // La base conserva sus STUN menos el que Metered ya aportó:
  assert.deepEqual(m[3].urls, ['stun:stun.cloudflare.com:3478', 'stun:stunserver.stunprotocol.org:3478']);
  // Y OpenRelay público queda intacto, de respaldo:
  assert.deepEqual(m[4], iceServersConfig()[1]);
  const todas = m.flatMap((e) => e.urls);
  assert.equal(new Set(todas).size, todas.length, 'ninguna URL aparece dos veces');
  // Sin Metered (null / vacío / basura): EXACTAMENTE la config de siempre.
  assert.deepEqual(fusionarIceServers(null), iceServersConfig());
  assert.deepEqual(fusionarIceServers([]), iceServersConfig());
  assert.deepEqual(fusionarIceServers(undefined), iceServersConfig());
});

test('obtenerIceServers: fusiona lo de Metered; si falla o está apagado, la base exacta', async () => {
  const md = [{ urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'u', credential: 'c' }];
  const ok = await obtenerIceServers({ mdFn: async () => md });
  assert.deepEqual(ok[0], { urls: ['turns:global.relay.metered.ca:443?transport=tcp'], username: 'u', credential: 'c' },
    'lo de Metered va primero (urls en string se normaliza a array)');
  assert.deepEqual(ok.at(-1), iceServersConfig()[1], 'OpenRelay sigue de respaldo');
  // Metered que lanza (red caída): respaldo idéntico al actual, sin lanzar.
  const sinRed = await obtenerIceServers({ mdFn: async () => { throw new Error('sin red'); } });
  assert.deepEqual(sinRed, iceServersConfig());
  // Metered desactivado (null): lo mismo.
  const apagado = await obtenerIceServers({ mdFn: async () => null });
  assert.deepEqual(apagado, iceServersConfig());
});

test('sesión: la config del proveedor llega a la fábrica del pc al llamar y al contestar', async () => {
  const CFG = [{ urls: ['turns:global.relay.metered.ca:443?transport=tcp'], username: 'u', credential: 'c' }];
  // Al llamar:
  let cfgA = null;
  const a = mkSession({
    getIceServers: async () => CFG,
    createPC: (cfg) => { cfgA = cfg; return new FakePC(); },
  });
  assert.equal(await a.ses.llamar('peerPK', 'audio'), true);
  assert.deepEqual(cfgA, CFG, 'createPC recibió la config del proveedor');
  // Al contestar:
  let cfgB = null;
  const b = mkSession({
    getIceServers: async () => CFG,
    createPC: (cfg) => { cfgB = cfg; return new FakePC(); },
  });
  await b.ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: 'call-aaaaaaaabbbbbbbb', op: 'offer', media: 'audio', sdp: 'SDP' })));
  assert.equal(await b.ses.aceptar(), true);
  assert.deepEqual(cfgB, CFG, 'también en el lado que contesta');
});

test('sesión: sin proveedor inyectado y con Metered apagado (placeholders), el pc nace con la config de siempre', async () => {
  let cfgNacimiento = null;
  const { ses } = mkSession({ createPC: (cfg) => { cfgNacimiento = cfg; return new FakePC(); } });
  assert.equal(await ses.llamar('peerPK', 'audio'), true);
  assert.deepEqual(cfgNacimiento, iceServersConfig(), 'el proveedor por defecto cae a la base exacta');
});

test('sesión: proveedor ICE que lanza o devuelve vacío → respaldo a la config base', async () => {
  let cfg1 = null;
  const a = mkSession({
    getIceServers: async () => { throw new Error('proveedor roto'); },
    createPC: (cfg) => { cfg1 = cfg; return new FakePC(); },
  });
  assert.equal(await a.ses.llamar('peerPK', 'audio'), true, 'la llamada no depende del proveedor');
  assert.deepEqual(cfg1, iceServersConfig());
  let cfg2 = null;
  const b = mkSession({
    getIceServers: async () => null,
    createPC: (cfg) => { cfg2 = cfg; return new FakePC(); },
  });
  assert.equal(await b.ses.llamar('peerPK', 'audio'), true);
  assert.deepEqual(cfg2, iceServersConfig());
});

test('sesión: el restart pide la config de nuevo y la aplica con setConfiguration antes de renegociar', async () => {
  const CFG_A = [{ urls: ['stun:stun-a.ejemplo:3478'] }];
  const CFG_B = [{ urls: ['turns:turn-b.ejemplo:443'], username: 'u2', credential: 'c2' }];
  let pedidos = 0; let cfgCreacion = null; let pcRef = null;
  const { ses, sent } = mkSession({
    getIceServers: async () => (++pedidos === 1 ? CFG_A : CFG_B),
    createPC: (cfg) => { cfgCreacion = cfg; pcRef = new FakePC(); return pcRef; },
  });
  await ses.llamar('peerPK', 'audio');
  assert.deepEqual(cfgCreacion, CFG_A, 'el pc nació con la primera config');
  await ses.recibir('peerPK', parseCallPayload(JSON.stringify({ t: 'call', v: 1, id: ID, op: 'answer', media: 'audio', sdp: 'SDP-ANSWER' })));
  ses.pc.setIceState('failed'); // primer fallo en conectando → restart
  await tick();
  assert.equal(pedidos, 2, 'el restart volvió a pedir la configuración');
  assert.deepEqual(pcRef.configurations, [{ iceServers: CFG_B }], 'setConfiguration aplicó la config refrescada');
  assert.ok(sent.some((s) => s.payload.op === 'offer' && s.payload.restart), 'la renegociación salió con la config nueva');
  ses.pc.setConnState('connected');
  assert.equal(ses.state, 'conectada');
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

// ------------------------------------------------- fix v1.8.1: fantasmas

async function offerEvent(id, createdAt, fromSk = skA, toPk = pkB) {
  const payload = { t: 'call', v: 1, id, op: 'offer', media: 'audio', sdp: 'SDP-DE-A' };
  return finalizeEvent({
    kind: KIND_CALL, created_at: createdAt,
    tags: [['p', toPk]], content: await nip04.encrypt(fromSk, toPk, JSON.stringify(payload)),
  }, fromSk);
}

test('smoke: offer VIEJA reproducida por un relay (created_at de hace 1 h) no suena', async () => {
  prepararChat(0, { apodo: 'Ana', videoOk: true });
  T.setCallDeps({
    send: async () => {},
    createPC: () => new FakePC(),
    getLocalStream: async (media) => new FakeStream(media),
  });
  T.stopCalls(); T.startCalls();
  const haceUnaHora = Math.floor(Date.now() / 1000) - 3600;
  const ev = await offerEvent('call-7777777788888888', haceUnaHora);
  await T.handleCallSignalEvent(JSON.parse(JSON.stringify(ev)));
  assert.equal(document.getElementById('call-overlay'), null, 'la offer fantasma no abrió overlay');
  T.stopCalls();
});

test('smoke: la misma offer entregada dos veces (multi-relay) suena una vez y no manda "ocupado"', async () => {
  prepararChat(0, { apodo: 'Ana', videoOk: true });
  const captured = [];
  T.setCallDeps({
    send: async (peer, payload) => { captured.push({ peer, payload }); },
    createPC: () => new FakePC(),
    getLocalStream: async (media) => new FakeStream(media),
  });
  T.stopCalls(); T.startCalls();
  const ev = await offerEvent('call-1212121234343434', Math.floor(Date.now() / 1000));
  const evJson = JSON.parse(JSON.stringify(ev));
  await T.handleCallSignalEvent(evJson);
  assert.ok(document.getElementById('call-overlay'), 'la primera entrega sí suena');
  await T.handleCallSignalEvent(evJson); // el segundo relay la trae otra vez
  assert.ok(document.getElementById('call-overlay'), 'sigue sonando la misma llamada');
  const ocupado = captured.find((c) => c.payload.op === 'reject' && c.payload.motivo === 'ocupado');
  assert.equal(ocupado, undefined, 'el duplicado NO generó un reject "ocupado" al llamante');
  document.querySelector('[data-call="rechazar"]').click();
  await wait(30);
  T.stopCalls();
});

test('smoke: mi PROPIA offer (autor = yo) jamás me suena como entrante', async () => {
  const s = prepararChat(0, { apodo: 'Ana', videoOk: true });
  T.setCallDeps({
    send: async () => {},
    createPC: () => new FakePC(),
    getLocalStream: async (media) => new FakeStream(media),
  });
  T.stopCalls(); T.startCalls();
  // Evento firmado por MÍ (skB = mi clave en esta sesión de test):
  // un relay me lo reentrega como si fuera entrante.
  const ev = await offerEvent('call-9999000011112222', Math.floor(Date.now() / 1000), skB, pkA);
  await T.handleCallSignalEvent(JSON.parse(JSON.stringify(ev)));
  assert.equal(document.getElementById('call-overlay'), null, 'mi propia señalización no me suena');
  T.stopCalls();
});
