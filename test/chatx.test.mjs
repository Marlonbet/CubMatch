// v1.6.0: ubicación y stickers en el chat (chatx.js + integración en app.js).
// - Payloads especiales de DM: {"t":"loc",...} y {"t":"sticker",...},
//   con validación estricta (un JSON hostil cae a texto plano).
// - Biblioteca de stickers: local, por cuenta, sobre un storage
//   inyectable; dedup, tope y borrado.
// - Preparación de stickers: sin recompresión JPEG (alfa intacto).
// - Smoke jsdom: el chat renderiza la tarjeta de ubicación (OSM) y el
//   sticker, el panel abre, se envía un sticker y se sube uno nuevo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  buildLocPayload, buildStickerPayload, parseChatPayload, osmUrl, geoErrorTexto,
  stickerOutType, planSticker, stickerPesoOk, prepareStickerBlob,
  stickerStorageKey, loadStickers, addSticker, removeSticker,
  MAX_STICKER_BYTES, MAX_STICKERS, MAX_STICKER_LADO,
} from '../src/chatx.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- payloads ----------

test('buildLocPayload: JSON con redondeo a 6 decimales', () => {
  const s = buildLocPayload(23.1135924, -82.3665937);
  assert.deepEqual(JSON.parse(s), { t: 'loc', lat: 23.113592, lon: -82.366594 });
});

test('buildLocPayload: rechaza coordenadas fuera de rango o no numéricas', () => {
  assert.throws(() => buildLocPayload(90.0001, 0));
  assert.throws(() => buildLocPayload(0, -180.5));
  assert.throws(() => buildLocPayload(NaN, 0));
  assert.throws(() => buildLocPayload('23.1', -82.3));
  assert.throws(() => buildLocPayload(undefined, undefined));
  // los bordes exactos sí valen
  assert.deepEqual(JSON.parse(buildLocPayload(90, 180)), { t: 'loc', lat: 90, lon: 180 });
  assert.deepEqual(JSON.parse(buildLocPayload(-90, -180)), { t: 'loc', lat: -90, lon: -180 });
});

test('buildStickerPayload: solo URLs http(s)', () => {
  assert.deepEqual(JSON.parse(buildStickerPayload('https://cdn.hzrd149.com/a.webp')),
    { t: 'sticker', url: 'https://cdn.hzrd149.com/a.webp' });
  assert.throws(() => buildStickerPayload('javascript:alert(1)'));
  assert.throws(() => buildStickerPayload('ftp://x/a.webp'));
  assert.throws(() => buildStickerPayload(''));
  assert.throws(() => buildStickerPayload(42));
});

test('parseChatPayload: reconoce loc y sticker válidos', () => {
  assert.deepEqual(parseChatPayload('{"t":"loc","lat":23.11,"lon":-82.36}'),
    { tipo: 'loc', lat: 23.11, lon: -82.36 });
  assert.deepEqual(parseChatPayload('  {"t":"sticker","url":"https://x.test/s.png"}  '),
    { tipo: 'sticker', url: 'https://x.test/s.png' });
  assert.deepEqual(parseChatPayload(buildLocPayload(1, 2)), { tipo: 'loc', lat: 1, lon: 2 });
  assert.deepEqual(parseChatPayload(buildStickerPayload('http://x.test/s.webp')),
    { tipo: 'sticker', url: 'http://x.test/s.webp' });
});

test('parseChatPayload: lo demás es texto plano (null), sin lanzar', () => {
  assert.equal(parseChatPayload('hola, ¿qué tal?'), null);
  assert.equal(parseChatPayload('{roto'), null);
  assert.equal(parseChatPayload('{"t":"loc","lat":999,"lon":0}'), null, 'lat fuera de rango');
  assert.equal(parseChatPayload('{"t":"loc","lat":"23.1","lon":-82.3}'), null, 'lat como string');
  assert.equal(parseChatPayload('{"t":"loc","lat":23.1}'), null, 'falta lon');
  assert.equal(parseChatPayload('{"t":"sticker","url":"javascript:alert(1)"}'), null);
  assert.equal(parseChatPayload('{"t":"sticker"}'), null);
  assert.equal(parseChatPayload('{"t":"video","url":"https://x.test/v.mp4"}'), null);
  assert.equal(parseChatPayload('[1,2,3]'), null);
  assert.equal(parseChatPayload('{}'), null);
  assert.equal(parseChatPayload(null), null);
  assert.equal(parseChatPayload(42), null);
  assert.equal(parseChatPayload(undefined), null);
});

test('osmUrl: enlace a OpenStreetMap con marcador y zoom 16', () => {
  assert.equal(
    osmUrl(23.1136, -82.3666),
    'https://www.openstreetmap.org/?mlat=23.1136&mlon=-82.3666#map=16/23.1136/-82.3666'
  );
});

