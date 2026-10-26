// Tests de la minificación del boot del loader (v1.12.3, punto 4:
// ligereza de datos). El boot iba tal cual con comentarios (~6,9 KB);
// con esbuild baja a ~3,3 KB sin cambiar su comportamiento.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { transformSync } from 'esbuild';
import { JSDOM } from 'jsdom';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function bootMinificado() {
  let boot = read('src/boot.js');
  boot = boot.replace('__BUNDLED_VERSION__', '1.12.3');
  boot = boot.replace('__UPDATE_PUBKEY__', () =>
    JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB' }));
  return { original: boot, min: transformSync(boot, { minify: true }).code };
}

test('boot minificado: pierde peso sin perder marcadores', () => {
  const { original, min } = bootMinificado();
  assert.ok(min.length < original.length * 0.6,
    `esperaba <60%: ${min.length} de ${original.length}`);
  assert.ok(!min.includes('CUBMATCH loader'), 'sin comentarios del encabezado');
  assert.ok(!min.includes('FALLA CERRADO'), 'sin comentarios del encabezado');
  for (const clave of ['gh-proxy.com/', 'cubmatch-live.js', 'cubmatch-live.sig.json',
    'version.js', '__cubmatchUpdateLog', 'pantalla-inicio', '__cubmatchApp']) {
    assert.ok(min.includes(clave), `falta en el boot minificado: ${clave}`);
  }
  assert.ok(!min.includes('__BUNDLED_VERSION__'), 'sin placeholders sin reemplazar');
  assert.ok(!min.includes('__UPDATE_PUBKEY__'), 'sin placeholders sin reemplazar');
});

test('boot minificado: arranca la app incluida en jsdom', () => {
  const { min } = bootMinificado();
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
  });
  const { window } = dom;
  window.__cubmatchApp = { boot() { window.__bootLlamado = true; } };
  window.eval(min);
  // El boot espera a DOMContentLoaded si el documento aún está cargando.
  if (!window.__bootLlamado) {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  }
  assert.equal(window.__bootLlamado, true, 'el boot debe llamar a fallback.boot()');
  assert.ok(Array.isArray(window.__cubmatchUpdateLog), 'log de actualización presente');
  dom.window.close();
});
