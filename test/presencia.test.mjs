// v1.8.0 — lógica pura de presencia (presencia.js):
// "en línea" = beacon hace <2 min (y sin despedida); textos honestos
// de "últ. vez"; parseo de beacons recibidos.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND_PRESENCIA, TTL_EN_LINEA_MS, estaEnLinea, textoPresencia, haceTexto, parseBeacon,
} from '../src/presencia.js';

const AHORA = 1_760_000_000_000; // ms, fijo para tests deterministas

test('estaEnLinea: fresco sí, caducado no, con off nunca', () => {
  assert.equal(estaEnLinea({ ts: AHORA - 30_000, off: false }, AHORA), true);
  assert.equal(estaEnLinea({ ts: AHORA - TTL_EN_LINEA_MS + 1, off: false }, AHORA), true, 'justo dentro del TTL');
  assert.equal(estaEnLinea({ ts: AHORA - TTL_EN_LINEA_MS, off: false }, AHORA), false, 'en el borde ya no');
  assert.equal(estaEnLinea({ ts: AHORA - 5 * 60_000, off: false }, AHORA), false);
  assert.equal(estaEnLinea({ ts: AHORA - 10_000, off: true }, AHORA), false, 'la despedida manda aunque sea fresca');
  assert.equal(estaEnLinea(null, AHORA), false);
  assert.equal(estaEnLinea(AHORA - 10_000, AHORA), true, 'acepta ts pelado (formato viejo)');
  assert.equal(estaEnLinea({ ts: AHORA + 20_000, off: false }, AHORA), true, 'reloj ajeno algo adelantado: en línea');
  assert.equal(estaEnLinea({ ts: AHORA + 120_000, off: false }, AHORA), false, 'futuro lejano no es creíble');
});

test('textoPresencia: en línea / última vez / sin datos no afirma nada', () => {
  assert.deepEqual(textoPresencia(null, AHORA), { enLinea: false, texto: '' });
  assert.deepEqual(textoPresencia({ ts: AHORA - 40_000, off: false }, AHORA), { enLinea: true, texto: 'En línea' });
  assert.deepEqual(textoPresencia({ ts: AHORA - 40_000, off: true }, AHORA),
    { enLinea: false, texto: 'Últ. vez hace un momento' });
  assert.equal(textoPresencia({ ts: AHORA - 5 * 60_000, off: false }, AHORA).texto, 'Últ. vez hace 5 min');
  assert.equal(textoPresencia({ ts: AHORA - 2 * 3_600_000, off: false }, AHORA).texto, 'Últ. vez hace 2 h');
  assert.equal(textoPresencia({ ts: AHORA - 3 * 86_400_000, off: false }, AHORA).texto, 'Últ. vez hace 3 d');
  const viejo = textoPresencia({ ts: AHORA - 40 * 86_400_000, off: false }, AHORA).texto;
  assert.match(viejo, /^Últ\. vez el \d{2}\/\d{2}\/\d{4}$/);
});

test('haceTexto: escalas', () => {
  assert.equal(haceTexto(AHORA - 20_000, AHORA), 'hace un momento');
  assert.equal(haceTexto(AHORA - 59 * 60_000, AHORA), 'hace 59 min');
  assert.equal(haceTexto(AHORA - 23 * 3_600_000, AHORA), 'hace 23 h');
});

test('parseBeacon: valida kind y pubkey; off por contenido', () => {
  const pk = 'a'.repeat(64);
  assert.deepEqual(parseBeacon({ kind: KIND_PRESENCIA, pubkey: pk, content: '' }, AHORA),
    { pubkey: pk, off: false, ts: AHORA });
  assert.deepEqual(parseBeacon({ kind: KIND_PRESENCIA, pubkey: pk, content: 'off' }, AHORA),
    { pubkey: pk, off: true, ts: AHORA });
  assert.equal(parseBeacon({ kind: 4, pubkey: pk, content: '' }, AHORA), null, 'otro kind no es beacon');
  assert.equal(parseBeacon({ kind: KIND_PRESENCIA, pubkey: 'no-es-hex', content: '' }, AHORA), null);
  assert.equal(parseBeacon(null, AHORA), null);
});