test('geoErrorTexto: mensajes claros por código de error', () => {
  assert.match(geoErrorTexto({ code: 1 }), /denegado/);
  assert.match(geoErrorTexto({ code: 2 }), /posición/);
  assert.match(geoErrorTexto({ code: 3 }), /tardó/);
  assert.match(geoErrorTexto({ code: 0 }), /No se pudo obtener/);
  assert.match(geoErrorTexto(undefined), /No se pudo obtener/);
  assert.match(geoErrorTexto(new Error('x')), /No se pudo obtener/);
});

// ---------- formato de sticker ----------

test('stickerOutType: WebP se conserva; el resto sale PNG (con alfa), nunca JPEG', () => {
  assert.equal(stickerOutType('image/webp'), 'image/webp');
  assert.equal(stickerOutType('IMAGE/WEBP'), 'image/webp');
  assert.equal(stickerOutType('image/png'), 'image/png');
  assert.equal(stickerOutType('image/jpeg'), 'image/png');
  assert.equal(stickerOutType('image/gif'), 'image/png');
  assert.equal(stickerOutType(''), 'image/png');
  assert.equal(stickerOutType(undefined), 'image/png');
});

test('planSticker: reduce solo si el lado mayor pasa de 512, con proporciones', () => {
  assert.deepEqual(planSticker(1024, 512, 'image/png'),
    { width: 512, height: 256, needsResize: true, outType: 'image/png' });
  assert.deepEqual(planSticker(300, 300, 'image/webp'),
    { width: 300, height: 300, needsResize: false, outType: 'image/webp' });
  assert.deepEqual(planSticker(512, 512, 'image/png'),
    { width: 512, height: 512, needsResize: false, outType: 'image/png' });
  const p = planSticker(2000, 100, 'image/webp');
  assert.equal(p.width, MAX_STICKER_LADO);
  assert.equal(p.height, 26);
  assert.equal(p.needsResize, true);
});

test('stickerPesoOk: tope de ~1 MB', () => {
  assert.equal(stickerPesoOk(MAX_STICKER_BYTES), true);
  assert.equal(stickerPesoOk(MAX_STICKER_BYTES + 1), false);
  assert.equal(stickerPesoOk(123), true);
  assert.equal(stickerPesoOk(NaN), false);
  assert.equal(stickerPesoOk(undefined), false);
});

test('prepareStickerBlob: sin decodificador devuelve el blob original intacto', async () => {
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  const out = await prepareStickerBlob(png);
  assert.equal(out, png, 'mismo blob: formato y alfa intactos, sin recompresión');
  const txt = new Blob(['hola'], { type: 'text/plain' });
  assert.equal(await prepareStickerBlob(txt), txt);
  assert.equal(await prepareStickerBlob(null), null);
});

// ---------- biblioteca ----------

