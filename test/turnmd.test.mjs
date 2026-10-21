// v1.9.1: Metered / Open Relay TURN con cuenta propia (src/turnmd.js).
// - Sin credenciales inyectadas (placeholders) → null, sin red.
// - Con credenciales: GET a la API de Metered (fetch falso); la
//   respuesta ES el array iceServers. Caché de 6 h, force, errores → null.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MD_APP, MD_APIKEY, MD_CACHE_MAX_MS,
  mdConfigurado, getMeteredIceServers, _resetMdCache,
} from '../src/turnmd.js';

const APP = 'miapp-de-prueba';
const KEY = 'apikey-de-prueba';
const ICE_MD = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  {
    urls: [
      'turn:global.relay.metered.ca:80',
      'turn:global.relay.metered.ca:80?transport=tcp',
      'turn:global.relay.metered.ca:443',
      'turns:global.relay.metered.ca:443?transport=tcp',
    ],
    username: 'usuario-temporal', credential: 'secreto-temporal',
  },
];

function fakeFetchOk(registro) {
  return async (url, opts) => {
    registro.push({ url, opts });
    return { ok: true, status: 200, json: async () => ICE_MD };
  };
}

test('turnmd: en el código fuente los placeholders están SIN inyectar y la función está apagada', async () => {
  _resetMdCache();
  assert.equal(MD_APP, '__TURNMD_APP__');
  assert.equal(MD_APIKEY, '__TURNMD_APIKEY__');
  assert.equal(mdConfigurado(), false);
  let llamoFetch = false;
  const r = await getMeteredIceServers({
    fetchFn: async () => { llamoFetch = true; throw new Error('no debería llamarse'); },
  });
  assert.equal(r, null, 'sin credenciales → null');
  assert.equal(llamoFetch, false, 'ni siquiera intenta la red');
});

test('turnmd: pide credenciales a la API de Metered con la URL exacta', async () => {
  _resetMdCache();
  const registro = [];
  const r = await getMeteredIceServers({ app: APP, apiKey: KEY, fetchFn: fakeFetchOk(registro), nowFn: () => 1000 });
  assert.deepEqual(r, ICE_MD, 'devuelve el array iceServers de la respuesta, listo para usar');
  assert.equal(registro.length, 1);
  const { url, opts } = registro[0];
  assert.equal(url, 'https://' + APP + '.metered.live/api/v1/turn/credentials?apiKey=' + KEY);
  assert.equal(opts.method, 'GET');
});

test('turnmd: caché de 6 h — la segunda llamada no refetchea; al pasar, sí; force siempre', async () => {
  _resetMdCache();
  const registro = [];
  let reloj = 1000000;
  const nowFn = () => reloj;
  const args = { app: APP, apiKey: KEY, fetchFn: fakeFetchOk(registro), nowFn };
  assert.deepEqual(await getMeteredIceServers(args), ICE_MD);
  assert.equal(registro.length, 1);
  reloj += MD_CACHE_MAX_MS - 1; // aún joven
  assert.deepEqual(await getMeteredIceServers(args), ICE_MD);
  assert.equal(registro.length, 1, 'caché joven: no hubo segundo fetch');
  reloj += 2; // ya pasó de 6 h
  assert.deepEqual(await getMeteredIceServers(args), ICE_MD);
  assert.equal(registro.length, 2, 'caché vieja: refetch');
  assert.deepEqual(await getMeteredIceServers({ ...args, force: true }), ICE_MD);
  assert.equal(registro.length, 3, 'force: refetch aunque la caché sea joven');
});

test('turnmd: cualquier error → null, jamás lanza', async () => {
  _resetMdCache();
  const args = { app: APP, apiKey: KEY, nowFn: () => 5000 };
  // HTTP no-ok
  assert.equal(await getMeteredIceServers({ ...args, fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }) }), null);
  // La red lanza (sin conexión, timeout abortado…)
  assert.equal(await getMeteredIceServers({ ...args, fetchFn: async () => { throw new Error('red caída'); } }), null);
  // Respuesta que no es el array iceServers
  assert.equal(await getMeteredIceServers({ ...args, fetchFn: async () => ({ ok: true, json: async () => ({}) }) }), null);
  assert.equal(await getMeteredIceServers({ ...args, fetchFn: async () => ({ ok: true, json: async () => [] }) }), null);
  assert.equal(await getMeteredIceServers({ ...args, fetchFn: async () => ({ ok: true, json: async () => [{ sinUrls: true }] }) }), null);
  assert.equal(await getMeteredIceServers({ ...args, fetchFn: async () => ({ ok: true, json: async () => { throw new Error('json roto'); } }) }), null);
  // Sin fetch disponible en el entorno
  assert.equal(await getMeteredIceServers({ ...args, fetchFn: null }), null);
  // Credenciales a medias: tampoco
  assert.equal(await getMeteredIceServers({ app: APP, apiKey: '', fetchFn: fakeFetchOk([]) }), null);
  assert.equal(await getMeteredIceServers({ app: '', apiKey: KEY, fetchFn: fakeFetchOk([]) }), null);
});
