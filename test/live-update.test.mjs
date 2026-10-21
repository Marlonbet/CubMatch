// Tests del sistema de auto-actualización: version.js, bundle live,
// y ciclo boot → dispose → boot (takeover).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function mockWindow() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.WebSocket = class MockWS {
        constructor() { setTimeout(() => this.onopen && this.onopen(), 0); }
        send() {} close() {}
      };
    },
  });
  return dom;
}

test('version.js publica la versión remota', () => {
  const dom = mockWindow();
  dom.window.eval(read('app/live/version.js'));
  const v = dom.window.__CUBMATCH_REMOTE_VERSION;
  assert.match(v, /^\d+\.\d+\.\d+$/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(v, pkg.version);
  dom.window.close();
});

test('bundle live: expone boot/dispose/version y arranca', () => {
  const dom = mockWindow();
  const { window } = dom;
  window.eval(read('app/live/cubmatch-live.js'));
  const app = window.__cubmatchApp;
  assert.ok(app && typeof app.boot === 'function' && typeof app.dispose === 'function');
  assert.match(app.version, /^\d+\.\d+\.\d+$/);
  app.boot();
  const html = window.document.getElementById('app').innerHTML;
  assert.ok(html.length > 200, 'la app renderiza contenido');
  dom.window.close();
});

test('etiqueta de versión visible: la landing muestra la versión', () => {
  const dom = mockWindow();
  const { window } = dom;
  window.eval(read('app/live/cubmatch-live.js'));
  const app = window.__cubmatchApp;
  const pkg = JSON.parse(read('package.json'));
  app.boot();
  const html = window.document.getElementById('app').innerHTML;
  assert.ok(html.includes('v' + pkg.version), 'la landing muestra v' + pkg.version);
  dom.window.close();
});

test('takeover: dispose → boot re-arranca limpio', () => {
  const dom = mockWindow();
  const { window } = dom;
  window.eval(read('app/live/cubmatch-live.js'));
  const app = window.__cubmatchApp;
  app.boot();
  const antes = window.document.getElementById('app').innerHTML.length;
  assert.ok(antes > 200);
  app.dispose();
  app.boot();
  const despues = window.document.getElementById('app').innerHTML.length;
  assert.ok(despues > 200, 're-arranca con contenido');
  dom.window.close();
});

test('loader dist: incluye fallback + boot con la versión', () => {
  const html = read('dist/cubmatch.html');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(html.includes('gh-proxy.com'), 'lista de proxies en el boot');
  assert.ok(html.includes('cubmatch-live.js'), 'referencia al bundle live');
  assert.ok(html.includes('__cubmatchApp'), 'handle de la app');
  assert.ok(html.includes('__CUBMATCH_REMOTE_VERSION'), 'referencia a version.js');
  assert.ok(!html.includes('__APP_VERSION__'), 'sin placeholders sin reemplazar');
  assert.ok(!html.includes('__BUNDLED_VERSION__'), 'sin placeholders sin reemplazar');
  assert.ok(!html.includes('__TURNMD_APP__'), 'placeholder de Metered TURN sin reemplazar');
  assert.ok(!html.includes('__TURNMD_APIKEY__'), 'placeholder de Metered TURN sin reemplazar');
  assert.ok(html.includes(pkg.version), 'la versión está en el html');
  assert.ok(html.includes('id="app"'), 'contenedor de la app');
});
