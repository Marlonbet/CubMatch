// Hallazgo M3 (listener global de DMs y likes): verifica contra mock
// relays que los filtros en vivo que usa startGlobalLive en app.js
// entregan eventos reales, y que el like entrante se verifica, se
// parsea y se integra detectando el match mutuo nuevo.
// (app.js no se importa aquí: es módulo DOM; los filtros se replican
// tal cual para validar el cableado de red.)
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startMockRelay } from './mock-relay.mjs';
import { RelayPool, KIND_DM, eventoValido } from '../src/red.js';
import {
  KIND_LIKE, profileAddr, parseLikeEvent, integrarLikeEntrante, sendLike,
  sendDMRouted,
} from '../src/cubmatch.js';
import { getPublicKey, generateSecretKey } from 'nostr-tools';

const R1 = startMockRelay(3323); // discovery
const R2 = startMockRelay(3324); // messaging
const RELAYS = {
  discovery: ['ws://127.0.0.1:3323'],
  messaging: ['ws://127.0.0.1:3324'],
};
const mkPool = (sk) => new RelayPool({ secretKey: sk, WSImpl: WebSocket, relays: RELAYS });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('M3: like y DM entrantes llegan por la suscripción global en vivo', async () => {
  const skA = generateSecretKey();
  const skB = generateSecretKey();
  const pkA = getPublicKey(skA);
  const pkB = getPublicKey(skB);
  const poolA = mkPool(skA);
  const poolB = mkPool(skB);

  // Réplica exacta de startGlobalLive (src/app.js) para A.
  const since = Math.floor(Date.now() / 1000);
  const dms = [], likes = [];
  const subDM = poolA.messaging().subscribe(
    [{ kinds: [KIND_DM], '#p': [pkA], since }],
    (ev) => dms.push(ev)
  );
  const subLike = poolA.discovery().subscribe(
    [{ kinds: [KIND_LIKE], '#a': [profileAddr(pkA)], since }],
    (ev) => likes.push(ev)
  );
  await wait(300);

  // B le da like a A y le escribe (como la app real: publishAll / routed).
  await sendLike(poolB, pkA);
  await sendDMRouted(poolB, pkA, 'Hola, ¿qué tal?');
  await wait(800);

  assert.equal(likes.length, 1, 'el like de B llega en vivo a A');
  const lev = likes[0];
  assert.ok(eventoValido(lev), 'firma del like válida (C1)');
  const like = parseLikeEvent(lev, pkA);
  assert.equal(like.peer, pkB);
  assert.equal(like.tipo, '+');

  // A ya le había dado like a B → integrarLikeEntrante detecta match nuevo.
  const mapa = { sent: { [pkB]: { tipo: '+', ts: since - 10 } }, received: {} };
  const res = integrarLikeEntrante(mapa, like);
  assert.equal(res.changed, true);
  assert.equal(res.nuevoMatch, true, 'like mutuo nuevo detectado');

  assert.equal(dms.length, 1, 'el DM de B llega en vivo a A');
  const texto = await poolA.messaging().decryptDM(dms[0]);
  assert.equal(texto, 'Hola, ¿qué tal?');

  subDM.unsub(); subLike.unsub();
  poolA.shutdown(); poolB.shutdown();
  R1.wss.close(); R2.wss.close();
});
