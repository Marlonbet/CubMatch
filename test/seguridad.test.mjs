// C1: verificación de firmas en la ingesta (solo lectura+red, sin DOM).
// Un evento con firma inválida (suplantación de pubkey o contenido
// manipulado post-firma) debe descartarse ANTES de parsearse; el evento
// válido se acepta. Los tests están diseñados para FALLAR sin el fix:
// los forgeries llevan created_at más nuevo/viejo para ganar el
// newest-wins/earliest-wins si no se descartaran.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startMockRelay } from './mock-relay.mjs';
import { NostrClient, eventoValido } from '../src/red.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import {
  KIND_PERFIL, fetchPerfiles, fetchLikes, sendLike,
  buildPerfilEvent,
} from '../src/cubmatch.js';
import { fetchUsernameClaim, buildClaimEvent } from '../src/cuentas.js';
import { newProfile } from '../src/perfil.js';

const { wss } = startMockRelay(3311);
const RELAYS = ['ws://127.0.0.1:3311'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

// Simula el "wire": round-trip JSON (los Symbols no sobreviven, como en la red real).
const wire = (ev) => JSON.parse(JSON.stringify(ev));

// Inyecta un evento crudo en el relay (el relay no verifica firmas,
// igual que en la red real): simula lo que publicaría un atacante.
function injectRaw(ev) {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAYS[0]);
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

function perfilTemplate(apodo) {
  const p = newProfile();
  Object.assign(p, {
    apodo, edad: 25, genero: 'mujer', orientacion: 'hetero',
    provincia: 'La Habana', municipio: 'Plaza',
    valores: ['familia'], intereses: ['música'], bio: 'Hola',
    prefs: { edadMin: 18, edadMax: 99, generos: ['hombre'], distancia: 'cuba', relacion: ['romance'] },
  });
  return buildPerfilEvent(p);
}

test('eventoValido: acepta firmado, rechaza manipulado / suplantado / basura', () => {
  const sk = generateSecretKey();
  const ev = finalizeEvent({ kind: KIND_PERFIL, created_at: now(), tags: [], content: '{}' }, sk);
  assert.equal(eventoValido(ev), true, 'evento bien firmado se acepta');

  // Contenido manipulado post-firma → firma inválida
  assert.equal(eventoValido(wire({ ...ev, content: '{"x":1}' })), false, 'contenido manipulado se rechaza');
  // Pubkey suplantado (firma de otro) → inválida
  assert.equal(eventoValido(wire({ ...ev, pubkey: getPublicKey(generateSecretKey()) })), false, 'pubkey suplantado se rechaza');
  // Firma corrupta
  assert.equal(eventoValido(wire({ ...ev, sig: '00'.repeat(64) })), false, 'firma corrupta se rechaza');
  // Basura no lanza
  assert.equal(eventoValido(null), false);
  assert.equal(eventoValido({}), false);
  assert.equal(eventoValido({ id: 123 }), false);

  // Detalle no obvio (cache de nostr-tools): un evento mutado vía spread
  // hereda el Symbol de "verificado"; eventoValido debe detectarlo igual.
  const mutado = { ...ev, content: '{"hack":true}' }; // conserva el Symbol en memoria
  assert.equal(eventoValido(mutado), false, 'mutación con Symbol heredado también se rechaza');
});

test('fetchPerfiles: descarta perfil suplantado y contenido manipulado', async () => {
  const skA = generateSecretKey();
  const pkA = getPublicKey(skA);
  const skAtk = generateSecretKey();
  const client = new NostrClient({ relays: RELAYS, secretKey: generateSecretKey(), WSImpl: WebSocket });
  client.connect();
  await wait(400);

  // Perfil legítimo de A
  await injectRaw(wire(finalizeEvent({ ...perfilTemplate('AnaReal'), created_at: now() }, skA)));
  // Suplantación: pubkey de A, firmado por el atacante, created_at MAYOR
  // (sin verificación ganaría el newest-wins y coronaría el perfil falso).
  const spoof = finalizeEvent({ ...perfilTemplate('AnaFalsa'), created_at: now() }, skAtk);
  spoof.pubkey = pkA;
  spoof.created_at = now() + 100; // además rompe la firma a propósito
  await injectRaw(wire(spoof));
  // Manipulación: evento real de A con el contenido cambiado post-firma.
  const tpl = finalizeEvent({ ...perfilTemplate('AnaReal'), created_at: now() }, skA);
  const body = JSON.parse(tpl.content);
  body.apodo = 'AnaHackeada';
  tpl.content = JSON.stringify(body);
  tpl.created_at = now() + 200;
  await injectRaw(wire(tpl));
  await wait(300);

  const perfiles = await fetchPerfiles(client, {});
  const apodos = perfiles.map((p) => p.profile.apodo);
  assert.ok(apodos.includes('AnaReal'), 'el perfil válido se acepta');
  assert.ok(!apodos.includes('AnaFalsa'), 'perfil suplantado descartado');
  assert.ok(!apodos.includes('AnaHackeada'), 'contenido manipulado descartado');
  client.close();
});

test('fetchLikes: descarta like forjado', async () => {
  const skA = generateSecretKey();
  const pkA = getPublicKey(skA);
  const skB = generateSecretKey();
  const pkB = getPublicKey(skB);
  const skC = generateSecretKey();
  const pkC = getPublicKey(skC);
  const skAtk = generateSecretKey();
  const cA = new NostrClient({ relays: RELAYS, secretKey: skA, WSImpl: WebSocket });
  const cB = new NostrClient({ relays: RELAYS, secretKey: skB, WSImpl: WebSocket });
  cA.connect(); cB.connect();
  await wait(400);

  await sendLike(cA, pkB); // like real A → B
  await wait(300);
  // Like forjado: dice ser de C hacia B, firmado por el atacante.
  const forged = finalizeEvent({
    kind: 7, created_at: now(),
    tags: [['a', `30079:${pkB}:cubmatch-v1`], ['p', pkB], ['t', 'cubmatch']],
    content: '+',
  }, skAtk);
  forged.pubkey = pkC; // rompe la firma a propósito
  await injectRaw(wire(forged));
  await wait(300);

  const { received } = await fetchLikes(cB, pkB);
  assert.ok(received[pkA] && received[pkA].tipo === '+', 'el like real se acepta');
  assert.ok(!received[pkC], 'el like forjado se descarta');
  cA.close(); cB.close();
});

test('fetchUsernameClaim: descarta reclamo forjado con backdating', async () => {
  const skA = generateSecretKey();
  const skAtk = generateSecretKey();
  const pkAtk = getPublicKey(skAtk);
  const client = new NostrClient({ relays: RELAYS, secretKey: skA, WSImpl: WebSocket });
  client.connect();
  await wait(400);

  await client.publish(buildClaimEvent('realtest.c1'));
  await wait(300);
  // Reclamo forjado del atacante con created_at antiquísimo: sin verificación
  // ganaría el earliest-wins y robaría el nombre (M4). La firma se rompe
  // a propósito al cambiar created_at post-firma.
  const forged = finalizeEvent({ ...buildClaimEvent('realtest.c1'), created_at: now() }, skAtk);
  forged.created_at = 1;
  await injectRaw(wire(forged));
  await wait(300);

  const claim = await fetchUsernameClaim(client, 'realtest.c1');
  assert.ok(claim, 'hay reclamo');
  assert.notEqual(claim.pubkey, pkAtk, 'el reclamo forjado no gana aunque sea "más viejo"');
  assert.equal(claim.pubkey, getPublicKey(skA), 'el reclamo válido se mantiene');
  client.close();
  wss.close();
});
