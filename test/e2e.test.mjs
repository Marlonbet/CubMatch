// E2E de CubMatch contra mock relay (sin internet):
// registro → publicar perfil → descubrir → like mutuo → match → DM cifrado.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startMockRelay } from './mock-relay.mjs';
import { RelayPool } from '../src/red.js';
import {
  deriveSecretKey, buildClaimEvent, parseClaimEvent,
} from '../src/cuentas.js';
import {
  publishPerfil, fetchPerfiles, sendLike, fetchLikes, mutualMatches,
  profileAddr, publishIdentityDocs, sendDMRouted, fetchDMInbox,
} from '../src/cubmatch.js';
import { newProfile } from '../src/perfil.js';
import { getPublicKey } from 'nostr-tools';

const { wss } = startMockRelay(3299);
const RELAYS = ['ws://127.0.0.1:3299'];
const mkPool = (sk) => new RelayPool({
  secretKey: sk, WSImpl: WebSocket,
  relays: { discovery: RELAYS, messaging: RELAYS },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function perfilBase(apodo, edad, genero, busca) {
  const p = newProfile();
  Object.assign(p, {
    apodo, edad, genero, orientacion: 'hetero',
    provincia: 'Santiago de Cuba', municipio: 'Santiago',
    valores: ['familia'], intereses: ['música'], bio: 'Hola',
    prefs: { edadMin: 18, edadMax: 99, generos: busca, distancia: 'cuba', relacion: ['romance'] },
  });
  return p;
}

test('flujo completo CubMatch', async () => {
  // 1. Registro: derivar claves de usuario+contraseña
  const skAna = await deriveSecretKey('ana.cubmatch', 'claveSegura1');
  const skLuis = await deriveSecretKey('luis.cubmatch', 'claveSegura2');
  const pkAna = getPublicKey(skAna), pkLuis = getPublicKey(skLuis);
  assert.notEqual(pkAna, pkLuis);

  const poolAna = mkPool(skAna);
  const poolLuis = mkPool(skLuis);
  poolAna.acquire('discovery');
  await wait(500);
  assert.equal(poolAna.discovery().status(RELAYS[0]), 'open');
  poolAna.release('discovery');

  // 2. Reclamo de nombre (cuenta)
  await poolAna.publishAll(buildClaimEvent('ana.cubmatch'));
  await wait(300);
  const claims = [];
  const sub = poolLuis.discovery().subscribe(
    [{ kinds: [30078], '#d': ['cubmatch:perfil:ana.cubmatch'], limit: 5 }],
    (ev) => { const c = parseClaimEvent(ev); if (c) claims.push(c); }
  );
  await sub.eose(); sub.unsub();
  assert.ok(claims.some((c) => c.pubkey === pkAna), 'reclamo visible en la red');

  // 3. Publicar perfiles kind 30079
  await publishPerfil(poolAna, perfilBase('Ana', 25, 'mujer', ['hombre']));
  await publishPerfil(poolLuis, perfilBase('Luis', 28, 'hombre', ['mujer']));
  await wait(400);

  // 4. Descubrimiento cruzado
  const vistosPorLuis = await fetchPerfiles(poolLuis, { excludeSelf: pkLuis });
  assert.ok(vistosPorLuis.some((p) => p.pubkey === pkAna), 'Luis descubre a Ana');
  const anaVista = vistosPorLuis.find((p) => p.pubkey === pkAna);
  assert.equal(anaVista.profile.apodo, 'Ana');
  assert.equal(anaVista.addr, profileAddr(pkAna));

  // 5. Like mutuo → match
  await sendLike(poolLuis, pkAna);
  await sendLike(poolAna, pkLuis);
  await wait(400);
  const likesLuis = await fetchLikes(poolLuis, pkLuis);
  assert.equal(likesLuis.sent[pkAna]?.tipo, '+', 'like enviado registrado');
  assert.equal(likesLuis.received[pkAna]?.tipo, '+', 'like recibido registrado');
  assert.deepEqual(mutualMatches(likesLuis.sent, likesLuis.received), [pkAna]);

  // 6. Chat solo tras match: DM cifrado NIP-04
  let gotDM = null;
  const live = poolAna.messaging().subscribe(
    [{ kinds: [4], '#p': [pkAna], since: Math.floor(Date.now() / 1000) }],
    (ev) => { gotDM = ev; }
  );
  await wait(200);
  await sendDMRouted(poolLuis, pkAna, 'Hola Ana, ¿un café en Enramadas?');
  await wait(600);
  assert.ok(gotDM, 'Ana recibe el DM');
  const texto = await poolAna.messaging().decryptDM(gotDM);
  assert.equal(texto, 'Hola Ana, ¿un café en Enramadas?');
  live.unsub();

  // 7. Documentos de identidad (10002/10050) publicados y legibles
  await publishIdentityDocs(poolAna);
  await wait(400);
  const inbox = await fetchDMInbox(poolLuis, pkAna);
  assert.ok(inbox && inbox.length > 0, 'inbox NIP-17 de Ana legible por Luis');

  poolAna.shutdown(); poolLuis.shutdown();
  wss.close();
});