// Storage en memoria con la misma semántica que el LS de la app
// (JSON ida y vuelta).
function memStore() {
  const data = {};
  return {
    data,
    get(k, def) {
      return Object.prototype.hasOwnProperty.call(data, k) ? JSON.parse(JSON.stringify(data[k])) : def;
    },
    set(k, v) { data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

test('biblioteca: añadir, orden (reciente primero), dedup y quitar', () => {
  const st = memStore();
  const pk = 'a'.repeat(64);
  assert.deepEqual(loadStickers(st, pk), []);
  assert.deepEqual(addSticker(st, pk, 'https://x.test/1.webp'), ['https://x.test/1.webp']);
  assert.deepEqual(addSticker(st, pk, 'https://x.test/2.webp'),
    ['https://x.test/2.webp', 'https://x.test/1.webp']);
  // duplicado: no se repite, pasa al frente
  assert.deepEqual(addSticker(st, pk, 'https://x.test/1.webp'),
    ['https://x.test/1.webp', 'https://x.test/2.webp']);
  assert.deepEqual(removeSticker(st, pk, 'https://x.test/1.webp'), ['https://x.test/2.webp']);
  assert.deepEqual(loadStickers(st, pk), ['https://x.test/2.webp']);
  assert.deepEqual(removeSticker(st, pk, 'https://x.test/no-está.webp'), ['https://x.test/2.webp']);
});

test('biblioteca: por cuenta (aislada) y URLs inválidas ignoradas', () => {
  const st = memStore();
  const pkA = 'a'.repeat(64), pkB = 'b'.repeat(64);
  addSticker(st, pkA, 'https://x.test/a.webp');
  assert.deepEqual(loadStickers(st, pkB), [], 'otra cuenta no ve mis stickers');
  assert.ok(stickerStorageKey(pkA).includes(pkA));
  assert.deepEqual(addSticker(st, pkA, 'javascript:alert(1)'), ['https://x.test/a.webp']);
  assert.deepEqual(addSticker(st, pkA, ''), ['https://x.test/a.webp']);
  assert.deepEqual(addSticker(st, pkA, 42), ['https://x.test/a.webp']);
});

test('biblioteca: loadStickers filtra basura guardada y respeta el tope', () => {
  const st = memStore();
  const pk = 'c'.repeat(64);
  st.set(stickerStorageKey(pk), ['https://x.test/ok.webp', 42, null, 'ftp://no', { url: 'x' }]);
  assert.deepEqual(loadStickers(st, pk), ['https://x.test/ok.webp']);
  st.set(stickerStorageKey(pk), 'no-es-un-array');
  assert.deepEqual(loadStickers(st, pk), []);
  for (let i = 0; i < MAX_STICKERS + 5; i++) addSticker(st, pk, 'https://x.test/' + i + '.webp');
  const list = loadStickers(st, pk);
  assert.equal(list.length, MAX_STICKERS);
  assert.equal(list[0], 'https://x.test/' + (MAX_STICKERS + 4) + '.webp', 'el reciente manda');
  assert.ok(!list.includes('https://x.test/0.webp'), 'los más viejos se caen');
});

// ---------- smoke jsdom: chat con ubicación y stickers ----------
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

await import('../src/app.js');
await wait(120); // boot automático del import
const T = window.__cubmatchApp._test;
assert.ok(T, 'hook _test expuesto');
const S = T.getS();

const skMe = generateSecretKey(); const pkMe = getPublicKey(skMe);
const skPeer = generateSecretKey(); const pkPeer = getPublicKey(skPeer);
const fakeSub = { eose: async () => {}, unsub() {} };
const dmEnviados = [];
S.sk = skMe;
S.pubkey = pkMe;
S.data = { likes: { sent: { [pkPeer]: { tipo: '+' } }, received: { [pkPeer]: { tipo: '+' } } } };
S.perfilCache.set(pkPeer, { profile: { apodo: 'Ana' }, pubkey: pkPeer, created_at: 1, id: 'x', addr: '' });
S.pool = {
  acquire() {}, release() {}, shutdown() {},
  roles: { discovery: [], messaging: [] },
  scopeDegraded: () => false,
  discovery: () => ({ subscribe: () => fakeSub }),
  messaging: () => ({ subscribe: () => fakeSub, sendReceipt() {} }),
  publishDM: async (peer, text) => { dmEnviados.push(text); return { event: { id: 'dm-' + dmEnviados.length } }; },
};

const ahora = Date.now();
localStorage.setItem('cubmatch_chats', JSON.stringify({
  [pkPeer]: [
    { id: 'm1', from: 'peer', ts: ahora - 4000, text: '¡Hola!', read: true },
    { id: 'm2', from: 'peer', ts: ahora - 3000, text: '{"t":"loc","lat":23.1136,"lon":-82.3666}', read: true },
    { id: 'm3', from: 'me', ts: ahora - 2000, text: '{"t":"sticker","url":"https://cdn.hzrd149.com/st1.webp"}', read: true },
    { id: 'm4', from: 'peer', ts: ahora - 1000, text: '{"t":"loc","lat":999,"lon":0}', read: true },
  ],
}));
localStorage.setItem('cubmatch_stickers:' + pkMe, JSON.stringify(['https://cdn.hzrd149.com/mio.webp']));

test('smoke: el chat renderiza texto, tarjeta de ubicación (OSM) y sticker', () => {
  T.showChat(pkPeer);
  // botones nuevos junto al input
  assert.ok(document.querySelector('[data-act="chat-loc"]'), 'botón 📍 de ubicación');
  assert.ok(document.querySelector('[data-act="chat-stickers"]'), 'botón de stickers');
  assert.ok(document.querySelector('#chat-input'), 'el input de texto sigue');
  const html = document.querySelector('#chat-msgs').innerHTML;
  assert.match(html, /¡Hola!/, 'el texto normal se renderiza como siempre');
  assert.equal((html.match(/openstreetmap\.org/g) || []).length, 1, 'solo la ubicación válida enlaza al mapa');
  assert.match(html, /Ubicación compartida/);
  assert.match(html, /mlat=23\.1136/);
  assert.match(html, /<img class="msg-sticker" src="https:\/\/cdn\.hzrd149\.com\/st1\.webp"/, 'el sticker es una imagen');
  assert.ok(html.includes('999'), 'el JSON hostil cae a texto plano, no a tarjeta');
});

test('smoke: sin geolocalización, el botón 📍 avisa con un toast claro', () => {
  document.querySelector('[data-act="chat-loc"]').click();
  const toasts = document.querySelector('#toasts');
  assert.ok(toasts && /geolocalización/.test(toasts.textContent),
    'toast: el navegador no tiene geolocalización');
  assert.equal(document.querySelector('#loc-overlay'), null, 'sin geo no se abre la confirmación');
});

test('smoke: el panel de stickers abre, lista la biblioteca y envía un sticker', async () => {
  document.querySelector('[data-act="chat-stickers"]').click();
  const panel = document.querySelector('#sticker-panel');
  assert.equal(panel.hidden, false, 'el panel se abre');
  assert.match(panel.textContent, /Mis stickers/);
  assert.match(panel.textContent, /WhatsApp/, 'copia honesta sobre importar de WhatsApp');
  assert.match(panel.textContent, /Añadir desde la galería/);
  const fileInput = panel.querySelector('#sticker-file');
  assert.ok(fileInput && fileInput.type === 'file' && fileInput.accept === 'image/*');
  const btn = panel.querySelector('[data-act="sticker-send"]');
  assert.ok(btn, 'mi sticker guardado aparece en la cuadrícula');
  btn.click();
  await wait(300);
  const chat = S.chats[pkPeer];
  const ultimo = chat[chat.length - 1];
  assert.deepEqual(JSON.parse(ultimo.text), { t: 'sticker', url: 'https://cdn.hzrd149.com/mio.webp' });
  assert.equal(ultimo.from, 'me');
  assert.equal(dmEnviados[dmEnviados.length - 1], ultimo.text, 'el DM salió con el payload');
  assert.equal(panel.hidden, true, 'el panel se cierra al enviar');
  const imgs = document.querySelectorAll('#chat-msgs img.msg-sticker');
  assert.equal(imgs.length, 2, 'el sticker enviado se pinta en el chat');
});

test('smoke: añadir un sticker lo sube a Blossom y queda en la biblioteca', async () => {
  const llamadas = [];
  globalThis.fetch = async (url, opts) => {
    llamadas.push({ url, opts });
    return { ok: true, status: 201, json: async () => ({ url: 'https://cdn.hzrd149.com/nuevo.webp' }) };
  };
  try {
    document.querySelector('[data-act="chat-stickers"]').click(); // reabrir el panel
    const panel = document.querySelector('#sticker-panel');
    const fileInput = panel.querySelector('#sticker-file');
    const file = new dom.window.File([new Uint8Array([137, 80, 78, 71])], 'sticker.webp', { type: 'image/webp' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      await wait(100);
      const guardados = JSON.parse(localStorage.getItem('cubmatch_stickers:' + pkMe) || '[]');
      ok = guardados.includes('https://cdn.hzrd149.com/nuevo.webp');
    }
    assert.ok(ok, 'la URL subida quedó guardada en mi biblioteca');
    assert.ok(llamadas.some((c) => String(c.url).includes('/upload')), 'hubo subida a Blossom');
    assert.match(panel.textContent, /¡Sticker añadido!/, 'el panel confirma la subida');
    assert.ok(panel.querySelector('img[src="https://cdn.hzrd149.com/nuevo.webp"]'), 'el sticker nuevo está en la cuadrícula');
  } finally {
    delete globalThis.fetch;
  }
});

test('smoke: con geolocalización, la confirmación nombra al peer y al aceptar se envía la ubicación', async () => {
  let stubOk = false;
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { geolocation: { getCurrentPosition: (okCb) => okCb({ coords: { latitude: 23.1135924, longitude: -82.3665937 } }) } },
      configurable: true, writable: true,
    });
    stubOk = typeof navigator !== 'undefined' && !!navigator.geolocation;
  } catch { stubOk = false; }
  assert.ok(stubOk, 'stub de geolocalización instalado');

  document.querySelector('[data-act="chat-loc"]').click();
  const ov = document.querySelector('#loc-overlay');
  assert.ok(ov, 'se abre la confirmación dentro de la app');
  assert.match(ov.textContent, /Ana/, 'la confirmación nombra al destinatario');
  assert.match(ov.textContent, /ubicación actual/, 'aclara que es una sola vez, no seguimiento');
  assert.match(ov.textContent, /dónde vives/, 'advierte que puede revelar dónde vives');

  ov.querySelector('[data-act="chat-loc-si"]').click();
  await wait(300);
  assert.equal(document.querySelector('#loc-overlay'), null, 'la confirmación se cierra');
  const chat = S.chats[pkPeer];
  const ultimo = chat[chat.length - 1];
  assert.deepEqual(JSON.parse(ultimo.text), { t: 'loc', lat: 23.113592, lon: -82.366594 });
  assert.equal(dmEnviados[dmEnviados.length - 1], ultimo.text, 'el DM salió con el payload de ubicación');
  const html = document.querySelector('#chat-msgs').innerHTML;
  assert.match(html, /mlat=23\.113592/, 'la ubicación enviada se pinta como tarjeta con enlace a OSM');

  dom.window.close();
});
