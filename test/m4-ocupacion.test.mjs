// Resto del hallazgo M4 (revisión de sincronización 2026-10-19), v1.11.2:
// la v1.11.0 blindó el LOGIN contra created_at falso (verifyCredentials
// acepta cualquier reclamo válido), pero el REGISTRO se bloqueaba con
// cualquier reclamo: un reclamo válido con created_at=1 "ocupaba" el
// nombre por adelantado. Ahora un nombre solo cuenta como ocupado si
// algún reclamante está corroborado (10002/10050 del registro real o
// perfil 30079); un reclamo pelado no bloquea el registro.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  KIND_CLAIM, claimTag, nombreOcupado,
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

function perfilFirmado(sk, d = TAG_D) {
  return finalizeEvent({
    kind: KIND_PERFIL, created_at: NOW,
    tags: [['d', d], ['t', 'cubmatch']],
    content: JSON.stringify({ v: 1, apodo: 'Test' }),
  }, sk);
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

test('nombreOcupado: reclamo pelado con created_at=1 NO ocupa el nombre', async () => {
  const skSquat = generateSecretKey();
  const squat = reclamoFirmado(skSquat, 'maria', 1);
  assert.equal(await nombreOcupado(poolCon([squat]), claimDe([squat])), false);
});

test('nombreOcupado: reclamo + 10002 del mismo pubkey ocupa el nombre', async () => {
  const sk = generateSecretKey();
  const rec = reclamoFirmado(sk, 'maria', NOW);
  assert.equal(await nombreOcupado(poolCon([rec, docFirmado(sk, KIND_RELAY_LIST)]), claimDe([rec])), true);
});

test('nombreOcupado: reclamo + 10050 del mismo pubkey ocupa el nombre', async () => {
  const sk = generateSecretKey();
  const rec = reclamoFirmado(sk, 'maria', NOW);
  assert.equal(await nombreOcupado(poolCon([rec, docFirmado(sk, KIND_DM_INBOX)]), claimDe([rec])), true);
});

test('nombreOcupado: reclamo + perfil 30079 del mismo pubkey ocupa el nombre', async () => {
  const sk = generateSecretKey();
  const rec = reclamoFirmado(sk, 'maria', NOW);
  assert.equal(await nombreOcupado(poolCon([rec, perfilFirmado(sk)]), claimDe([rec])), true);
});

test('nombreOcupado: squatter con created_at=1 NO tapa al reclamante real corroborado', async () => {
  const skSquat = generateSecretKey(), skReal = generateSecretKey();
  const squat = reclamoFirmado(skSquat, 'maria', 1);
  const real = reclamoFirmado(skReal, 'maria', NOW);
  const claim = claimDe([squat, real]);
  assert.equal(claim.pubkey, getPublicKey(skSquat), 'el ganador por created_at es el squatter…');
  assert.equal(
    await nombreOcupado(poolCon([squat, real, docFirmado(skReal, KIND_RELAY_LIST)]), claim),
    true, '…pero el nombre sigue ocupado porque el real está corroborado');
});

test('nombreOcupado: documentos de OTRO pubkey no corroboran', async () => {
  const sk = generateSecretKey(), skOtro = generateSecretKey();
  const rec = reclamoFirmado(sk, 'maria', NOW);
  assert.equal(await nombreOcupado(poolCon([rec, docFirmado(skOtro, KIND_RELAY_LIST)]), claimDe([rec])), false);
});

test('nombreOcupado: perfil 30079 con otro d-tag no corrobora', async () => {
  const sk = generateSecretKey();
  const rec = reclamoFirmado(sk, 'maria', NOW);
  assert.equal(await nombreOcupado(poolCon([rec, perfilFirmado(sk, 'otro')]), claimDe([rec])), false);
});

test('nombreOcupado: sin reclamo → false', async () => {
  assert.equal(await nombreOcupado(poolCon([]), null), false);
});
