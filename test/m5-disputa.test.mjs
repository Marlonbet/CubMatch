// Hallazgo M5 (revisión de sincronización 2026-10-19), v1.11.3:
// en Nostr no hay un registro atómico de nombres: dos registros
// simultáneos del mismo nombre NO se pueden impedir. Lo que se
// arregla es el silencio: tras registrar (y en cada login) la app
// re-consulta los reclamos y avisa si OTRO reclamante también está
// corroborado (nombreEnDisputa). La propia corroboración no cuenta
// como disputa, y un reclamo pelado del rival tampoco.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  KIND_CLAIM, claimTag, nombreEnDisputa, nombreOcupado,
} from '../src/cuentas.js';
import { KIND_PERFIL, KIND_RELAY_LIST, KIND_DM_INBOX, TAG_D } from '../src/cubmatch.js';

const NOW = 1700000000;

// Pool falso que SÍ respeta los filtros (kinds/authors/#d), como un relay real.
function poolCon(eventos) {
  const client = {
    relays: ['wss://x.test'],
    status: () => 'open',
    subscribe: (filters, cb) => {
      setImmediate(() => {
        for (const ev of eventos) {
          for (const f of filters) {
            if (f.kinds && !f.kinds.includes(ev.kind)) continue;
            if (f.authors && !f.authors.includes(ev.pubkey)) continue;
            if (f['#d'] && !ev.tags.some((t) => t[0] === 'd' && f['#d'].includes(t[1]))) continue;
            cb(ev);
          }
        }
      });
      return { eose: () => new Promise((r) => setImmediate(r)), unsub() {} };
    },
  };
  return { discovery: () => client, messaging: () => client, scopeDegraded: () => false };
}

function reclamoFirmado(sk, username, created_at) {
  return finalizeEvent({
    kind: KIND_CLAIM, created_at,
    tags: [['d', claimTag(username)], ['t', 'cubmatch-cuenta']],
    content: JSON.stringify({ v: 1, username, creado: 0 }),
  }, sk);
}

function docFirmado(sk, kind) {
  return finalizeEvent({ kind, created_at: NOW, tags: [], content: '' }, sk);
}

// Claim con el formato que devuelve fetchUsernameClaim: ganador + todos.
function claimDe(reclamos) {
  const todos = reclamos.map((ev) => ({
    username: JSON.parse(ev.content).username, pubkey: ev.pubkey,
    created_at: ev.created_at, id: ev.id,
  }));
  const ganador = todos.reduce((a, b) => (b.created_at < a.created_at ? b : a));
  return { ...ganador, todos };
}

test('nombreEnDisputa: solo yo corroborado → sin disputa', async () => {
  const skYo = generateSecretKey();
  const rec = reclamoFirmado(skYo, 'maria', NOW);
  const claim = claimDe([rec]);
  assert.equal(await nombreEnDisputa(poolCon([rec, docFirmado(skYo, KIND_RELAY_LIST)]), claim, getPublicKey(skYo)), false);
});

test('nombreEnDisputa: yo + otro corroborados → disputa', async () => {
  const skYo = generateSecretKey(), skOtro = generateSecretKey();
  const recYo = reclamoFirmado(skYo, 'maria', NOW);
  const recOtro = reclamoFirmado(skOtro, 'maria', NOW + 1);
  const claim = claimDe([recYo, recOtro]);
  const eventos = [recYo, recOtro, docFirmado(skYo, KIND_RELAY_LIST), docFirmado(skOtro, KIND_DM_INBOX)];
  assert.equal(await nombreEnDisputa(poolCon(eventos), claim, getPublicKey(skYo)), true);
  assert.equal(await nombreEnDisputa(poolCon(eventos), claim, getPublicKey(skOtro)), true, 'el otro lado también ve la disputa');
});

