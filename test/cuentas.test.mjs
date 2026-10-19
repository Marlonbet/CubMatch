// Tests de cuentas CubMatch: validación, derivación scrypt, reclamos.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsername, validatePassword, deriveSecretKey,
  buildClaimEvent, parseClaimEvent, pickEarliestClaim, verifyCredentials, nsecOf,
  KIND_CLAIM, claimTag,
} from '../src/cuentas.js';
import { getPublicKey } from 'nostr-tools';

test('normalizeUsername acepta válidos y rechaza inválidos', () => {
  assert.equal(normalizeUsername(' Marlon_99 '), 'marlon_99');
  assert.throws(() => normalizeUsername('ab'), /3 y 20/);
  assert.throws(() => normalizeUsername('con espacios'), /3 y 20/);
  assert.throws(() => normalizeUsername('UPPER!'), /3 y 20/);
});

test('validatePassword exige mínimo 8', () => {
  assert.throws(() => validatePassword('corta'), /8 caracteres/);
  assert.doesNotThrow(() => validatePassword('suficiente1'));
});

test('deriveSecretKey es determinista y válida secp256k1', async () => {
  const a = await deriveSecretKey('marlon', 'password123');
  const b = await deriveSecretKey('marlon', 'password123');
  const c = await deriveSecretKey('marlon', 'otraclave1');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, 32);
  assert.match(getPublicKey(a), /^[0-9a-f]{64}$/);
});

test('nsecOf codifica la clave derivada', async () => {
  const sk = await deriveSecretKey('ana', 'password123');
  assert.ok(nsecOf(sk).startsWith('nsec1'));
});

test('claim: build → parse round-trip', () => {
  const tpl = buildClaimEvent('marlon');
  assert.equal(tpl.kind, KIND_CLAIM);
  assert.deepEqual(tpl.tags[0], ['d', claimTag('marlon')]);
  const ev = { ...tpl, pubkey: 'p'.repeat(64), created_at: 123, id: 'x' };
  const p = parseClaimEvent(ev);
  assert.equal(p.username, 'marlon');
  assert.equal(p.pubkey, 'p'.repeat(64));
});

test('parseClaimEvent rechaza eventos ajenos', () => {
  assert.equal(parseClaimEvent({ kind: 1, tags: [], content: '{}' }), null);
  assert.equal(parseClaimEvent({ kind: KIND_CLAIM, tags: [['d', 'espectro:perfil:x']], content: '{"v":1,"username":"x"}' }), null);
  assert.equal(parseClaimEvent({ kind: KIND_CLAIM, tags: [['d', claimTag('x')]], content: 'no-json' }), null);
});

test('pickEarliestClaim: gana el reclamo más antiguo', () => {
  const a = { username: 'u', created_at: 200 };
  const b = { username: 'u', created_at: 100 };
  assert.equal(pickEarliestClaim([a, b]), b);
  assert.equal(pickEarliestClaim([]), null);
});

test('verifyCredentials compara pubkeys', async () => {
  const sk = await deriveSecretKey('luis', 'password123');
  const pub = getPublicKey(sk);
  assert.ok(verifyCredentials(pub, { pubkey: pub }));
  assert.ok(!verifyCredentials(pub, { pubkey: '0'.repeat(64) }));
  assert.ok(!verifyCredentials(pub, null));
});
