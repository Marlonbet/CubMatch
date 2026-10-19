// C2: semántica del flag read en DMs.
// - dmToMsg: entrante y enviado importados del historial quedan read:false.
// - El badge (noLeidos) cuenta el entrante como nuevo.
// - handleReceipt: un receipt válido del peer voltea el enviado a read:true;
//   un receipt manipulado no voltea nada.
// Parte en jsdom (app.js necesita window/document) + parte contra mock relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { JSDOM } from 'jsdom';
import { startMockRelay } from './mock-relay.mjs';
import { NostrClient } from '../src/red.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';

// jsdom ANTES de importar app.js (el módulo toca window/document al cargarse)
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const { wss } = startMockRelay(3312);
const RELAYS = ['ws://127.0.0.1:3312'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const wire = (ev) => JSON.parse(JSON.stringify(ev));

const skA = generateSecretKey(); const pkA = getPublicKey(skA);
const skB = generateSecretKey(); const pkB = getPublicKey(skB);

await import('../src/app.js');
await wait(100); // deja correr el boot automático del import
const T = window.__cubmatchApp._test;
assert.ok(T, 'hook _test expuesto');
const S = () => T.getS();

test('dmToMsg: entrante y enviado importados quedan read:false; manipulado se descarta', async () => {
  const s = S();
  s.pubkey = pkB;
  s.client = { decryptDM: async () => 'texto descifrado' };
  s.chats = {};

  const mkDM = (sk, to, ts) =>
    finalizeEvent({ kind: 4, created_at: ts, tags: [['p', to]], content: 'cifrado' }, sk);
  const t0 = now();
  const rIn = await T.dmToMsg(mkDM(skA, pkB, t0));
  assert.equal(rIn.msg.from, 'peer');
  assert.equal(rIn.msg.read, false, 'entrante importado: no leído');
  const rOut = await T.dmToMsg(mkDM(skB, pkA, t0 + 1));
  assert.equal(rOut.msg.from, 'me');
  assert.equal(rOut.msg.read, false, 'enviado importado: pendiente de receipt');
  // DM manipulado post-firma → null (C1 también cubre DMs)
  const bad = wire({ ...mkDM(skA, pkB, t0 + 2), content: 'otro' });
  assert.equal(await T.dmToMsg(bad), null, 'DM con firma inválida se descarta');
});

test('historial: entrante queda no leído (badge) y receipt válido voltea el enviado', async () => {
  const cA = new NostrClient({ relays: RELAYS, secretKey: skA, WSImpl: WebSocket });
  const cB = new NostrClient({ relays: RELAYS, secretKey: skB, WSImpl: WebSocket });
  cA.connect(); cB.connect();
  await wait(400);

  // A escribe a B (cifrado real NIP-04)
  await cA.sendDM(pkB, 'Hola B, ¿cómo estás?');
  await wait(300);

  // B importa el historial en la app
  const s = S();
  s.pubkey = pkB;
  s.client = cB;
  s.chats = {};
  await T.syncChatHistory();

  const chat = s.chats[pkA];
  assert.ok(chat && chat.length === 1, 'el DM entrante se importó');
  assert.equal(chat[0].from, 'peer');
  assert.equal(chat[0].text, 'Hola B, ¿cómo estás?');
  assert.equal(chat[0].read, false, 'el entrante queda NO leído al importar');
  assert.equal(T.noLeidos(chat), 1, 'el badge lo cuenta como nuevo');

  // B envía dos mensajes a A
  const { event: dm1 } = await cB.sendDM(pkA, 'Hola A, todo bien');
  const { event: dm2 } = await cB.sendDM(pkA, '¿Y tú?');
  await wait(300);
  await T.syncChatHistory();
  const m1 = s.chats[pkA].find((m) => m.id === dm1.id);
  const m2 = s.chats[pkA].find((m) => m.id === dm2.id);
  assert.ok(m1 && m2, 'enviados importados');
  assert.equal(m1.read, false, 'enviado pendiente de receipt');
  assert.equal(m2.read, false);

  // A envía receipt del primero (evento bien firmado por A)
  const receipt = wire(finalizeEvent({
    kind: 24503, created_at: now(),
    tags: [['p', pkB], ['e', dm1.id]],
    content: String(now()),
  }, skA));
  assert.equal(T.handleReceipt(pkA, receipt), true, 'receipt válido procesado');
  assert.equal(m1.read, true, 'el enviado pasa a ✓✓ con su receipt');
  assert.equal(m2.read, false, 'el otro sigue pendiente');

  // Receipt manipulado post-firma: no voltea nada (id distinto para no
  // chocar con el dedup de verificación)
  const bad = wire({ ...finalizeEvent({
    kind: 24503, created_at: now(),
    tags: [['p', pkB], ['e', dm2.id]],
    content: String(now()),
  }, skA), content: '9999999999' });
  assert.equal(T.handleReceipt(pkA, bad), false, 'receipt manipulado se descarta');
  assert.equal(m2.read, false, 'el manipulado no voltea el flag');

  cA.close(); cB.close();
  wss.close();
  dom.window.close();
});
