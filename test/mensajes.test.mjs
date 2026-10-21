// v1.8.0 — mensajes optimistas con estados (mensajes.js) y
// reorganización del chat:
// - Puro: estadoVisible / fusionarMensajes (dedup por id, el eco
//   adopta el id del optimista, se conserva el estado más avanzado) /
//   marcarColgados.
// - Smoke jsdom: cabecera sin Reportar/Bloquear (quedan en la
//   pantalla de perfil del match), envío que se pinta al instante en
//   'enviando' y pasa a 'enviado' sin duplicarse con el eco, fallo →
//   "No enviado" → reintento que funciona, presencia en la cabecera.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import {
  estadoVisible, estadoNormalizado, fusionarMensajes, marcarColgados, esTmpId,
} from '../src/mensajes.js';

// ---------------- lógica pura: estados ----------------
test('estadoVisible: cada estado sale de su señal', () => {
  assert.equal(estadoVisible({ from: 'peer', read: false }), null, 'del otro: sin tick');
  assert.equal(estadoVisible({ from: 'me', tipo: 'call', read: true }), null, 'registros de llamada: sin tick');
  assert.equal(estadoVisible({ from: 'me', read: true, estado: 'enviado' }), 'visto', 'receipt → visto');
  assert.equal(estadoVisible({ from: 'me', read: true, estado: 'error' }), 'visto', 'el receipt manda sobre el error local');
  assert.equal(estadoVisible({ from: 'me', read: false, estado: 'error' }), 'error');
  assert.equal(estadoVisible({ from: 'me', read: false, estado: 'enviado' }), 'enviado');
  assert.equal(estadoVisible({ from: 'me', read: false, estado: 'enviando' }), 'enviando');
  assert.equal(estadoVisible({ from: 'me', read: false }), 'enviado', 'legado sin campo: se publicó/importó');
  assert.equal(estadoNormalizado({ from: 'peer' }), null);
});

// ---------------- lógica pura: fusión ----------------
const msg = (over) => ({ id: 'x', from: 'me', ts: 1000, text: 'hola', read: false, ...over });

test('fusionarMensajes: inserta ordenado por ts y deduplica por id', () => {
  const lista = [];
  fusionarMensajes(lista, msg({ id: 'b', ts: 2000 }));
  fusionarMensajes(lista, msg({ id: 'a', ts: 1000 }));
  assert.deepEqual(lista.map((m) => m.id), ['a', 'b']);
  fusionarMensajes(lista, msg({ id: 'a', ts: 1000, read: true }));
  assert.equal(lista.length, 2, 'mismo id no duplica');
  assert.equal(lista[0].read, true, 'read es OR');
});

test('fusionarMensajes: el estado más avanzado manda', () => {
  const lista = [msg({ id: 'e1', estado: 'enviando' })];
  fusionarMensajes(lista, msg({ id: 'e1', estado: 'enviado', ts: 9999 }));
  assert.equal(lista[0].estado, 'enviado');
  assert.equal(lista[0].ts, 1000, 'se conserva el ts del envío, no el del eco');
  fusionarMensajes(lista, msg({ id: 'e1', estado: 'enviando' }));
  assert.equal(lista[0].estado, 'enviado', 'un eco viejo no degrada el estado');
  const l2 = [msg({ id: 'e2', estado: 'error' })];
  fusionarMensajes(l2, msg({ id: 'e2', estado: 'enviado' }));
  assert.equal(l2[0].estado, 'enviado', 'si el eco llega, el "error" era falso: sí se publicó');
});

test('fusionarMensajes: el eco adopta el id del optimista sin duplicar', () => {
  const lista = [msg({ id: 'tmp:1', estado: 'enviando', ts: 5000 })];
  fusionarMensajes(lista, msg({ id: 'real-1', estado: 'enviado', ts: 4999 }));
  assert.equal(lista.length, 1);
  assert.equal(lista[0].id, 'real-1');
  assert.equal(lista[0].estado, 'enviado');
  assert.equal(lista[0].ts, 5000, 'manda el momento en que el usuario lo envió');
  assert.ok(esTmpId('tmp:1') && !esTmpId('real-1'));
});

test('fusionarMensajes: un entrante tmp NO adopta sobre otro tmp (dos envíos iguales)', () => {
  const lista = [msg({ id: 'tmp:1', estado: 'enviando', ts: 5000 })];
  fusionarMensajes(lista, msg({ id: 'tmp:2', estado: 'enviando', ts: 6000 }));
  assert.equal(lista.length, 2, 'el segundo envío idéntico es otro mensaje');
  // y un eco con texto distinto no adopta nada
  const l2 = [msg({ id: 'tmp:9', estado: 'enviando', text: 'hola' })];
  fusionarMensajes(l2, msg({ id: 'real-9', estado: 'enviado', text: 'otra cosa' }));
  assert.equal(l2.length, 2);
  assert.equal(l2[0].id, 'tmp:9');
});

