// Bugs reportados por Marlon el 2026-10-28:
// 1. Al tocar Matches/🔔 la app lo mandaba a Descubrir: el loader
//    ejecutaba en línea un bundle vivo más nuevo y ese bundle se
//    auto-arrancaba solo (microtarea) yendo a Descubrir, aunque el
//    loader hubiera decidido no tomar el control. Además el loader
//    llamaba a fallback.boot() aunque la app ya se hubiera arrancado.
// 2. "Sin perfil publicado" intermitente: el borrador local y el perfil
//    publicado divergían y el editor partía del borrador. fusionarBorrador
//    sincroniza el borrador con lo publicado sin perder ediciones.
// 3. Candidato que aparece y al recargar ya no sale: dos eventos con el
//    mismo created_at (segundos) ganaban según el orden de llegada del
//    relay. El desempate por id mayor lo hace determinista.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import {
  newProfile, completitud, fusionarBorrador,
} from '../src/perfil.js';
import {
  eventoMasReciente, mergePerfiles, mergeLikes, integrarLikeEntrante,
} from '../src/cubmatch.js';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

function perfilLleno(apodo) {
  const p = newProfile();
  Object.assign(p, {
    apodo, edad: 25, genero: 'mujer', orientacion: 'hetero',
    provincia: 'Santiago de Cuba', municipio: 'Santiago',
    estatura: 165, complexion: 'Promedio', ojos: 'Marrones', piel: 'Morena', cabello: 'Negro',
    educacion: 'Universitario', profesion: 'maestra', sector: 'Educación',
    fumador: 'No', bebedor: 'No', deporte: 'Sí', religion: 'ninguna',
    hijosTiene: 'No tengo', hijosQuiere: 'Sí', mascotas: 'No',
    valores: ['familia'], rasgos: { extroversion: 4, amabilidad: 3, responsabilidad: 3, apertura: 3, calma: 3 },
    intereses: ['música'], tags: ['café'], bio: 'Hola', prompts: [{ q: 'Un domingo…', a: 'playa' }],
    tresPalabras: 'alegre sincera', fotoURL: 'https://ejemplo.test/foto.jpg',
    prefs: { edadMin: 18, edadMax: 99, generos: ['hombre'], distancia: 'cuba', relacion: ['romance'] },
  });
  return p;
}

// ---------------------------------------------------------- fusionarBorrador

test('fusionarBorrador: publicado manda, borrador vacío no lo borra', () => {
  const pub = perfilLleno('Ana');
  const out = fusionarBorrador(pub, newProfile());
  assert.equal(out.apodo, 'Ana');
  assert.equal(out.fotoURL, 'https://ejemplo.test/foto.jpg');
  assert.ok(completitud(out) >= 70);
});

test('fusionarBorrador: conserva la foto del borrador si lo publicado no la tiene', () => {
  const pub = perfilLleno('Ana');
  pub.fotoURL = '';
  const draft = newProfile();
  draft.fotoURL = 'https://ejemplo.test/nueva.jpg';
  const out = fusionarBorrador(pub, draft);
  assert.equal(out.apodo, 'Ana', 'el apodo publicado no se pierde');
  assert.equal(out.fotoURL, 'https://ejemplo.test/nueva.jpg', 'la foto sin publicar se conserva');
});

test('fusionarBorrador: sin borrador devuelve lo publicado; sin publicado devuelve el borrador', () => {
  const pub = perfilLleno('Ana');
  assert.equal(fusionarBorrador(pub, null).apodo, 'Ana');
  const draft = newProfile();
  draft.apodo = 'Borrador';
  assert.equal(fusionarBorrador(null, draft).apodo, 'Borrador');
  assert.equal(fusionarBorrador(null, null), null);
});

test('fusionarBorrador: las banderas son las publicadas', () => {
  const pub = perfilLleno('Ana');
  pub.videoOk = true; pub.oculto = true;
  const draft = newProfile();
  draft.videoOk = false; draft.oculto = false;
  const out = fusionarBorrador(pub, draft);
  assert.equal(out.videoOk, true);
  assert.equal(out.oculto, true);
});

// ---------------------------------------------------------- desempate por id

