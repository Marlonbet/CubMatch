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
  buildDMInboxEvent, parseDMInboxEvent,
  mergePerfiles, mergeLikes,
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