test('marcarColgados: el enviando viejo pasa a error; el resto no se toca', () => {
  const ahora = 1_000_000;
  const lista = [
    msg({ id: 'a', estado: 'enviando', ts: ahora - 120_000 }),
    msg({ id: 'b', estado: 'enviando', ts: ahora - 10_000 }),
    msg({ id: 'c', estado: 'enviado', ts: ahora - 120_000 }),
    msg({ id: 'd', from: 'peer', estado: 'enviando', ts: ahora - 120_000 }),
    msg({ id: 'e', tipo: 'call', estado: 'enviando', ts: ahora - 120_000 }),
  ];
  assert.equal(marcarColgados(lista, ahora), 1);
  assert.equal(lista[0].estado, 'error');
  assert.equal(lista[1].estado, 'enviando', 'el reciente sigue en curso');
});

// ---------------- smoke jsdom ----------------
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

await import('../src/app.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(120); // boot automático del import
const T = window.__cubmatchApp._test;
assert.ok(T, 'hook _test expuesto');
const S = T.getS();

const skMe = generateSecretKey(); const pkMe = getPublicKey(skMe);
const skPeer = generateSecretKey(); const pkPeer = getPublicKey(skPeer);
const secs = () => Math.floor(Date.now() / 1000);
const wire = (ev) => JSON.parse(JSON.stringify(ev));

let publishImpl = async () => ({ event: { id: 'sin-uso' } });
const subsCapturadas = [];
const fakeSub = { eose: async () => {}, unsub() {} };
const clientFake = {
  subscribe: (filters, cb) => { subsCapturadas.push({ filters, cb }); return fakeSub; },
  sendReceipt() {},
  decryptDM: async () => 'hola',
  publish: async () => ({}),
};
S.sk = skMe;
S.pubkey = pkMe;
S.data = { likes: { sent: { [pkPeer]: { tipo: '+' } }, received: { [pkPeer]: { tipo: '+' } } } };
S.perfilCache.set(pkPeer, {
  profile: {
    apodo: 'Ana', edad: 25, provincia: 'La Habana', municipio: 'Playa',
    bio: 'Bio de prueba', intereses: ['playa', 'música'], valores: ['familia'],
    tresPalabras: 'sol, mar, calma', rasgos: { extroversion: 4 },
  },
  pubkey: pkPeer, created_at: 1, id: 'x', addr: '',
});
S.pool = {
  acquire() {}, release() {}, shutdown() {},
  roles: { discovery: [], messaging: [] },
  scopeDegraded: () => false,
  discovery: () => clientFake,
  messaging: () => clientFake,
  publishDM: (peer, text) => publishImpl(peer, text),
};
localStorage.removeItem('cubmatch_chats');

test('smoke: cabecera del chat sin desborde: solo volver, peer tocable y llamadas', () => {
  T.showChat(pkPeer);
  const head = document.querySelector('.chat-head');
  assert.ok(head, 'hay cabecera');
  assert.equal(head.querySelector('[data-act="chat-reportar"]'), null, 'Reportar salió de la cabecera');
  assert.equal(head.querySelector('[data-act="chat-bloquear"]'), null, 'Bloquear salió de la cabecera');
  assert.ok(head.querySelector('[data-act="chat-call-voz"]'), 'voz se queda');
  assert.ok(head.querySelector('[data-act="chat-call-video"]'), 'video se queda');
  const peerBtn = head.querySelector('[data-act="chat-ver-perfil"]');
  assert.ok(peerBtn, 'avatar+apodo son un botón al perfil');
  assert.match(peerBtn.textContent, /Ana/);
  assert.ok(peerBtn.querySelector('#chat-presencia'), 'línea de presencia bajo el apodo');
  // Sin layout real en jsdom: la garantía anti-desborde son las reglas
  // CSS (flex con min-width:0 y recorte con …, acciones sin encoger).
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-peer\s*{[^}]*min-width:\s*0/, 'el bloque del peer puede encogerse');
  assert.match(css, /\.chat-acts\s*{[^}]*flex-shrink:\s*0/, 'las llamadas nunca se encogen');
  assert.match(css, /\.chat-peer-txt\s*{[^}]*min-width:\s*0/, 'el texto puede recortarse');
});

test('smoke: pantalla de perfil del match con características y Bloquear/Reportar', async () => {
  document.querySelector('[data-act="chat-ver-perfil"]').click();
  assert.equal(S.screen, 'chatperfil');
  const html = document.querySelector('#app').innerHTML;
  assert.match(html, /Bio de prueba/, 'la bio se ve');
  assert.match(html, /playa/, 'los intereses se ven');
  assert.match(html, /Ana, 25/, 'nombre y edad');
  assert.ok(document.querySelector('[data-act="perfil-bloquear"]'), 'Bloquear vive aquí');
  assert.ok(document.querySelector('[data-act="perfil-reportar"]'), 'Reportar vive aquí');
  assert.ok(document.querySelector('#chatperfil-presencia'), 'presencia también aquí');
  document.querySelector('[data-act="chatperfil-volver"]').click();
  await wait(30);
  assert.ok(document.querySelector('#chat-form'), 'volver regresa al chat');
  assert.equal(S.screen, 'chat');
});

