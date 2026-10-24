// Tests de la capa de citas Nostr: eventos de perfil, likes, reportes
// (round-trip sin red; el e2e con mock relay está en e2e.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND_PERFIL, KIND_LIKE, KIND_REPORTE, KIND_RELAY_LIST, KIND_DM_INBOX, TAG_D, TAG_T,
  profileAddr, pubkeyFromAddr, buildPerfilEvent, parsePerfilEvent,
  buildLikeEvent, buildDislikeEvent, parseLikeEvent, mutualMatches,
  buildReporteEvent, parseReporteEvent,
  buildRelayListEvent, parseRelayListEvent,
  buildDMInboxEvent, parseDMInboxEvent, inboxDesactualizado, migrarInboxSiDesactualizado,
  publishIdentityDocs,
  mergePerfiles, mergeLikes, integrarLikeEntrante,
} from '../src/cubmatch.js';
import { RELAYS, ALL_RELAYS } from '../src/red.js';
import { newProfile } from '../src/perfil.js';

const PK_A = 'a'.repeat(64), PK_B = 'b'.repeat(64);

test('relays con roles: 4 en total (2 discovery + 2 messaging), todos wss', () => {
  assert.deepEqual(Object.keys(RELAYS).sort(), ['discovery', 'messaging']);
  assert.equal(RELAYS.discovery.length, 2);
  assert.equal(RELAYS.messaging.length, 2);
  assert.equal(ALL_RELAYS.length, 4);
  assert.ok(ALL_RELAYS.every((u) => u.startsWith('wss://')));
  assert.equal(new Set(ALL_RELAYS).size, 4);
});

test('profileAddr / pubkeyFromAddr', () => {
  const addr = profileAddr(PK_A);
  assert.equal(addr, `30079:${PK_A}:cubmatch-v1`);
  assert.equal(pubkeyFromAddr(addr), PK_A);
  assert.equal(pubkeyFromAddr('30078:x:cubmatch-v1'), null);
  assert.equal(pubkeyFromAddr('basura'), null);
});

test('perfil kind 30079: build → parse round-trip', () => {
  const p = newProfile(); p.apodo = 'Ana'; p.edad = 25;
  const tpl = buildPerfilEvent(p);
  assert.equal(tpl.kind, KIND_PERFIL);
  assert.deepEqual(tpl.tags, [['d', TAG_D], ['t', TAG_T]]);
  const ev = { ...tpl, pubkey: PK_A, created_at: 999, id: 'ev1' };
  const parsed = parsePerfilEvent(ev);
  assert.ok(parsed);
  assert.equal(parsed.profile.apodo, 'Ana');
  assert.equal(parsed.pubkey, PK_A);
  assert.equal(parsed.addr, profileAddr(PK_A));
});

test('parsePerfilEvent rechaza eventos ajenos', () => {
  assert.equal(parsePerfilEvent({ kind: 30078, tags: [['d', TAG_D]], content: '{"v":1,"apodo":"x"}' }), null);
  assert.equal(parsePerfilEvent({ kind: KIND_PERFIL, tags: [['d', 'otro']], content: '{"v":1,"apodo":"x"}' }), null);
  assert.equal(parsePerfilEvent({ kind: KIND_PERFIL, tags: [['d', TAG_D]], content: 'no-json' }), null);
  assert.equal(parsePerfilEvent({ kind: KIND_PERFIL, tags: [['d', TAG_D]], content: '{"v":2,"apodo":"x"}' }), null);
  assert.equal(parsePerfilEvent({ kind: KIND_PERFIL, tags: [['d', TAG_D]], content: '{"v":1}' }), null);
});

test('like: build → parse (enviado y recibido)', () => {
  const tpl = buildLikeEvent(PK_B);
  assert.equal(tpl.kind, KIND_LIKE);
  assert.equal(tpl.content, '+');
  // como lo ve B (recibido)
  const rec = parseLikeEvent({ ...tpl, pubkey: PK_A, created_at: 5, id: 'l1' }, PK_B);
  assert.equal(rec.tipo, '+');
  assert.equal(rec.peer, PK_A);
  assert.equal(rec.to, PK_B);
  // como lo ve A (enviado)
  const sent = parseLikeEvent({ ...tpl, pubkey: PK_A, created_at: 5, id: 'l1' }, PK_A);
  assert.equal(sent.peer, PK_B);
  assert.equal(sent.to, PK_B);
});

