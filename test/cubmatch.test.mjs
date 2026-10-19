// Tests de la capa de citas Nostr: eventos de perfil, likes, reportes
// (round-trip sin red; el e2e con mock relay está en e2e.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND_PERFIL, KIND_LIKE, KIND_REPORTE, TAG_D, TAG_T, RELAYS_DEFAULT,
  profileAddr, pubkeyFromAddr, buildPerfilEvent, parsePerfilEvent,
  buildLikeEvent, buildDislikeEvent, parseLikeEvent, mutualMatches,
  buildReporteEvent, parseReporteEvent,
} from '../src/cubmatch.js';
import { newProfile } from '../src/perfil.js';

const PK_A = 'a'.repeat(64), PK_B = 'b'.repeat(64);

test('relays por defecto: 5, todos wss', () => {
  assert.equal(RELAYS_DEFAULT.length, 5);
  assert.ok(RELAYS_DEFAULT.every((u) => u.startsWith('wss://')));
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

test('reporte NIP-56: build → parse', () => {
  const tpl = buildReporteEvent(PK_B, 'perfil falso');
  assert.equal(tpl.kind, KIND_REPORTE);
  const parsed = parseReporteEvent({ ...tpl, pubkey: PK_A, created_at: 7, id: 'r1' });
  assert.equal(parsed.target, PK_B);
  assert.equal(parsed.motivo, 'perfil falso');
  assert.equal(parsed.reporter, PK_A);
  assert.equal(parseReporteEvent({ kind: 1, tags: [], content: '{}' }), null);
});
