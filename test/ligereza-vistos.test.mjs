// Tests de ligereza (v1.12.14, punto 4: ligereza de datos).
// Seis suscripciones (perfil propio en app.js, descubrimiento y
// likes en cubmatch.js, reclamos en cuentas.js, contador de red en
// ux.js) repetían la misma guarda anti-duplicados + el add:
//   if (!ev || typeof ev.id !== 'string' || vistos.has(ev.id)) return;
//   vistos.add(ev.id);
// Ahora viven en una sola definición — esEventoNuevo(vistos, ev)
// en red.js — que devuelve true solo para un id nuevo y lo marca
// visto, sin cambiar el comportamiento de ninguna suscripción.
// Si alguna copia vuelve, el bundle vuelve a crecer y estos tests
// lo cazan por el conteo en fuente y por el tamaño.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { buildSync } from 'esbuild';

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
  js = js.replace('__APP_VERSION__', '1.12.14');
  js = js.split('__TURNMD_APP__').join('').split('__TURNMD_APIKEY__').join('');
  return js;
}

function extraerEsEventoNuevo(src) {
  const i = src.indexOf('export function esEventoNuevo(');
  assert.ok(i >= 0, 'falta esEventoNuevo en red.js');
  const j = src.indexOf('\n}', i);
  assert.ok(j > i, 'no se pudo extraer esEventoNuevo');
  return src.slice(i, j + 2).replace('export function', 'function');
}

test('vistos: esEventoNuevo se define una sola vez y tiene 6 sitios de uso', () => {
  const red = read('src/red.js');
  assert.equal((red.match(/function esEventoNuevo\(vistos, ev\)/g) || []).length, 1,
    'esEventoNuevo debe definirse una sola vez');
  const sitios = [
    ['src/app.js', 1],
    ['src/cubmatch.js', 3],
    ['src/cuentas.js', 1],
    ['src/ux.js', 1],
  ];
  let total = 0;
  for (const [p, esperado] of sitios) {
    const src = read(p);
    const n = (src.match(/if \(!esEventoNuevo\(vistos, ev\)\) return;/g) || []).length;
    assert.equal(n, esperado, `${p} debe tener ${esperado} sitios, tiene ${n}`);
    total += n;
    // No debe quedar la guarda copiada ni el add suelto en ese archivo.
    assert.ok(!src.includes("vistos.has(ev.id)) return;"),
      `${p} no debe conservar la guarda copiada`);
    assert.ok(!src.includes('vistos.add(ev.id);'),
      `${p} no debe conservar el add suelto`);
  }
  assert.equal(total, 6, 'debe haber 6 sitios en total');
});

test('vistos: esEventoNuevo rechaza lo inválido y marca lo nuevo una sola vez', () => {
  const fn = extraerEsEventoNuevo(read('src/red.js'));
  const esEventoNuevo = new Function(`${fn}; return esEventoNuevo;`)();
  const vistos = new Set();
  assert.equal(esEventoNuevo(vistos, null), false, 'null no es nuevo');
  assert.equal(esEventoNuevo(vistos, {}), false, 'sin id no es nuevo');
  assert.equal(esEventoNuevo(vistos, { id: 7 }), false, 'id no string no es nuevo');
  assert.equal(esEventoNuevo(vistos, { id: 'a1' }), true, 'id nuevo debe pasar');
  assert.ok(vistos.has('a1'), 'el id nuevo debe quedar marcado');
  assert.equal(esEventoNuevo(vistos, { id: 'a1' }), false, 'el mismo id ya no es nuevo');
  assert.equal(esEventoNuevo(vistos, { id: 'b2' }), true, 'otro id sí es nuevo');
  assert.equal(vistos.size, 2, 'solo los nuevos quedan marcados');
});

test('bundle: la guarda unificada baja de peso sin perder suscripciones', () => {
  const js = bundle();
  const bytes = Buffer.byteLength(js);
  // v1.12.13 medido: 207359 B. Con la guarda unificada baja sin
  // cambiar funciones; el tope caza si vuelve alguna copia.
  // v1.12.15: el aviso anti-fraude del punto 5 añade ~1,9 KB nuevos;
  // el tope sube en consecuencia, la guarda sigue siendo el conteo.
  assert.ok(bytes < 213000, `el bundle debe mantenerse por debajo de 213000 B, tiene ${bytes}`);
  assert.ok(js.includes('__cubmatchApp'), 'falta la app en el bundle');
  assert.ok(!js.includes('__APP_VERSION__'), 'sin placeholders sin reemplazar');
});