test('super-like lleva el tag correspondiente', () => {
  const tpl = buildLikeEvent(PK_B, { superlike: true });
  const parsed = parseLikeEvent({ ...tpl, pubkey: PK_A, created_at: 5, id: 'l2' }, PK_B);
  assert.ok(parsed.superlike);
  assert.equal(parsed.tipo, '+');
});

test('dislike usa contenido "-"', () => {
  const tpl = buildDislikeEvent(PK_B);
  assert.equal(tpl.content, '-');
  const parsed = parseLikeEvent({ ...tpl, pubkey: PK_A, created_at: 5, id: 'l3' }, PK_B);
  assert.equal(parsed.tipo, '-');
});

test('parseLikeEvent rechaza basura', () => {
  assert.equal(parseLikeEvent({ kind: KIND_LIKE, tags: [], content: '+' }, PK_A), null);
  assert.equal(parseLikeEvent({ kind: KIND_LIKE, tags: [['a', profileAddr(PK_B)]], content: '❤' }, PK_A), null);
});

test('mutualMatches: solo "+" en ambas direcciones', () => {
  const sent = { [PK_B]: { tipo: '+', ts: 1 }, [PK_A]: { tipo: '+', ts: 1 } };
  const received = { [PK_B]: { tipo: '+', ts: 2 }, ['c'.repeat(64)]: { tipo: '+', ts: 2 } };
  assert.deepEqual(mutualMatches(sent, received), [PK_B]);
  const received2 = { [PK_B]: { tipo: '-', ts: 2 } };
  assert.deepEqual(mutualMatches(sent, received2), []);
});

test('10002 (NIP-65) y 10050 (NIP-17): build → parse round-trip', () => {
  const relays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.damus.io']; // duplicado a propósito
  const t1 = buildRelayListEvent(relays);
  assert.equal(t1.kind, KIND_RELAY_LIST);
  assert.deepEqual(t1.tags, [['r', 'wss://relay.damus.io'], ['r', 'wss://nos.lol']]);
  const p1 = parseRelayListEvent({ ...t1, pubkey: PK_A, created_at: 10, id: 'r1' });
  assert.ok(p1);
  assert.deepEqual(p1.relays, ['wss://relay.damus.io', 'wss://nos.lol']);
  assert.equal(p1.pubkey, PK_A);

  const t2 = buildDMInboxEvent(['wss://relay.primal.net']);
  assert.equal(t2.kind, KIND_DM_INBOX);
  const p2 = parseDMInboxEvent({ ...t2, pubkey: PK_B, created_at: 11, id: 'r2' });
  assert.deepEqual(p2.relays, ['wss://relay.primal.net']);

  // Rechaza kinds ajenos y basura
  assert.equal(parseRelayListEvent({ kind: KIND_DM_INBOX, tags: [], pubkey: PK_A }), null);
  assert.equal(parseDMInboxEvent({ kind: KIND_RELAY_LIST, tags: [], pubkey: PK_A }), null);
  assert.equal(parseRelayListEvent(null), null);
  // Solo ws(s):// pasa el filtro
  const t3 = buildRelayListEvent(['wss://a.io', 'ws://c.io', 'https://b.io', 'nota-relay']);
  assert.deepEqual(t3.tags, [['r', 'wss://a.io'], ['r', 'ws://c.io']]);
});

test('messaging por defecto: primal + nostr.mom (relay.nostr.band sustituido en v1.8.2)', () => {
  assert.deepEqual(RELAYS.messaging, ['wss://relay.primal.net', 'wss://nostr.mom']);
  assert.ok(!ALL_RELAYS.some((u) => u.includes('nostr.band')));
});

test('inboxDesactualizado: comparación por conjuntos contra el messaging actual', () => {
  const cur = ['wss://relay.primal.net', 'wss://nostr.mom'];
  assert.equal(inboxDesactualizado(cur, cur), false);
  assert.equal(inboxDesactualizado([...cur].reverse(), cur), false, 'el orden no importa');
  assert.equal(inboxDesactualizado(['wss://relay.primal.net', 'wss://relay.nostr.band'], cur), true, 'lista vieja con band');
  assert.equal(inboxDesactualizado(null, cur), true, 'sin registro local (versión vieja) → migra');
  assert.equal(inboxDesactualizado('basura', cur), true, 'basura → migra');
  assert.equal(inboxDesactualizado([], cur), true, 'vacía → migra');
});