test('nombreEnDisputa: otro corroborado y yo con reclamo pelado → disputa', async () => {
  const skYo = generateSecretKey(), skOtro = generateSecretKey();
  const recYo = reclamoFirmado(skYo, 'maria', NOW);
  const recOtro = reclamoFirmado(skOtro, 'maria', NOW);
  const claim = claimDe([recYo, recOtro]);
  assert.equal(
    await nombreEnDisputa(poolCon([recYo, recOtro, docFirmado(skOtro, KIND_RELAY_LIST)]), claim, getPublicKey(skYo)),
    true, 'mis documentos aún no publicados no me salvan: el otro sí completó el registro');
});

test('nombreEnDisputa: solo reclamos pelados (yo + otro) → sin disputa', async () => {
  const skYo = generateSecretKey(), skOtro = generateSecretKey();
  const recYo = reclamoFirmado(skYo, 'maria', NOW);
  const recOtro = reclamoFirmado(skOtro, 'maria', NOW);
  assert.equal(await nombreEnDisputa(poolCon([recYo, recOtro]), claimDe([recYo, recOtro]), getPublicKey(skYo)), false);
});

test('nombreEnDisputa: rival con documentos de un tercer pubkey no corrobora → sin disputa', async () => {
  const skYo = generateSecretKey(), skOtro = generateSecretKey(), skTercero = generateSecretKey();
  const recYo = reclamoFirmado(skYo, 'maria', NOW);
  const recOtro = reclamoFirmado(skOtro, 'maria', NOW);
  const eventos = [recYo, recOtro, docFirmado(skYo, KIND_RELAY_LIST), docFirmado(skTercero, KIND_RELAY_LIST)];
  assert.equal(await nombreEnDisputa(poolCon(eventos), claimDe([recYo, recOtro]), getPublicKey(skYo)), false);
});

test('nombreEnDisputa: dos reclamos del mismo pubkey (misma cuenta) → sin disputa', async () => {
  const skYo = generateSecretKey();
  const rec1 = reclamoFirmado(skYo, 'maria', NOW);
  const rec2 = reclamoFirmado(skYo, 'maria', NOW + 5);
  assert.equal(
    await nombreEnDisputa(poolCon([rec1, rec2, docFirmado(skYo, KIND_RELAY_LIST)]), claimDe([rec1, rec2]), getPublicKey(skYo)),
    false);
});

test('nombreEnDisputa: perfil 30079 del rival también corrobora → disputa', async () => {
  const skYo = generateSecretKey(), skOtro = generateSecretKey();
  const recYo = reclamoFirmado(skYo, 'maria', NOW);
  const recOtro = reclamoFirmado(skOtro, 'maria', NOW);
  const perfilOtro = finalizeEvent({
    kind: KIND_PERFIL, created_at: NOW,
    tags: [['d', TAG_D], ['t', 'cubmatch']],
    content: JSON.stringify({ v: 1, apodo: 'Otra' }),
  }, skOtro);
  assert.equal(
    await nombreEnDisputa(poolCon([recYo, recOtro, perfilOtro]), claimDe([recYo, recOtro]), getPublicKey(skYo)),
    true);
});

test('nombreEnDisputa: sin reclamo o sin mi pubkey → false', async () => {
  const skYo = generateSecretKey();
  assert.equal(await nombreEnDisputa(poolCon([]), null, getPublicKey(skYo)), false);
  const rec = reclamoFirmado(skYo, 'maria', NOW);
  assert.equal(await nombreEnDisputa(poolCon([rec]), claimDe([rec]), null), false);
});

test('nombreOcupado no cambió con el refactor M5: sigue siendo "algún corroborado"', async () => {
  const sk = generateSecretKey();
  const rec = reclamoFirmado(sk, 'maria', NOW);
  assert.equal(await nombreOcupado(poolCon([rec]), claimDe([rec])), false);
  assert.equal(await nombreOcupado(poolCon([rec, docFirmado(sk, KIND_DM_INBOX)]), claimDe([rec])), true);
});