test('smoke: presencia — beacon enciende "En línea"; off y caducidad dan última vez', async () => {
  const el = document.querySelector('#chat-presencia');
  assert.equal(el.textContent, '', 'sin datos no se afirma nada');
  const bOn = finalizeEvent({ kind: 21005, created_at: secs(), tags: [], content: '' }, skPeer);
  await T.handleBeaconEvent(wire(bOn));
  assert.equal(el.textContent, 'En línea');
  assert.ok(el.classList.contains('on'), 'punto/estilo de en línea');
  assert.deepEqual(S.presencia[pkPeer].off, false);
  const bOff = finalizeEvent({ kind: 21005, created_at: secs(), tags: [], content: 'off' }, skPeer);
  await T.handleBeaconEvent(wire(bOff));
  assert.equal(el.textContent, 'Últ. vez hace un momento');
  assert.ok(!el.classList.contains('on'));
  S.presencia[pkPeer] = { ts: Date.now() - 3 * 3600_000, off: false };
  T.pintarPresencia();
  assert.equal(el.textContent, 'Últ. vez hace 3 h');
  // un beacon manipulado no enciende nada (C1 también en presencia)
  const malo = wire({ ...finalizeEvent({ kind: 21005, created_at: secs(), tags: [], content: '' }, skPeer), content: 'off' });
  const antes = S.presencia[pkPeer];
  await T.handleBeaconEvent(malo);
  assert.equal(S.presencia[pkPeer], antes, 'firma inválida: descartado');
});

test('smoke: enviar pinta al instante (enviando → enviado) y el eco no duplica', async () => {
  const evReal = finalizeEvent({ kind: 4, created_at: secs(), tags: [['p', pkPeer]], content: 'cifrado' }, skMe);
  let resolver;
  publishImpl = () => new Promise((r) => { resolver = () => r({ event: evReal }); });
  const input = document.querySelector('#chat-input');
  input.value = 'hola';
  document.querySelector('#chat-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(40);
  const chat = () => S.chats[pkPeer] || [];
  const mios = chat().filter((m) => m.text === 'hola');
  assert.equal(mios.length, 1, 'el mensaje ya está en el chat');
  assert.equal(mios[0].estado, 'enviando', 'aún sin confirmación: enviando');
  assert.match(document.querySelector('#chat-msgs').innerHTML, /🕐/, 'se pinta el reloj');
  assert.equal(input.value, '', 'el input se vació al enviar');
  resolver();
  await wait(40);
  assert.equal(mios[0].estado, 'enviado', 'publicación confirmada: enviado');
  assert.equal(mios[0].id, evReal.id, 'adoptó el id real del evento');
  assert.equal(document.querySelector('#chat-msgs .tick').textContent, '✓');
  // el eco por la suscripción en vivo no duplica ni degrada
  const subDM = subsCapturadas.find((s) => s.filters.some((f) => (f.kinds || []).includes(4) && f.since !== undefined));
  assert.ok(subDM, 'suscripción en vivo de DMs capturada');
  await subDM.cb(wire(evReal));
  await wait(40);
  assert.equal(chat().filter((m) => m.text === 'hola').length, 1, 'el eco no duplicó');
  assert.equal(chat().find((m) => m.text === 'hola').estado, 'enviado');
});

test('smoke: si la publicación falla queda "No enviado" y el reintento funciona', async () => {
  publishImpl = async () => { throw new Error('sin relays'); };
  const input = document.querySelector('#chat-input');
  input.value = 'segundo';
  document.querySelector('#chat-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await wait(60);
  const chat = () => S.chats[pkPeer] || [];
  const m = chat().find((x) => x.text === 'segundo');
  assert.ok(m, 'el mensaje fallido SIGUE visible en el chat');
  assert.equal(m.estado, 'error');
  assert.equal(input.value, '', 'el texto no vuelve al input');
  const btn = document.querySelector('[data-act="chat-reintentar"]');
  assert.ok(btn, 'línea de reintento visible');
  assert.match(btn.textContent, /No enviado/);
  const evReal2 = finalizeEvent({ kind: 4, created_at: secs(), tags: [['p', pkPeer]], content: 'cifrado2' }, skMe);
  publishImpl = async () => ({ event: evReal2 });
  btn.click();
  await wait(60);
  assert.equal(m.estado, 'enviado', 'el reintento lo envió');
  assert.equal(m.id, evReal2.id);
  assert.equal(document.querySelector('[data-act="chat-reintentar"]'), null, 'la línea de error desaparece');
  dom.window.close();
});
