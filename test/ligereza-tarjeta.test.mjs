// Tests de ligereza (v1.12.12, punto 4: ligereza de datos).
// app.js traía la tarjeta de perfil copiada dos veces: cardHTML
// (vista swipe) y gridCardHTML (cuadrícula de escritorio) con el
// mismo cuerpo — foto + compat, nombre/edad, lugar, bio, tres
// palabras, chips y los 4 botones — y solo 4 diferencias: los
// prompts (solo swipe), el tope de chips (10 / 6), la clase
// grid-card + 'sm' + data-peer en los botones, y el prefijo de
// las acciones (deck-* / grid-*). Ahora vive en una sola
// definición — tarjetaHTML(c, grid) — sin cambiar el HTML que
// genera ninguna de las dos variantes. Si alguna copia vuelve, el
// bundle vuelve a crecer y estos tests lo cazan por el conteo en
// fuente y por el tamaño.
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
  js = js.replace('__APP_VERSION__', '1.12.12');
  js = js.split('__TURNMD_APP__').join('').split('__TURNMD_APIKEY__').join('');
  return js;
}

test('tarjetaHTML: la tarjeta vive en una sola definición con las dos variantes', () => {
  const app = read('src/app.js');
  assert.equal((app.match(/function tarjetaHTML\(c, grid = false\)/g) || []).length, 1,
    'tarjetaHTML debe definirse una sola vez');
  assert.ok(!app.includes('function cardHTML('), 'no debe quedar cardHTML');
  assert.ok(!app.includes('function gridCardHTML('), 'no debe quedar gridCardHTML');
  // El cuerpo compartido aparece una sola vez en la fuente.
  assert.equal((app.match(/<div class="t-foto">/g) || []).length, 1,
    'la cabecera foto+compat debe vivir solo en tarjetaHTML');
  assert.equal((app.match(/<p class="trespal">/g) || []).length, 2,
    'las tres palabras solo en tarjetaHTML y en el detalle (otra vista, sin compat ni botones)');
  // Las diferencias entre variantes siguen existiendo, parametrizadas.
  assert.ok(app.includes("slice(0, grid ? 6 : 10)"), 'el tope de chips debe depender de grid');
  assert.ok(app.includes("const act = grid ? 'grid' : 'deck'"), 'el prefijo de acción debe depender de grid');
  assert.ok(app.includes("const prompts = grid ? '' :"), 'los prompts solo van en la vista swipe');
  // Sitios de uso: swipe sin grid, cuadrícula con flecha explícita
  // (pasar tarjetaHTML directo a .map le daría el índice como grid).
  assert.equal((app.match(/tarjetaHTML\(c\);/g) || []).length, 1,
    'renderCard debe llamar a tarjetaHTML sin grid');
  assert.equal((app.match(/\.map\(\(c\) => tarjetaHTML\(c, true\)\)/g) || []).length, 1,
    'renderGrid debe llamar a tarjetaHTML(c, true) con flecha explícita');
  assert.ok(!app.includes('.map(tarjetaHTML)'), 'nunca pasar tarjetaHTML directo a .map');
});

test('bundle: la tarjeta unificada baja de peso sin perder las dos variantes', () => {
  const js = bundle();
  const bytes = Buffer.byteLength(js);
  // v1.12.11 medido: 208.848 B. Con las dos tarjetas unificadas baja
  // sin cambiar funciones; el tope caza si vuelve alguna copia.
  // v1.12.15: el aviso anti-fraude del punto 5 añade ~1,9 KB nuevos;
  // el tope sube en consecuencia, la guarda sigue siendo el conteo.
  assert.ok(bytes < 213000, `el bundle debe mantenerse por debajo de 213000 B, tiene ${bytes}`);
  assert.ok(js.includes('__cubmatchApp'), 'falta la app en el bundle');
  assert.ok(!js.includes('__APP_VERSION__'), 'sin placeholders sin reemplazar');
  assert.ok(js.includes('grid-card'), 'la variante de cuadrícula debe seguir en el bundle');
  assert.ok(js.includes('deck-super'), 'las acciones de swipe deben seguir en el bundle');
  assert.ok(js.includes('grid-super'), 'las acciones de cuadrícula deben seguir en el bundle');
});
