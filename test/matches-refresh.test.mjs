// Bug reportado por Marlon (2026-10-29): al tocar "Actualizar" en
// Matches, un match desaparecía y reaparecía en Descubrir, o no salía
// en ningún lado; al cerrar sesión y volver a entrar, sí salía en
// Matches. Causas:
//  1) fetchLikes/fetchPerfiles consultaban SOLO el scope discovery y
//     solo caían a messaging si el resultado venía TOTALMENTE vacío
//     y degradado. Un like/perfil que vive solo en messaging
//     (publishAll resuelve con que UNO acepte) era invisible para el
//     refresco, aunque el listener en vivo ya lo hubiera integrado.
//  2) forceRefresh() borraba LS_LIKES y LS_PERFILES ANTES de
//     descargar: una descarga parcial (EOSE corta a los 8 s si un
//     relay va lento) se aceptaba como estado completo y borraba el
//     match conocido. Si faltaba el like recibido, el match salía de
//     Matches; si además faltaba el enviado, el perfil volvía a
//     Descubrir; si solo faltaba el recibido, no salía en ningún lado
//     (el enviado lo oculta del mazo).
// El arreglo: ambos scopes en paralelo con fusión (gana el más nuevo
// por contraparte/autor) y Actualizar ya no borra las cachés: la
// fusión solo suma/actualiza, nunca borra por ausencia en una descarga.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools';
import {
  fetchLikes, fetchPerfiles, mutualMatches,
  buildLikeEvent, buildDislikeEvent, buildPerfilEvent,
} from '../src/cubmatch.js';

const skYo = generateSecretKey();
const pkYo = getPublicKey(skYo);
const skPeer = generateSecretKey();
const pkPeer = getPublicKey(skPeer);

function likeDe(sk, target, tipo, ts) {
  const tpl = tipo === '+' ? buildLikeEvent(target) : buildDislikeEvent(target);
  return finalizeEvent({ ...tpl, created_at: ts }, sk);
}

function perfilDe(sk, apodo, ts) {
  const tpl = buildPerfilEvent({ apodo, edad: 25, genero: 'mujer', orientacion: 'hetero', provincia: 'La Habana', municipio: 'Plaza', valores: [], intereses: [], bio: 'Hola', prefs: {} });
  return finalizeEvent({ ...tpl, created_at: ts }, sk);
}

// Cliente falso: entrega sus eventos al suscribirse (sin red). Los
// filtros se ignoran: el parseo y la verificación de firma hacen el
// filtrado real, igual que con un relay de verdad.
function clienteFake(eventos) {
  return {
    subscribe(_filters, cb) {
      for (const ev of eventos) cb(ev);
      return { eose: async () => {}, unsub() {} };
    },
  };
}
function poolFake(disc, msg) {
  return {
    discovery: () => clienteFake(disc),
    messaging: () => clienteFake(msg),
    acquire() {}, release() {},
  };
}

test('fetchLikes: un like recibido que vive solo en messaging hace match', async () => {
  const enviado = likeDe(skYo, pkPeer, '+', 1000);
  const recibido = likeDe(skPeer, pkYo, '+', 1001);
  // Discovery trae solo el enviado; messaging, solo el recibido.
  const likes = await fetchLikes(poolFake([enviado], [recibido]), pkYo);
  assert.equal(likes.sent[pkPeer].tipo, '+');
  assert.equal(likes.received[pkPeer].tipo, '+');
  assert.deepEqual(mutualMatches(likes.sent, likes.received), [pkPeer]);
});

test('fetchLikes: entre scopes gana el más nuevo por contraparte', async () => {
  const viejo = likeDe(skPeer, pkYo, '+', 1000);
  const nuevo = likeDe(skPeer, pkYo, '-', 2000);
  const likes = await fetchLikes(poolFake([viejo], [nuevo]), pkYo);
  assert.equal(likes.received[pkPeer].tipo, '-');
  // Y al revés (nuevo en discovery, viejo en messaging): mismo resultado.
  const likes2 = await fetchLikes(poolFake([nuevo], [viejo]), pkYo);
  assert.equal(likes2.received[pkPeer].tipo, '-');
});

test('fetchPerfiles: un perfil que vive solo en messaging se devuelve', async () => {
  const ev = perfilDe(skPeer, 'Ana', 1000);
  const perfiles = await fetchPerfiles(poolFake([], [ev]), {});
  assert.equal(perfiles.length, 1);
  assert.equal(perfiles[0].pubkey, pkPeer);
  assert.equal(perfiles[0].profile.apodo, 'Ana');
});

test('fetchPerfiles: mismo autor en ambos scopes, gana el más nuevo', async () => {
  const viejo = perfilDe(skPeer, 'AnaVieja', 1000);
  const nuevo = perfilDe(skPeer, 'AnaNueva', 2000);
  const perfiles = await fetchPerfiles(poolFake([viejo], [nuevo]), {});
  assert.equal(perfiles.length, 1);
  assert.equal(perfiles[0].profile.apodo, 'AnaNueva');
});

test('forceRefresh: Actualizar NO borra las cachés de perfiles ni likes', () => {
  const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const m = src.match(/function forceRefresh\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'forceRefresh debe existir en app.js');
  assert.ok(!m[0].includes('LS_LIKES'), 'forceRefresh no debe borrar cache_likes: ' + m[0]);
  assert.ok(!m[0].includes('LS_PERFILES'), 'forceRefresh no debe borrar cache_perfiles: ' + m[0]);
  assert.ok(m[0].includes('LS_SYNC_D'), 'forceRefresh debe reiniciar lastSync para re-descargar todo');
});