test('eventoMasReciente: a igual created_at gana el id mayor, en cualquier orden', () => {
  const viejo = { id: 'aaa', created_at: 100, profile: { apodo: 'Viejo' } };
  const nuevo = { id: 'zzz', created_at: 100, profile: { apodo: 'Nuevo' } };
  assert.equal(eventoMasReciente(viejo, nuevo), nuevo);
  assert.equal(eventoMasReciente(nuevo, viejo), nuevo, 'el orden de llegada no cambia el ganador');
  assert.equal(eventoMasReciente({ id: 'a', created_at: 50 }, { id: 'z', created_at: 60 }).created_at, 60);
  assert.equal(eventoMasReciente(null, nuevo), nuevo);
  assert.equal(eventoMasReciente(viejo, null), viejo);
});

test('mergePerfiles: empate en created_at se resuelve por id, no por orden de llegada', () => {
  const mk = (id, apodo) => ({ pubkey: PK_A, id, created_at: 100, profile: { apodo } });
  const a = mergePerfiles([mk('aaa', 'Primero')], [mk('zzz', 'Segundo')]);
  const b = mergePerfiles([mk('zzz', 'Segundo')], [mk('aaa', 'Primero')]);
  assert.equal(a[0].profile.apodo, 'Segundo');
  assert.equal(b[0].profile.apodo, 'Segundo');
});

test('mergeLikes: empate en ts se resuelve por id', () => {
  const cached = { sent: { [PK_A]: { tipo: '+', ts: 100, id: 'aaa' } }, received: {} };
  const fresh = { sent: { [PK_A]: { tipo: '-', ts: 100, id: 'zzz' } }, received: {} };
  const out = mergeLikes(cached, fresh);
  assert.equal(out.sent[PK_A].tipo, '-', 'gana el id mayor a igual segundo');
  const out2 = mergeLikes(
    { sent: { [PK_A]: { tipo: '-', ts: 100, id: 'zzz' } }, received: {} },
    { sent: { [PK_A]: { tipo: '+', ts: 100, id: 'aaa' } }, received: {} },
  );
  assert.equal(out2.sent[PK_A].tipo, '-', 'el orden no cambia el resultado');
});

test('integrarLikeEntrante: empate en created_at se resuelve por id', () => {
  const likes = { sent: {}, received: { [PK_B]: { tipo: '+', ts: 200, id: 'aaa' } } };
  const r = integrarLikeEntrante(likes, { peer: PK_B, tipo: '-', created_at: 200, id: 'zzz' });
  assert.equal(r.changed, true);
  assert.equal(likes.received[PK_B].tipo, '-');
});

// ---------------------------------------------------------- loader / takeover

function bootConPlaceholders(versionRemota) {
  let boot = read('src/boot.js');
  boot = boot.replace('__BUNDLED_VERSION__', '1.12.7');
  boot = boot.replace('__UPDATE_PUBKEY__', () =>
    JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB' }));
  return boot;
}

function autoInicioReal() {
  // El bloque de auto-inicio TAL CUAL está en src/app.js: el bundle vivo
  // lo ejecuta al evaluarse en línea. Si la guarda de supresión falta,
  // este bloque arranca el bundle vivo sin que el loader lo decida.
  const app = read('src/app.js');
  const i = app.indexOf('// Arranque automático');
  assert.ok(i >= 0, 'falta el bloque de arranque en app.js');
  return app.slice(i);
}

async function prepararDom({ conInicio }) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="app">' +
    (conInicio ? '<div id="pantalla-inicio"></div>' : '<div class="deck">Descubrir</div>') +
    '</div></body></html>',
    { url: 'http://localhost/', runScripts: 'dangerously' },
  );
  const { window } = dom;
  if (!window.crypto || !window.crypto.subtle) {
    try { Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true }); } catch {}
  }
  if (typeof window.atob !== 'function') {
    window.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  }
  if (typeof window.AbortController === 'undefined') window.AbortController = AbortController;
  return { dom, window };
}

async function firmarLive(liveText, version) {
  const kp = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
  const head = new TextEncoder().encode(version + '\n');
  const body = new TextEncoder().encode(liveText);
  const msg = new Uint8Array(head.length + body.length);
  msg.set(head, 0);
  msg.set(body, head.length);
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, msg);
  return { jwk, sigB64: Buffer.from(sig).toString('base64') };
}

