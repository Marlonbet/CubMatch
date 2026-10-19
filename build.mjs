// Empaqueta CubMatch:
//  - app/live/cubmatch-live.js + version.js → la versión "viva" que el
//    loader descarga solo cuando hay una más nueva (vía proxy de GitHub).
//  - dist/cubmatch.html → UN SOLO archivo: shell + app incluida
//    (fallback offline) + boot del loader. Se abre con file:// y se
//    comparte por WhatsApp/Bluetooth. Solo necesita localStorage +
//    WebSocket; la actualización usa fetch (sin CORS problemático: los
//    proxies permiten CORS).
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');
const live = join(root, 'app', 'live');
mkdirSync(dist, { recursive: true });
mkdirSync(live, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

// Un solo bundle: sirve como fallback incluido y como live remoto.
const result = buildSync({
  entryPoints: [join(src, 'app.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  logLevel: 'warning',
});
let js = result.outputFiles[0].text;
if (!js.includes('__APP_VERSION__')) throw new Error('falta el placeholder __APP_VERSION__');
js = js.replace('__APP_VERSION__', () => version);

// Versión viva (remota)
writeFileSync(join(live, 'cubmatch-live.js'), js);
writeFileSync(join(live, 'version.js'), `window.__CUBMATCH_REMOTE_VERSION=${JSON.stringify(version)};\n`);

// Boot del loader
let bootJs = readFileSync(join(src, 'boot.js'), 'utf8');
if (!bootJs.includes('__BUNDLED_VERSION__')) throw new Error('falta el placeholder __BUNDLED_VERSION__');
bootJs = bootJs.replace('__BUNDLED_VERSION__', () => version);

// Archivo único descargable
const css = readFileSync(join(src, 'styles.css'), 'utf8');
let html = readFileSync(join(src, 'index.html'), 'utf8');
// Función de reemplazo (no string): evita que `$&` del bundle corrompa el HTML.
html = html.replace('<!--__STYLES__-->', () => `<style>${css}</style>`);
html = html.replace('<!--__FALLBACK__-->', () => `<script>${js}</script>`);
html = html.replace('<!--__BOOT__-->', () => `<script>${bootJs}</script>`);

const out = join(dist, 'cubmatch.html');
writeFileSync(out, html);
console.log('OK:', out, Math.round(Buffer.byteLength(html) / 1024) + ' KB', '| live:', version);
