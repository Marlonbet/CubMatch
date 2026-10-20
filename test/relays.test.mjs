// v1.1: arquitectura de relays — 10002/10050, inbox NIP-17, enrutado de DMs,
// caché del inbox, conexiones lazy (acquire/release).
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startMockRelay } from './mock-relay.mjs';
import { RelayPool, RELAYS, ALL_RELAYS } from '../src/red.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import {
  KIND_DM_INBOX,
  buildDMInboxEvent,
  publishIdentityDocs, fetchDMInbox, resolveDMTargets, sendDMRouted,
  setInboxStore,
} from '../src/cubmatch.js';

const R1 = startMockRelay(3321); // discovery
const R2 = startMockRelay(3322); // messaging
const D = 'ws://127.0.0.1:3321';
const M = 'ws://127.0.0.1:3322';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const wire = (ev) => JSON.parse(JSON.stringify(ev));
const mkPool = (sk, graceMs = 10000) => new RelayPool({
  secretKey: sk, WSImpl: WebSocket,
  relays: { discovery: [D], messaging: [M] },
  graceMs,
});

function injectRaw(port, ev) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    const done = (v) => { try { ws.close(); } catch {} resolve(v); };
    ws.on('open', () => ws.send(JSON.stringify(['EVENT', ev])));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg[0] === 'OK') done(msg);
      } catch {}
    });
    ws.on('error', () => done(null));
    setTimeout(() => done(null), 3000);
  });
}

const hasDMto = (stored, peer) =>
  stored.some((e) => e.kind === 4 && e.tags.some((t) => t[0] === 'p' && t[1] === peer));

test('10002/10050: se publican y el inbox ajeno se lee con firma válida', async () => {
  const skA = generateSecretKey(); const pkA = getPublicKey(skA);
  const skB = generateSecretKey();
  const poolA = mkPool(skA); const poolB = mkPool(skB);
  await publishIdentityDocs(poolA);
  await wait(400);
  const inbox = await fetchDMInbox(poolB, pkA);
  assert.ok(inbox, 'inbox encontrado');
  assert.deepEqual(inbox, [M], 'el inbox anuncia el scope messaging del pool');
  assert.ok(R1.stored.some((e) => e.kind === 10002 && e.pubkey === pkA), '10002 publicado en discovery');
  assert.ok(R2.stored.some((e) => e.kind === KIND_DM_INBOX && e.pubkey === pkA), '10050 publicado en messaging');
  poolA.shutdown(); poolB.shutdown();
});

test('sendDMRouted: respeta el inbox NIP-17 del destinatario', async () => {
  const skA = generateSecretKey();
  const skB = generateSecretKey(); const pkB = getPublicKey(skB);
  // B publica su inbox: solo el relay de messaging
  await injectRaw(3321, wire(finalizeEvent({ ...buildDMInboxEvent([M]), created_at: now() }, skB)));
  await wait(300);

  const poolA = mkPool(skA);
  const { event } = await sendDMRouted(poolA, pkB, 'hola con inbox');
  await wait(300);
  assert.ok(hasDMto(R2.stored, pkB), 'el DM llegó al relay de messaging (inbox)');
  assert.ok(!hasDMto(R1.stored, pkB), 'el DM NO se publicó en discovery');
  // B lo puede descifrar
  const poolB = mkPool(skB);
  const text = await poolB.messaging().decryptDM(R2.stored.find((e) => e.id === event.id));
  assert.equal(text, 'hola con inbox');
  poolA.shutdown(); poolB.shutdown();
});

test('sendDMRouted: sin 10050 usa todo messaging (peer con versión vieja)', async () => {
  const skA = generateSecretKey();
  const skC = generateSecretKey(); const pkC = getPublicKey(skC); // C no publica inbox
  const poolA = mkPool(skA);
  await sendDMRouted(poolA, pkC, 'hola sin inbox');
  await wait(300);
  assert.ok(hasDMto(R2.stored, pkC), 'fallback: DM en messaging');
  assert.ok(!hasDMto(R1.stored, pkC), 'no en discovery');
  poolA.shutdown();
});

test('sendDMRouted: inbox con relay desconocido → fallback a messaging', async () => {
  const skA = generateSecretKey();
  const skD = generateSecretKey(); const pkD = getPublicKey(skD);
  await injectRaw(3321, wire(finalizeEvent(
    { ...buildDMInboxEvent(['wss://otro-relay.example']), created_at: now() }, skD)));
  await wait(300);
  const poolA = mkPool(skA);
  const targets = await resolveDMTargets(poolA, pkD);
  assert.deepEqual(targets, [M], 'sin intersección: fallback a messaging del pool');
  poolA.shutdown();
});

test('fetchDMInbox: usa la caché dentro del TTL sin ir a la red', async () => {
  const skA = generateSecretKey();
  const pkX = 'f'.repeat(64); // nadie publica nada para X
  const mem = new Map();
  setInboxStore({
    get: (k) => (mem.has(k) ? mem.get(k) : null),
    set: (k, v) => { mem.set(k, v); },
  });
  // Semilla manual en caché (como si un fetch anterior la hubiera guardado)
  mem.set('inbox:' + pkX, { relays: ['wss://cacheado.test'], ts: Date.now() });
  const poolA = mkPool(skA);
  const inbox = await fetchDMInbox(poolA, pkX);
  assert.deepEqual(inbox, ['wss://cacheado.test'], 'devuelve la caché sin consultar relays');
  poolA.shutdown();
});

test('RelayPool: acquire conecta solo su scope; release lo baja tras la gracia', async () => {
  const pool = mkPool(generateSecretKey(), 60);
  assert.equal(pool.discovery().status(D), 'down');
  assert.equal(pool.messaging().status(M), 'down');
  pool.acquire('discovery');
  await wait(400);
  assert.equal(pool.discovery().status(D), 'open', 'discovery conecta al adquirir');
  assert.equal(pool.messaging().status(M), 'down', 'messaging sigue abajo (lazy)');
  pool.acquire('messaging');
  pool.release('messaging');
  pool.release('discovery');
  await wait(30);
  assert.equal(pool.discovery().status(D), 'open', 'gracia: sigue abierto justo tras liberar');
  await wait(200);
  assert.equal(pool.discovery().status(D), 'down', 'tras la gracia se cierra');
  assert.equal(pool.messaging().status(M), 'down');
  // re-adquirir tras la gracia reconecta
  pool.acquire('messaging');
  await wait(400);
  assert.equal(pool.messaging().status(M), 'open', 're-adquire reconecta');
  pool.shutdown();
  R1.wss.close(); R2.wss.close();
});
