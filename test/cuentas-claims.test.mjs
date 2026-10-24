// Revisión de seguridad 2026-10 de src/cuentas.js:
//  · un reclamo falso con created_at adulterado ya no deja fuera al dueño,
//  · KDF v1 intacta (misma identidad) y v2 opt-in, con resolverCuenta(),
//  · validateNewPassword para cuentas nuevas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  KIND_CLAIM, KDF, KDF_ACTUAL, claimTag, deriveSecretKey, resolverCuenta,
  verifyCredentials, pickEarliestClaim, fetchUsernameClaim,
  validatePassword, validateNewPassword,
} from '../src/cuentas.js';

const NOW = Math.floor(Date.UTC(2026, 9, 1) / 1000);
const PW = 'mi perro come mangos';

function reclamo(username, pubkey, created_at) {
  return { username, pubkey, created_at, id: 'id-' + pubkey.slice(0, 6) + '-' + created_at };
}

function eventoReclamo(sk, username, created_at) {
  return finalizeEvent({
    kind: KIND_CLAIM, created_at,
    tags: [['d', claimTag(username)], ['t', 'cubmatch-cuenta']],
    content: JSON.stringify({ v: 1, username, creado: 0 }),
  }, sk);
}

function poolCon(eventos) {
  const client = {
    subscribe(_filtros, cb) {
      setTimeout(() => eventos.forEach(cb), 0);
      return { eose: () => new Promise((r) => setTimeout(r, 10)), unsub() {} };
    },
  };
  return { discovery: () => client, messaging: () => client, scopeDegraded: () => false };
}

// ------------------------------------------------ reclamos falsos (lockout)

test('verifyCredentials: un reclamo falso con created_at=1 NO deja fuera al dueño', () => {
  const victima = getPublicKey(generateSecretKey());
  const atacante = getPublicKey(generateSecretKey());
  const falso = reclamo('victima', atacante, 1);
  const real = reclamo('victima', victima, NOW);
  const ganador = pickEarliestClaim([real, falso]);
  assert.equal(ganador.pubkey, atacante, 'el orden por created_at lo gana el falso…');
  const claim = { ...ganador, todos: [real, falso] };
  assert.equal(verifyCredentials(victima, claim), true, '…pero el dueño real sigue pudiendo entrar');
  assert.equal(verifyCredentials(getPublicKey(generateSecretKey()), claim), false, 'un tercero no entra');
});

test('verifyCredentials: compatible con reclamos sin `todos` (comportamiento anterior)', () => {
  const a = getPublicKey(generateSecretKey());
  const b = getPublicKey(generateSecretKey());
  assert.equal(verifyCredentials(a, reclamo('u', a, NOW)), true);
  assert.equal(verifyCredentials(b, reclamo('u', a, NOW)), false);
  assert.equal(verifyCredentials(a, null), false);
});

test('fetchUsernameClaim: devuelve el ganador y TODOS los reclamos válidos', async () => {
  const skV = generateSecretKey(), skA = generateSecretKey();
  const evs = [eventoReclamo(skA, 'victima', 1000), eventoReclamo(skV, 'victima', NOW)];
  const claim = await fetchUsernameClaim(poolCon(evs), 'victima');
  assert.ok(claim && claim.pubkey && Array.isArray(claim.todos));
  assert.ok(claim.todos.length >= 1);
  assert.equal(verifyCredentials(getPublicKey(skV), claim), true, 'el dueño entra pase lo que pase');
  assert.equal(await fetchUsernameClaim(poolCon([]), 'nadie'), null);
});

// ------------------------------------------------------------- KDF y login

test('deriveSecretKey: v1 es la predeterminada y estable; v2 es otra identidad', async () => {
  const a = await deriveSecretKey('marlon', PW);
  const b = await deriveSecretKey('marlon', PW, { version: 1 });
  assert.deepEqual(a, b, 'sin opciones = v1 (no cambia la identidad de las cuentas existentes)');
  const v2 = await deriveSecretKey('marlon', PW, { version: 2 });
  assert.notDeepEqual(a, v2);
  assert.equal(a.length, 32);
  await assert.rejects(() => deriveSecretKey('marlon', PW, { version: 99 }), /desconocida/);
  assert.ok(KDF[2].N > KDF[1].N);
  assert.equal(KDF[1].N, 16384, 'los parámetros v1 NO se tocan: cambiarlos rompe todas las cuentas');
  assert.equal(KDF_ACTUAL, 2);
});

test('resolverCuenta: acepta cuentas v1 y v2 y rechaza contraseña errónea', async () => {
  const sk1 = await deriveSecretKey('ana', PW, { version: 1 });
  const sk2 = await deriveSecretKey('ana', PW, { version: 2 });
  const claim1 = reclamo('ana', getPublicKey(sk1), NOW);
  const claim2 = reclamo('ana', getPublicKey(sk2), NOW);

  const r1 = await resolverCuenta('ana', PW, claim1);
  assert.equal(r1.version, 1);
  assert.deepEqual(r1.sk, sk1);
  const r2 = await resolverCuenta('ana', PW, claim2);
  assert.equal(r2.version, 2);
  assert.deepEqual(r2.sk, sk2);

  assert.equal(await resolverCuenta('ana', 'otra contraseña distinta', claim1), null);
  assert.equal(await resolverCuenta('ana', PW, null), null);
});

// -------------------------------------------------- contraseñas nuevas

test('validateNewPassword: acepta frases largas', () => {
  assert.doesNotThrow(() => validateNewPassword('mi perro come mangos', 'marlon'));
  assert.doesNotThrow(() => validateNewPassword('Caballo-Bateria-Correcta-7', 'marlon'));
  assert.doesNotThrow(() => validateNewPassword('x9#Kd2!vQ7pL'));
});

test('validateNewPassword: rechaza cortas, comunes, repetitivas, numéricas y con el usuario', () => {
  assert.throws(() => validateNewPassword('corta1!'), /12 caracteres/);
  assert.throws(() => validateNewPassword('12345678910'), /12 caracteres/);
  assert.throws(() => validateNewPassword('aaaaaaaaaaaaaa'), /repetitiva/);
  assert.throws(() => validateNewPassword('123456789012'), /repetitiva|números|común/);
  assert.throws(() => validateNewPassword('Contraseña1234'), /comunes/);
  assert.throws(() => validateNewPassword('marlon-es-genial-2026', 'Marlon'), /usuario/);
  assert.throws(() => validateNewPassword(''), /12 caracteres/);
  assert.throws(() => validateNewPassword(null), /12 caracteres/);
});

test('validatePassword (login): sigue aceptando las contraseñas de 8+ de cuentas existentes', () => {
  assert.doesNotThrow(() => validatePassword('abcd1234'));
  assert.throws(() => validatePassword('corta'), /8 caracteres/);
});
