// Tests de la subida de foto desde la galería (v1.5.0):
// - auth Blossom BUD-02 (kind 24242, tags, expiración, cabecera)
// - parseo de la respuesta del servidor (url directa y NIP-94)
// - dimensiones al comprimir (lado mayor 1024)
// - flujo de subida con fetch mockeado (primario, fallback, espejo, error)
// - smoke jsdom: el botón y el input existen en el paso 7 y el flujo
//   completo rellena la URL del perfil.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import {
  BLOSSOM_SERVERS, KIND_BLOSSOM_AUTH, AUTH_EXPIRATION_SEGS, MAX_FOTO_LADO,
  buildBlossomAuth, signBlossomAuth, blossomAuthHeader, b64EncodeBytes,
  parseBlossomResponse, targetDimensions, sha256Hex,
  uploadPhoto, uploadToBlossom, preparePhotoBlob,
} from '../src/foto.js';
import { newProfile } from '../src/perfil.js';

const NOW = 1700000000;
const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

// ---------- sha256Hex ----------
test('sha256Hex: vectores conocidos', () => {
  assert.equal(sha256Hex(new TextEncoder().encode('abc')), SHA_ABC);
  assert.equal(sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

// ---------- b64EncodeBytes ----------
test('b64EncodeBytes: vectores RFC 4648', () => {
  const enc = new TextEncoder();
  assert.equal(b64EncodeBytes(enc.encode('')), '');
  assert.equal(b64EncodeBytes(enc.encode('f')), 'Zg==');
  assert.equal(b64EncodeBytes(enc.encode('fo')), 'Zm8=');
  assert.equal(b64EncodeBytes(enc.encode('foo')), 'Zm9v');
  assert.equal(b64EncodeBytes(enc.encode('foob')), 'Zm9vYg==');
  assert.equal(b64EncodeBytes(enc.encode('foobar')), 'Zm9vYmFy');
});

// ---------- buildBlossomAuth ----------
test('buildBlossomAuth: kind, tags y expiración BUD-02', () => {
  const tpl = buildBlossomAuth({ sha256: SHA_ABC, now: NOW });
  assert.equal(tpl.kind, 24242);
  assert.equal(tpl.kind, KIND_BLOSSOM_AUTH);
  assert.equal(tpl.created_at, NOW);
  assert.deepEqual(tpl.tags, [
    ['t', 'upload'],
    ['x', SHA_ABC],
    ['expiration', String(NOW + AUTH_EXPIRATION_SEGS)],
  ]);
  assert.equal(typeof tpl.content, 'string');
  assert.ok(tpl.content.length > 0);
});

test('buildBlossomAuth: expiración personalizable', () => {
  const tpl = buildBlossomAuth({ sha256: SHA_ABC, now: NOW, expirationSegs: 60 });
  assert.equal(tpl.tags[2][1], String(NOW + 60));
});

// ---------- signBlossomAuth + cabecera ----------
test('signBlossomAuth: evento firmado y verificable por la identidad', () => {
  const sk = generateSecretKey();
  const ev = signBlossomAuth(sk, SHA_ABC, NOW);
  assert.equal(ev.pubkey, getPublicKey(sk));
  assert.equal(ev.kind, 24242);
  assert.equal(verifyEvent(ev), true);
  assert.deepEqual(ev.tags.find((t) => t[0] === 'x'), ['x', SHA_ABC]);
});

test('blossomAuthHeader: "Nostr " + base64 del evento firmado', () => {
  const sk = generateSecretKey();
  const ev = signBlossomAuth(sk, SHA_ABC, NOW);
  const header = blossomAuthHeader(ev);
  assert.ok(header.startsWith('Nostr '));
  const decoded = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'));
  assert.equal(decoded.id, ev.id);
  assert.equal(decoded.sig, ev.sig);
  assert.equal(decoded.kind, 24242);
});

// ---------- parseBlossomResponse ----------
test('parseBlossomResponse: URL directa', () => {
  assert.equal(
    parseBlossomResponse({ url: 'https://nostr.download/abc.jpg', sha256: SHA_ABC }),
    'https://nostr.download/abc.jpg'
  );
});

test('parseBlossomResponse: URL dentro del evento NIP-94', () => {
  const json = {
    nip94_event: {
      kind: 1063,
      tags: [['url', 'https://cdn.hzrd149.com/xyz.jpg'], ['x', SHA_ABC], ['m', 'image/jpeg']],
    },
  };
  assert.equal(parseBlossomResponse(json), 'https://cdn.hzrd149.com/xyz.jpg');
});

test('parseBlossomResponse: la URL directa manda sobre el NIP-94', () => {
  const json = {
    url: 'https://a.test/1.jpg',
    nip94_event: { tags: [['url', 'https://b.test/2.jpg']] },
  };
  assert.equal(parseBlossomResponse(json), 'https://a.test/1.jpg');
});

test('parseBlossomResponse: sin URL → null', () => {
  assert.equal(parseBlossomResponse(null), null);
  assert.equal(parseBlossomResponse(undefined), null);
  assert.equal(parseBlossomResponse('texto'), null);
  assert.equal(parseBlossomResponse({}), null);
  assert.equal(parseBlossomResponse({ url: '' }), null);
  assert.equal(parseBlossomResponse({ nip94_event: { tags: [['x', SHA_ABC]] } }), null);
});

// ---------- targetDimensions ----------
test('targetDimensions: imagen que ya cabe no cambia', () => {
  assert.deepEqual(targetDimensions(800, 600), { width: 800, height: 600 });
  assert.deepEqual(targetDimensions(1024, 1024), { width: 1024, height: 1024 });
  assert.deepEqual(targetDimensions(100, 50), { width: 100, height: 50 });
});

test('targetDimensions: paisaje grande → lado mayor 1024, proporciones intactas', () => {
  assert.deepEqual(targetDimensions(4000, 3000), { width: 1024, height: 768 });
  assert.deepEqual(targetDimensions(2048, 1024), { width: 1024, height: 512 });
});

test('targetDimensions: retrato grande → lado mayor 1024', () => {
  assert.deepEqual(targetDimensions(3000, 4000), { width: 768, height: 1024 });
  assert.deepEqual(targetDimensions(768, 2048), { width: 384, height: 1024 });
});

test('targetDimensions: cuadrado grande y límite personalizado', () => {
  assert.deepEqual(targetDimensions(2000, 2000), { width: 2000 > MAX_FOTO_LADO ? 1024 : 2000, height: 1024 });
  assert.deepEqual(targetDimensions(4000, 3000, 500), { width: 500, height: 375 });
});

test('targetDimensions: redondeo y mínimos sanos', () => {
  const d = targetDimensions(1025, 100);
  assert.equal(d.width, 1024);
  assert.ok(d.height >= 99 && d.height <= 101, 'altura proporcional ~100, fue ' + d.height);
  assert.deepEqual(targetDimensions(0, 0), { width: 1, height: 1 });
});

// ---------- preparePhotoBlob (sin canvas: fallback al original) ----------
test('preparePhotoBlob: un blob que no es imagen pasa intacto', async () => {
  const b = new Blob(['hola'], { type: 'text/plain' });
  assert.equal(await preparePhotoBlob(b), b);
});

test('preparePhotoBlob: imagen sin canvas disponible → original (no rompe)', async () => {
  const b = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  // En Node no hay createImageBitmap/Image/canvas: debe caer al original.
  assert.equal(await preparePhotoBlob(b), b);
});

// ---------- uploadPhoto con fetch mockeado ----------
function mockFetch(handlers) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const h = handlers.find((x) => url.startsWith(x.server));
    if (!h) throw new Error('servidor inesperado: ' + url);
    if (h.throws) throw new Error(h.throws);
    return {
      ok: h.ok !== false,
      status: h.status || (h.ok === false ? 500 : 201),
      json: async () => h.json || {},
    };
  };
  fn.calls = calls;
  return fn;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fotoBlob = () => new Blob([new TextEncoder().encode('abc')], { type: 'image/jpeg' });

test('uploadPhoto: éxito en el primario, auth BUD-02 correcta y espejo al segundo', async () => {
  const sk = generateSecretKey();
  const fetchImpl = mockFetch([
    { server: 'https://nostr.download', json: { url: 'https://nostr.download/' + SHA_ABC + '.jpg' } },
    { server: 'https://cdn.hzrd149.com', json: { url: 'https://cdn.hzrd149.com/' + SHA_ABC + '.jpg' } },
  ]);
  const url = await uploadPhoto(fotoBlob(), sk, { fetchImpl, nowSec: NOW });
  assert.equal(url, 'https://nostr.download/' + SHA_ABC + '.jpg');
  await wait(10); // deja correr el espejo (best-effort, sin await)

  assert.equal(fetchImpl.calls.length, 2, 'primario + espejo');
  assert.ok(fetchImpl.calls[0].url.startsWith('https://nostr.download/upload'));
  assert.ok(fetchImpl.calls[1].url.startsWith('https://cdn.hzrd149.com/upload'));
  const c = fetchImpl.calls[0];
  assert.equal(c.opts.method, 'PUT');
  assert.equal(c.opts.headers['Content-Type'], 'image/jpeg');
  assert.ok(c.opts.headers.Authorization.startsWith('Nostr '));
  const auth = JSON.parse(Buffer.from(c.opts.headers.Authorization.slice(6), 'base64').toString('utf8'));
  assert.equal(auth.kind, 24242);
  assert.equal(auth.pubkey, getPublicKey(sk));
  assert.deepEqual(auth.tags.find((t) => t[0] === 'x'), ['x', SHA_ABC], 'el tag x es el sha256 del blob');
  assert.deepEqual(auth.tags.find((t) => t[0] === 't'), ['t', 'upload']);
  assert.equal(auth.tags.find((t) => t[0] === 'expiration')[1], String(NOW + 600));
  assert.equal(verifyEvent(auth), true, 'la auth viaja firmada y válida');
});

test('uploadPhoto: si el primario falla, cae al segundo servidor', async () => {
  const sk = generateSecretKey();
  const fetchImpl = mockFetch([
    { server: 'https://nostr.download', ok: false, status: 500 },
    { server: 'https://cdn.hzrd149.com', json: { url: 'https://cdn.hzrd149.com/ok.jpg' } },
  ]);
  const url = await uploadPhoto(fotoBlob(), sk, { fetchImpl, nowSec: NOW });
  assert.equal(url, 'https://cdn.hzrd149.com/ok.jpg');
  await wait(10); // el espejo posterior al éxito también corre
  // primario (falla) → segundo (ok) → espejo best-effort al primero
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(fetchImpl.calls[0].url.startsWith('https://nostr.download'));
  assert.ok(fetchImpl.calls[1].url.startsWith('https://cdn.hzrd149.com'));
  assert.ok(fetchImpl.calls[2].url.startsWith('https://nostr.download'), 'espejo al otro servidor');
});

test('uploadPhoto: respuesta solo NIP-94 también da la URL', async () => {
  const sk = generateSecretKey();
  const fetchImpl = mockFetch([
    { server: 'https://nostr.download', json: { nip94_event: { kind: 1063, tags: [['url', 'https://nostr.download/nip94.jpg']] } } },
    { server: 'https://cdn.hzrd149.com', json: { url: 'https://cdn.hzrd149.com/nip94.jpg' } },
  ]);
  const url = await uploadPhoto(fotoBlob(), sk, { fetchImpl, nowSec: NOW });
  assert.equal(url, 'https://nostr.download/nip94.jpg');
});

test('uploadPhoto: si todos fallan, lanza (la UI muestra el error)', async () => {
  const sk = generateSecretKey();
  const fetchImpl = mockFetch([
    { server: 'https://nostr.download', throws: 'red caída' },
    { server: 'https://cdn.hzrd149.com', ok: false, status: 401 },
  ]);
  await assert.rejects(() => uploadPhoto(fotoBlob(), sk, { fetchImpl, nowSec: NOW }));
  assert.equal(fetchImpl.calls.length, 2, 'probó ambos servidores');
});

test('uploadPhoto: servidores por defecto en el orden pedido', () => {
  assert.deepEqual(BLOSSOM_SERVERS, ['https://nostr.download', 'https://cdn.hzrd149.com']);
});

test('uploadToBlossom: respuesta sin URL cuenta como fallo', async () => {
  const fetchImpl = mockFetch([{ server: 'https://x.test', json: { sha256: SHA_ABC } }]);
  await assert.rejects(
    () => uploadToBlossom('https://x.test', fotoBlob(), 'Nostr AAAA', fetchImpl),
    /no devolvió la URL/
  );
});

// ---------- smoke jsdom: botón + input + flujo completo ----------
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.FileReader = dom.window.FileReader;

await import('../src/app.js');
await wait(120); // boot automático del import
const T = window.__cubmatchApp._test;
assert.ok(T, 'hook _test expuesto');

test('smoke: paso 7 muestra botón de galería e input file; la subida rellena la URL', async () => {
  const S = T.getS();
  const sk = generateSecretKey();
  S.sk = sk;
  S.borrador = newProfile();
  S.obPaso = 7;
  T.showOnboarding();

  const fileInput = document.querySelector('#foto-file');
  assert.ok(fileInput, 'existe el input de archivo');
  assert.equal(fileInput.type, 'file');
  assert.equal(fileInput.accept, 'image/*');
  const btn = document.querySelector('label.foto-btn[for="foto-file"]');
  assert.ok(btn, 'existe el botón "Subir desde la galería"');
  assert.match(btn.textContent, /Subir desde la galería/);
  const urlInput = document.querySelector('input[data-f="fotoURL"]');
  assert.ok(urlInput, 'el campo de URL manual se queda');
  assert.equal(urlInput.value, '');

  // fetch mockeado: ambos Blossom aceptan y devuelven la URL pública
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 201, json: async () => ({ url: 'https://nostr.download/foto-smoke.jpg' }) };
  };
  try {
    const file = new dom.window.File([new Uint8Array([137, 80, 78, 71])], 'foto.jpg', { type: 'image/jpeg' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    // el flujo es asíncrono: esperar a que la URL caiga en el campo
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      await wait(100);
      ok = urlInput.value === 'https://nostr.download/foto-smoke.jpg';
    }
    assert.ok(ok, 'la URL resultante rellena el campo (valor: ' + urlInput.value + ')');
    assert.equal(S.borrador.fotoURL, 'https://nostr.download/foto-smoke.jpg');
    assert.equal(calls[0].url, 'https://nostr.download/upload', 'subió al primario primero');
    assert.equal(calls[0].opts.method, 'PUT');
    const estado = document.querySelector('#foto-estado');
    assert.match(estado.textContent, /Foto subida/);
  } finally {
    delete globalThis.fetch;
  }
  dom.window.close();
});