async function escenarioTakeover({ conInicio }) {
  const { dom, window } = await prepararDom({ conInicio });
  let fallbackCalls = 0, fallbackDisposed = 0, liveCalls = 0;
  window.__cubmatchApp = {
    boot() { fallbackCalls++; window.__cubmatchBooted = true; },
    dispose() { fallbackDisposed++; },
    version: '1.12.7',
  };
  let liveText =
    'window.__cubmatchApp = { boot: function () { window.__liveCalls = (window.__liveCalls || 0) + 1; window.__cubmatchBooted = true; }, ' +
    'dispose: function () {}, version: "9.9.9" };\n' + autoInicioReal();
  // El loader exige un bundle vivo de >50 KB (validLiveText): rellenar
  // con un comentario para que el falso vivo pase esa guarda, igual que
  // el bundle real.
  liveText += '\n/*' + 'x'.repeat(60000) + '*/\n';
  const { jwk, sigB64 } = await firmarLive(liveText, '9.9.9');
  const liveBuf = new TextEncoder().encode(liveText);
  window.fetch = async (url) => {
    if (String(url).includes('version.js')) {
      return { ok: true, text: async () => 'window.__CUBMATCH_REMOTE_VERSION="9.9.9";\n' };
    }
    if (String(url).includes('cubmatch-live.sig.json')) {
      return { ok: true, text: async () => JSON.stringify({ v: '9.9.9', sig: sigB64 }) };
    }
    return {
      ok: true,
      arrayBuffer: async () => liveBuf.buffer.slice(liveBuf.byteOffset, liveBuf.byteOffset + liveBuf.byteLength),
    };
  };
  let boot = read('src/boot.js');
  boot = boot.replace('__BUNDLED_VERSION__', '1.12.7');
  boot = boot.replace('__UPDATE_PUBKEY__', () =>
    JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }));
  window.eval(boot);
  await wait(150);
  await wait(50);
  liveCalls = window.__liveCalls || 0;
  const log = window.__cubmatchUpdateLog || [];
  dom.window.close();
  return { fallbackCalls, fallbackDisposed, liveCalls, log };
}

test('loader: con la app ya arrancada no vuelve a llamar a fallback.boot()', async () => {
  const { dom, window } = await prepararDom({ conInicio: true });
  let calls = 0;
  window.__cubmatchBooted = true; // la app ya se arrancó sola
  window.__cubmatchApp = { boot() { calls++; }, dispose() {}, version: '1.12.7' };
  window.fetch = async () => { throw new Error('sin red en este test'); };
  window.eval(bootConPlaceholders());
  await wait(80);
  assert.equal(calls, 0, 'el loader no debe re-arrancar una app ya arrancada');
  dom.window.close();
});

test('loader: en la pantalla de inicio el takeover arranca el vivo UNA sola vez', async () => {
  const r = await escenarioTakeover({ conInicio: true });
  assert.equal(r.fallbackCalls, 1, 'fallback arranca una vez');
  assert.equal(r.fallbackDisposed, 1, 'fallback se dispone en el takeover');
  assert.equal(r.liveCalls, 1, 'el vivo arranca exactamente una vez (sin auto-arranque extra)');
  assert.ok(r.log.join(' ').includes('takeover'), 'el log registra el takeover: ' + r.log.join(' | '));
});

test('loader: dentro de la app (sin pantalla de inicio) el vivo NO arranca solo ni bota a Descubrir', async () => {
  const r = await escenarioTakeover({ conInicio: false });
  assert.equal(r.fallbackCalls, 1, 'fallback arranca una vez');
  assert.equal(r.fallbackDisposed, 0, 'fallback no se dispone: no hay takeover dentro de la app');
  assert.equal(r.liveCalls, 0, 'el bundle vivo cargado NO debe auto-arrancarse ni mandar a Descubrir');
});

test('código: la guarda de supresión vive en app.js y en boot.js', () => {
  assert.ok(read('src/app.js').includes('__cubmatchSuppressAutoBoot'), 'app.js debe respetar la supresión del loader');
  assert.ok(read('src/boot.js').includes('__cubmatchSuppressAutoBoot'), 'boot.js debe poner la supresión antes de ejecutar el vivo');
  assert.ok(read('src/boot.js').includes('__cubmatchBooted'), 'boot.js debe respetar que la app ya arrancó');
});
