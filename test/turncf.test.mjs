// v1.9.0: Cloudflare Realtime TURN (src/turncf.js).
// - Sin credenciales inyectadas (placeholders) → null, sin red.
// - Con credenciales: POST a la API de Cloudflare (fetch falso),
//   iceServers de vuelta, caché de 6 h, force, y errores → null.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CF_KEY_ID, CF_TOKEN, CF_TTL_SEG, CF_CACHE_MAX_MS,
  cfConfigurado, getCfIceServers, _resetCfCache,
} from '../src/turncf.js';

const KID = 'kid-de-prueba';
const TOK = 'token-de-prueba';
const ICE_CF = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
  {
    urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
    username: 'usuario-temporal', credential: 'secreto-temporal',
  },
];

function fakeFetchOk(registro) {
  return async (url, opts) => {
    registro.push({ url, opts });
    return { ok: true, status: 201, json: async () => ({ iceServers: ICE_CF }) };
  };
}

test('turncf: en el código fuente los placeholders están SIN inyectar y la función está apagada', async () => {
  _resetCfCache();
  assert.equal(CF_KEY_ID, '__TURNCF_KEY_ID__');
  assert.equal(CF_TOKEN, '__TURNCF_TOKEN__');
  assert.equal(cfConfigurado(), false);
  let llamoFetch = false;
  const r = await getCfIceServers({
    fetchFn: async () => { llamoFetch = true; throw new Error('no debería llamarse'); },
  });
  assert.equal(r, null, 'sin credenciales → null');
  assert.equal(llamoFetch, false, 'ni siquiera intenta la red');
});

test('turncf: pide credenciales a la API de Cloudflare con el formato exacto', async () => {
  _resetCfCache();
  const registro = [];
  const r = await getCfIceServers({ keyId: KID, token: TOK, fetchFn: fakeFetchOk(registro), nowFn: () => 1000 });
  assert.deepEqual(r, ICE_CF, 'devuelve el iceServers de la respuesta, listo para usar');
  assert.equal(registro.length, 1);
  const { url, opts } = registro[0];
  assert.equal(url, 'https://rtc.live.cloudflare.com/v1/turn/keys/' + KID + '/credentials/generate-ice-servers');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers.Authorization, 'Bearer ' + TOK);
  assert.deepEqual(JSON.parse(opts.body), { ttl: CF_TTL_SEG });
  assert.equal(CF_TTL_SEG, 86400);
});

test('turncf: caché de 6 h — la segunda llamada no refetchea; al pasar, sí; force siempre', async () => {
  _resetCfCache();
  const registro = [];
  let reloj = 1000000;
  const nowFn = () => reloj;
  const args = { keyId: KID, token: TOK, fetchFn: fakeFetchOk(registro), nowFn };
  assert.deepEqual(await getCfIceServers(args), ICE_CF);
  assert.equal(registro.length, 1);
  reloj += CF_CACHE_MAX_MS - 1; // aún joven
  assert.deepEqual(await getCfIceServers(args), ICE_CF);
  assert.equal(registro.length, 1, 'caché joven: no hubo segundo fetch');
  reloj += 2; // ya pasó de 6 h
  assert.deepEqual(await getCfIceServers(args), ICE_CF);
  assert.equal(registro.length, 2, 'caché vieja: refetch');
  assert.deepEqual(await getCfIceServers({ ...args, force: true }), ICE_CF);
  assert.equal(registro.length, 3, 'force: refetch aunque la caché sea joven');
});

test('turncf: cualquier error → null, jamás lanza', async () => {
  _resetCfCache();
  const args = { keyId: KID, token: TOK, nowFn: () => 5000 };
  // HTTP no-ok
  assert.equal(await getCfIceServers({ ...args, fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }) }), null);
  // La red lanza (sin conexión, timeout abortado…)
  assert.equal(await getCfIceServers({ ...args, fetchFn: async () => { throw new Error('red caída'); } }), null);
  // Respuesta sin iceServers utilizable
  assert.equal(await getCfIceServers({ ...args, fetchFn: async () => ({ ok: true, json: async () => ({}) }) }), null);
  assert.equal(await getCfIceServers({ ...args, fetchFn: async () => ({ ok: true, json: async () => ({ iceServers: [] }) }) }), null);
  assert.equal(await getCfIceServers({ ...args, fetchFn: async () => ({ ok: true, json: async () => { throw new Error('json roto'); } }) }), null);
  // Sin fetch disponible en el entorno
  assert.equal(await getCfIceServers({ ...args, fetchFn: null }), null);
  // Credenciales a medias: tampoco
  assert.equal(await getCfIceServers({ keyId: KID, token: '', fetchFn: fakeFetchOk([]) }), null);
  assert.equal(await getCfIceServers({ keyId: '', token: TOK, fetchFn: fakeFetchOk([]) }), null);
});