test('migración 10050: publicado con band → se republica con nostr.mom', async () => {
  const publicados = [];
  const pool = {
    roles: { discovery: [...RELAYS.discovery], messaging: [...RELAYS.messaging] },
    publishAll: async (ev) => { publicados.push(ev); return [true, true]; },
  };
  let guardado = ['wss://relay.primal.net', 'wss://relay.nostr.band'];
  const store = { get: () => guardado, set: (r) => { guardado = r; } };

  const migro = await migrarInboxSiDesactualizado(pool, store);
  assert.equal(migro, true);
  const inbox = publicados.find((e) => e.kind === KIND_DM_INBOX);
  assert.ok(inbox, 'se republicó el 10050');
  assert.deepEqual(
    inbox.tags.map((t) => t[1]).sort(),
    ['wss://nostr.mom', 'wss://relay.primal.net'],
    'el 10050 nuevo anuncia primal + nostr.mom, sin band',
  );
  const lista = publicados.find((e) => e.kind === KIND_RELAY_LIST);
  assert.ok(lista && !lista.tags.some((t) => String(t[1]).includes('nostr.band')), 'el 10002 tampoco anuncia band');
  assert.deepEqual(guardado, [...RELAYS.messaging], 'queda registrada la lista nueva');

  // Segunda vez: ya correcto → no se toca.
  publicados.length = 0;
  assert.equal(await migrarInboxSiDesactualizado(pool, store), false);
  assert.equal(publicados.length, 0, 'sin publicaciones cuando ya está al día');
});

test('migración 10050: usuario sin registro local (versión vieja) migra una vez', async () => {
  const publicados = [];
  const pool = {
    roles: { discovery: [...RELAYS.discovery], messaging: [...RELAYS.messaging] },
    publishAll: async (ev) => { publicados.push(ev); return [true, true]; },
  };
  const store = { get: () => null, set: () => {} };
  assert.equal(await migrarInboxSiDesactualizado(pool, store), true);
  assert.ok(publicados.some((e) => e.kind === KIND_DM_INBOX));
});

test('publishIdentityDocs: el 10050 sale con el scope messaging del pool', async () => {
  const publicados = [];
  const pool = {
    roles: { discovery: ['wss://d1.test'], messaging: ['wss://m1.test', 'wss://m2.test'] },
    publishAll: async (ev) => { publicados.push(ev); return [true]; },
  };
  await publishIdentityDocs(pool);
  const inbox = publicados.find((e) => e.kind === KIND_DM_INBOX);
  assert.deepEqual(inbox.tags.map((t) => t[1]), ['wss://m1.test', 'wss://m2.test']);
});

test('mergePerfiles: dedup por id y newest-wins por autor', () => {
  const mk = (pubkey, id, created_at, apodo) => ({ pubkey, id, created_at, profile: { apodo } });
  const cached = [mk(PK_A, 'id1', 100, 'Ana'), mk(PK_B, 'id2', 100, 'Luis')];
  const fresh = [
    mk(PK_A, 'id1', 100, 'Ana'),            // duplicado exacto → se ignora
    mk(PK_A, 'id3', 200, 'Ana Nueva'),      // mismo autor, más nuevo → gana
    mk('c'.repeat(64), 'id4', 150, 'Marta'), // autor nuevo → se agrega
    mk(PK_B, 'id5', 50, 'Luis Viejo'),      // mismo autor, más viejo → pierde
  ];
  const out = mergePerfiles(cached, fresh);
  assert.equal(out.length, 3);
  const byPk = Object.fromEntries(out.map((p) => [p.pubkey, p]));
  assert.equal(byPk[PK_A].profile.apodo, 'Ana Nueva');
  assert.equal(byPk[PK_B].profile.apodo, 'Luis');
  assert.equal(byPk['c'.repeat(64)].profile.apodo, 'Marta');
});

