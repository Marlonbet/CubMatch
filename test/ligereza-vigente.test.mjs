// Tests de ligereza (v1.12.10, punto 4: ligereza de datos).
// llamadas.js traía dos patrones copiados: la guarda de vigencia
// "hay pc Y la llamada actual sigue siendo esta" en 11 sitios (con
// los operandos en distinto orden) y la parada de pistas de un
// stream ("detener todos los tracks tragándose errores") en 5
// sitios. Ahora cada patrón vive en una sola definición —
// _vigente y _pararPistas — y cada sitio la llama. Las guardas por
// id de los handlers de señalización y las de identidad sin pc de
// antes de crear el pc NO se unificaron: comparan otra cosa y
// exigir pc ahí cambiaría el comportamiento. Si alguna copia
// vuelve, el bundle vuelve a crecer y estos tests lo cazan por el
// conteo en fuente, por el comportamiento y por el tamaño.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { buildSync } from 'esbuild';
import { CallSession } from '../src/llamadas.js';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function bundle() {
  const r = buildSync({
    entryPoints: [new URL('src/entry.js', ROOT).pathname],
    bundle: true,
    minify: true,
    charset: 'utf8',
    format: 'iife',
    target: ['es2020'],
    write: false,
    logLevel: 'silent',
  });
  let js = r.outputFiles[0].text;
  js = js.replace('__APP_VERSION__', '1.12.10');
  js = js.split('__TURNMD_APP__').join('').split('__TURNMD_APIKEY__').join('');
  return js;
}

function sesion() {
  return new CallSession({
    createPC: () => { throw new Error('sin PC en este test'); },
    getLocalStream: async () => null,
    send: () => {},
    onEvent: () => {},
    nowFn: () => 1000000,
  });
}

test('_vigente/_pararPistas: cada patrón vive en una sola definición', () => {
  const src = read('src/llamadas.js');
  assert.equal((src.match(/_vigente\(cur\) \{/g) || []).length, 1,
    '_vigente debe definirse una sola vez');
  assert.equal((src.match(/_pararPistas\(stream\) \{/g) || []).length, 1,
    '_pararPistas debe definirse una sola vez');
  assert.equal((src.match(/this\._vigente\(cur\)/g) || []).length, 11,
    'los 11 sitios de guarda deben pasar por _vigente');
  assert.equal((src.match(/this\._pararPistas\(/g) || []).length, 5,
    'los 5 sitios de parada deben pasar por _pararPistas');
  assert.ok(!src.includes('!this.pc || this.current !== cur'),
    'no debe quedar ninguna copia de la guarda en su primera escritura');
  assert.ok(!src.includes('this.current !== cur || !this.pc'),
    'no debe quedar ninguna copia de la guarda en su segunda escritura');
  assert.equal((src.match(/for \(const t of stream\.getTracks\(\)\) t\.stop\(\); \} catch \{\}/g) || []).length, 1,
    'la parada de pistas debe vivir solo dentro de _pararPistas');
  // Guardas que NO se unificaron, a propósito: por id (señalización)
  // e identidad sin pc (antes de crear el pc).
  assert.equal((src.match(/this\.current\.id !== cur\.id/g) || []).length, 3,
    'las 3 guardas por id deben seguir como estaban');
  assert.equal((src.match(/if \(this\.current !== cur\) return;/g) || []).length, 2,
    'las 2 guardas tras setLocalDescription deben seguir sin exigir pc');
});

test('_vigente: exige pc y que la llamada actual sea la misma', () => {
  const ses = sesion();
  const cur = { id: 'call-0123456789abcdef', peer: 'peerPK', media: 'audio' };
  const otra = { id: 'call-fedcba9876543210', peer: 'peerPK', media: 'audio' };
  assert.equal(ses._vigente(cur), false, 'sin pc no hay vigencia');
  ses.pc = {};
  assert.equal(ses._vigente(cur), false, 'sin llamada actual no hay vigencia');
  ses.current = otra;
  assert.equal(ses._vigente(cur), false, 'otra llamada actual no es vigente');
  ses.current = cur;
  assert.equal(ses._vigente(cur), true, 'pc + misma llamada = vigente');
  ses.pc = null;
  assert.equal(ses._vigente(cur), false, 'al caer el pc se pierde la vigencia');
});

test('_pararPistas: detiene los tracks, traga errores y acepta null', () => {
  const ses = sesion();
  const parados = [];
  // Semántica original preservada: UN solo try alrededor del bucle;
  // si un track falla al parar, los siguientes ya no se intentan,
  // pero el error no se propaga.
  const stream = {
    getTracks: () => [
      { stop: () => { parados.push('a'); } },
      { stop: () => { throw new Error('track roto'); } },
      { stop: () => { parados.push('c'); } },
    ],
  };
  assert.doesNotThrow(() => ses._pararPistas(stream));
  assert.deepEqual(parados, ['a'], 'para hasta el track que falla, sin propagar');
  const parados2 = [];
  ses._pararPistas({ getTracks: () => [
    { stop: () => { parados2.push('x'); } },
    { stop: () => { parados2.push('y'); } },
  ] });
  assert.deepEqual(parados2, ['x', 'y'], 'sin fallos para todos');
  assert.doesNotThrow(() => ses._pararPistas(null), 'sin stream no hace nada');
  assert.doesNotThrow(
    () => ses._pararPistas({ getTracks: () => { throw new Error('sin pistas'); } }),
    'un getTracks que falla no debe propagarse');
});

test('_reset: detiene el stream local por _pararPistas y cierra el pc', () => {
  const ses = sesion();
  const parados = [];
  ses.localStream = { getTracks: () => [{ stop: () => { parados.push(1); } }] };
  let pcCerrado = false;
  ses.pc = { close: () => { pcCerrado = true; } };
  ses.current = { id: 'call-0123456789abcdef', peer: 'peerPK', media: 'audio' };
  ses._setState('conectada');
  ses._reset();
  assert.deepEqual(parados, [1], 'el reset debe parar las pistas locales');
  assert.equal(pcCerrado, true, 'el reset debe cerrar el pc');
  assert.equal(ses.localStream, null, 'el stream local queda limpio');
  assert.equal(ses.state, 'idle');
});

test('bundle: el vivo baja de peso con la deduplicación', () => {
  const js = bundle();
  const bytes = Buffer.byteLength(js);
  // v1.12.9 medido: 208.774 B. Con las 11 guardas y las 5 paradas
  // unificadas baja sin cambiar funciones; el tope caza si vuelve
  // alguna copia. v1.12.11 medido: 208.848 B — la corrección de
  // Matches (descarga de likes/perfiles en ambos scopes en paralelo)
  // añade ~74 B de código necesario; la guarda contra copias sigue
  // siendo el conteo de patrones de arriba. v1.12.15 medido:
  // ~209053 B — el aviso anti-fraude del punto 5 añade ~1,9 KB.
  assert.ok(bytes < 210000, `el bundle debe mantenerse por debajo de 210000 B, tiene ${bytes}`);
  assert.ok(js.includes('__cubmatchApp'), 'falta la app en el bundle');
  assert.ok(!js.includes('__APP_VERSION__'), 'sin placeholders sin reemplazar');
});
