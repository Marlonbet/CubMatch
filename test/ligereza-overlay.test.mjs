// Tests de ligereza (v1.12.13, punto 4: ligereza de datos).
// app.js traía 4 overlays colgados de #app (match, detalle,
// ubicación, compartir) repitiendo crear el div, clase 'overlay',
// id, innerHTML y append, y 3 de ellos el mismo cierre al tocar
// el fondo. Ahora viven en una sola definición —
// crearOverlay(id, html, alFondo?) — sin cambiar el HTML ni el
// comportamiento de ninguno. La overlay de llamada queda fuera a
// propósito: cuelga de document.body y tiene su propio listener.
// Si alguna copia vuelve, el bundle vuelve a crecer y estos tests
// lo cazan por el conteo en fuente y por el tamaño.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';

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
  js = js.replace('__APP_VERSION__', '1.12.13');
  js = js.split('__TURNMD_APP__').join('').split('__TURNMD_APIKEY__').join('');
  return js;
}

// Extrae crearOverlay de la fuente con conteo de llaves (su cuerpo
// tiene llaves anidadas: el listener del fondo).
function extraerCrearOverlay(src) {
  const i = src.indexOf('function crearOverlay(');
  assert.ok(i >= 0, 'falta crearOverlay en la fuente');
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, j + 1);
}

test('overlay: los 4 overlays de #app viven en una sola definición', () => {
  const app = read('src/app.js');
  assert.equal((app.match(/function crearOverlay\(id, html, alFondo\)/g) || []).length, 1,
    'crearOverlay debe definirse una sola vez');
  // v1.12.15: un 5º sitio de uso, el aviso anti-fraude de dato sensible,
  // que pasa por la misma definición única (no es una copia nueva).
  // v1.12.16: un 6º sitio, la confirmación de borrado para ambos.
  assert.equal((app.match(/crearOverlay\('/g) || []).length, 6,
    'debe haber 6 sitios de uso: match, detalle, loc, compartir, dato, borrar');
  for (const id of ['match-overlay', 'detalle-overlay', 'loc-overlay', 'compartir-overlay', 'dato-overlay', 'borrar-overlay']) {
    assert.ok(app.includes(`crearOverlay('${id}'`), `falta el sitio ${id}`);
    assert.ok(!app.includes(`ov.id = '${id}'`), `no debe quedar creación suelta de ${id}`);
  }
  // El cierre al tocar el fondo va como tercer argumento, no copiado.
  assert.ok(app.includes("', closeDetalle);"), 'detalle debe pasar closeDetalle');
  assert.ok(app.includes("', closeLocConfirm);"), 'loc debe pasar closeLocConfirm');
  assert.ok(app.includes("', closeCompartir);"), 'compartir debe pasar closeCompartir');
  assert.ok(app.includes("', closeDatoConfirm);"), 'dato debe pasar closeDatoConfirm');
  assert.ok(app.includes("', closeBorrarConfirm);"), 'borrar debe pasar closeBorrarConfirm');
  assert.equal((app.match(/ov\.className = 'overlay';/g) || []).length, 1,
    'la clase overlay solo debe asignarse en crearOverlay');
  // La overlay de llamada queda fuera a propósito, intacta.
  assert.ok(app.includes("ov.className = 'overlay call-overlay';"),
    'la overlay de llamada debe seguir con su clase propia');
  assert.ok(app.includes('document.body.appendChild(ov)'),
    'la overlay de llamada debe seguir colgando de body');
});

test('overlay: crearOverlay cuelga en #app y cierra solo al tocar el fondo', () => {
  const src = read('src/app.js');
  const fn = extraerCrearOverlay(src);
  const dom = new JSDOM('<!DOCTYPE html><div id="app"></div>');
  const crear = new Function('document', `${fn}; return crearOverlay;`)(dom.window.document);
  let cerrados = 0;
  const ov = crear('prueba-overlay', '<p>hola</p>', () => { cerrados++; });
  const appEl = dom.window.document.getElementById('app');
  assert.equal(ov.id, 'prueba-overlay');
  assert.equal(ov.className, 'overlay');
  assert.equal(ov.innerHTML, '<p>hola</p>');
  assert.equal(appEl.children.length, 1, 'debe quedar colgado en #app');
  // Clic dentro (hijo) no cierra; clic sobre el propio fondo sí.
  ov.firstChild.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(cerrados, 0, 'clic en el contenido no debe cerrar');
  ov.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(cerrados, 1, 'clic en el fondo debe cerrar');
  // Sin alFondo no hay listener que rompa nada.
  const ov2 = crear('sin-cierre', '<p>x</p>');
  assert.equal(appEl.children.length, 2);
  ov2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(cerrados, 1, 'sin alFondo no debe cerrar nada');
});

test('bundle: el overlay unificado baja de peso sin perder las 4 vistas', () => {
  const js = bundle();
  const bytes = Buffer.byteLength(js);
  // v1.12.12 medido: 207775 B. Con los 4 overlays unificados baja
  // sin cambiar funciones; el tope caza si vuelve alguna copia.
  // v1.12.15 medido: ~209053 B — el aviso anti-fraude del punto 5
  // (módulo seguridad + overlay + cableado) añade ~1,9 KB de código
  // nuevo necesario; la guarda contra copias sigue siendo el conteo
  // de patrones de arriba.
  assert.ok(bytes < 213000, `el bundle debe mantenerse por debajo de 213000 B, tiene ${bytes}`);
  assert.ok(js.includes('__cubmatchApp'), 'falta la app en el bundle');
  assert.ok(!js.includes('__APP_VERSION__'), 'sin placeholders sin reemplazar');
  for (const id of ['match-overlay', 'detalle-overlay', 'loc-overlay', 'compartir-overlay', 'dato-overlay', 'borrar-overlay']) {
    assert.ok(js.includes(id), `falta ${id} en el bundle`);
  }
  assert.ok(js.includes('call-overlay'), 'la overlay de llamada debe seguir en el bundle');
});