test('mergeLikes: por contraparte gana el ts más nuevo', () => {
  const cached = {
    sent: { [PK_A]: { tipo: '+', ts: 100 } },
    received: { [PK_B]: { tipo: '+', ts: 100 } },
  };
  const fresh = {
    sent: { [PK_A]: { tipo: '-', ts: 200 }, ['d'.repeat(64)]: { tipo: '+', ts: 50 } },
    received: { [PK_B]: { tipo: '+', ts: 50 } }, // más viejo → no pisa
  };
  const out = mergeLikes(cached, fresh);
  assert.equal(out.sent[PK_A].tipo, '-');
  assert.equal(out.sent['d'.repeat(64)].tipo, '+');
  assert.equal(out.received[PK_B].ts, 100);
});

test('reporte NIP-56: build → parse', () => {
  const tpl = buildReporteEvent(PK_B, 'perfil falso');
  assert.equal(tpl.kind, KIND_REPORTE);
  const parsed = parseReporteEvent({ ...tpl, pubkey: PK_A, created_at: 7, id: 'r1' });
  assert.equal(parsed.target, PK_B);
  assert.equal(parsed.motivo, 'perfil falso');
  assert.equal(parsed.reporter, PK_A);
  assert.equal(parseReporteEvent({ kind: 1, tags: [], content: '{}' }), null);
});

test('integrarLikeEntrante: like nuevo se integra y detecta el match', () => {
  const likes = { sent: { [PK_B]: { tipo: '+', ts: 100 } }, received: {} };
  const like = { peer: PK_B, tipo: '+', superlike: false, created_at: 200 };
  const r = integrarLikeEntrante(likes, like);
  assert.equal(r.changed, true);
  assert.equal(r.nuevoMatch, true, 'yo le di + y ahora me da + → match nuevo');
  assert.equal(likes.received[PK_B].tipo, '+');
  assert.equal(likes.received[PK_B].ts, 200);
});

test('integrarLikeEntrante: like más viejo no pisa al nuevo', () => {
  const likes = { sent: {}, received: { [PK_B]: { tipo: '+', ts: 300 } } };
  const r = integrarLikeEntrante(likes, { peer: PK_B, tipo: '-', created_at: 100 });
  assert.equal(r.changed, false);
  assert.equal(r.nuevoMatch, false);
  assert.equal(likes.received[PK_B].tipo, '+');
});

test('integrarLikeEntrante: el más nuevo reemplaza (match ya existía → no re-avisa)', () => {
  const likes = {
    sent: { [PK_B]: { tipo: '+', ts: 100 } },
    received: { [PK_B]: { tipo: '+', ts: 150 } },
  };
  const r = integrarLikeEntrante(likes, { peer: PK_B, tipo: '+', created_at: 400 });
  assert.equal(r.changed, true);
  assert.equal(r.nuevoMatch, false, 'ya era mutuo: no es un match NUEVO');
  assert.equal(likes.received[PK_B].ts, 400);
});

test('integrarLikeEntrante: dislike recibido no crea match', () => {
  const likes = { sent: { [PK_B]: { tipo: '+', ts: 100 } }, received: {} };
  const r = integrarLikeEntrante(likes, { peer: PK_B, tipo: '-', created_at: 200 });
  assert.equal(r.changed, true);
  assert.equal(r.nuevoMatch, false);
  assert.equal(likes.received[PK_B].tipo, '-');
});

test('integrarLikeEntrante: like sin "+" mío no es match', () => {
  const likes = { sent: { [PK_B]: { tipo: '-', ts: 100 } }, received: {} };
  const r = integrarLikeEntrante(likes, { peer: PK_B, tipo: '+', created_at: 200 });
  assert.equal(r.changed, true);
  assert.equal(r.nuevoMatch, false, 'yo le di - → aunque me dé +, no hay match');
});

test('integrarLikeEntrante: entradas inválidas no rompen nada', () => {
  assert.deepEqual(integrarLikeEntrante(null, { peer: PK_B }), { changed: false, nuevoMatch: false });
  assert.deepEqual(integrarLikeEntrante({}, null), { changed: false, nuevoMatch: false });
  const likes = { sent: {}, received: {} };
  assert.deepEqual(integrarLikeEntrante(likes, { tipo: '+' }), { changed: false, nuevoMatch: false });
  assert.deepEqual(likes.received, {}, 'sin peer válido no se toca received');
});

test('integrarLikeEntrante: crea received si no existía', () => {
  const likes = { sent: {} };
  const r = integrarLikeEntrante(likes, { peer: PK_B, tipo: '+', superlike: true, created_at: 10 });
  assert.equal(r.changed, true);
  assert.equal(likes.received[PK_B].superlike, true);
});
