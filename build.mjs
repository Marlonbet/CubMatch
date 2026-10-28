// Empaqueta CubMatch:
//  - app/live/cubmatch-live.js + version.js + cubmatch-live.sig.json → la
//    versión "viva" que el loader descarga solo cuando hay una más nueva
//    (vía proxy de GitHub) Y su firma verifica (ver src/boot.js).
//  - dist/cubmatch.html → UN SOLO archivo: shell + app incluida
//    (fallback offline) + boot del loader. Se abre con file:// y se
//    comparte por WhatsApp/Bluetooth. Solo necesita localStorage +
//    WebSocket; la actualización usa fetch (sin CORS problemático: los
//    proxies permiten CORS).
//
// Firma de actualizaciones (ECDSA P-256):
//   node tools/gen-update-key.mjs                       (una sola vez)
//   UPDATE_SIGNING_KEY=update-key.private.pem npm run build
// Sin UPDATE_SIGNING_KEY el build funciona, pero NO genera la firma: los
// clientes con verificación ignorarán esa versión viva.
import { buildSync, transformSync } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { firmarLive, publicJwkDePem, verificarLive } from './tools/firma.mjs';
import { minificarCss } from './tools/mincss.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');
const live = join(root, 'app', 'live');
mkdirSync(dist, { recursive: true });
mkdirSync(live, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

// Clave PÚBLICA de firma (se sube a git). Si falta, el loader queda con la
// auto-actualización desactivada (falla cerrado).
const pubPath = join(root, 'update-key.pub.json');
const updatePub = existsSync(pubPath) ? JSON.parse(readFileSync(pubPath, 'utf8')) : null;
if (updatePub && !(updatePub.kty === 'EC' && updatePub.crv === 'P-256' && updatePub.x && updatePub.y)) {
  throw new Error('update-key.pub.json no es un JWK público EC P-256 válido');
}

// Un solo bundle: sirve como fallback incluido y como live remoto.
// charset 'utf8' (v1.12.6, punto 4: ligereza de datos): por defecto
// esbuild emite ASCII y escapa cada carácter no ASCII como \uXXXX
// (6 bytes); la app está llena de acentos y emoji en español, así que
// dejarlos crudos en UTF-8 recorta ~1,6 KB del bundle. No cambia la
// sintaxis (el target sigue siendo es2020) y es seguro: el HTML único
// declara charset utf-8 antes de los scripts, el loader decodifica el
// bundle vivo con TextDecoder('utf-8') y los archivos se escriben y
// firman como UTF-8.
const result = buildSync({
  entryPoints: [join(src, 'entry.js')],
  bundle: true,
  minify: true,
  charset: 'utf8',
  format: 'iife',
  target: ['es2020'],
  write: false,
  logLevel: 'warning',
});
let js = result.outputFiles[0].text;
if (!js.includes('__APP_VERSION__')) throw new Error('falta el placeholder __APP_VERSION__');
js = js.replace('__APP_VERSION__', () => version);

// Credenciales de Metered TURN (v1.9.1, src/turnmd.js): el bundle
// trae los placeholders __TURNMD_APP__ / __TURNMD_APIKEY__. SOLO se
// sustituyen por valores reales si el entorno define TURNMD_INJECT
// apuntando a un JSON {app, apiKey}; sin esa variable se borran
// (cadena vacía) y la función queda desactivada. split/join en vez
// de replace: los valores no deben sufrir patrones $ del reemplazo.
let turnmdApp = '', turnmdApiKey = '';
if (process.env.TURNMD_INJECT) {
  const inj = JSON.parse(readFileSync(process.env.TURNMD_INJECT, 'utf8'));
  turnmdApp = String(inj.app || '');
  turnmdApiKey = String(inj.apiKey || '');
}
for (const [placeholder, valor] of [['__TURNMD_APP__', turnmdApp], ['__TURNMD_APIKEY__', turnmdApiKey]]) {
  if (!js.includes(placeholder)) throw new Error('falta el placeholder ' + placeholder);
  js = js.split(placeholder).join(valor);
}

// Versión viva (remota)
writeFileSync(join(live, 'cubmatch-live.js'), js);
writeFileSync(join(live, 'version.js'), `window.__CUBMATCH_REMOTE_VERSION=${JSON.stringify(version)};\n`);

// Firma de la versión viva. Se firman los bytes EXACTOS que acaban de
// escribirse (UTF-8) junto con la versión. Una firma vieja nunca se deja
// al lado de un bundle nuevo: si no se firma, el archivo se borra.
const sigPath = join(live, 'cubmatch-live.sig.json');
if (process.env.UPDATE_SIGNING_KEY) {
  if (!updatePub) throw new Error('UPDATE_SIGNING_KEY definida pero falta update-key.pub.json (ejecuta node tools/gen-update-key.mjs)');
  const pem = readFileSync(process.env.UPDATE_SIGNING_KEY, 'utf8');
  const delPem = publicJwkDePem(pem);
  if (delPem.x !== updatePub.x || delPem.y !== updatePub.y) {
    throw new Error('la clave privada de UPDATE_SIGNING_KEY NO corresponde a update-key.pub.json: los clientes rechazarían la actualización');
  }
  const meta = firmarLive(version, js, pem);
  if (!verificarLive(meta, readFileSync(join(live, 'cubmatch-live.js')), updatePub)) {
    throw new Error('la firma recién generada no verifica (bug en el build)');
  }
  writeFileSync(sigPath, JSON.stringify(meta) + '\n');
  console.log('firma OK:', sigPath, '| v' + version);
} else {
  rmSync(sigPath, { force: true });
  console.warn('AVISO: sin UPDATE_SIGNING_KEY → no se generó cubmatch-live.sig.json. '
    + 'Los clientes con verificación NO aceptarán esta versión viva.');
}

// Boot del loader
let bootJs = readFileSync(join(src, 'boot.js'), 'utf8');
if (!bootJs.includes('__BUNDLED_VERSION__')) throw new Error('falta el placeholder __BUNDLED_VERSION__');
bootJs = bootJs.replace('__BUNDLED_VERSION__', () => version);
if (!bootJs.includes('__UPDATE_PUBKEY__')) throw new Error('falta el placeholder __UPDATE_PUBKEY__');
// El JWK solo lleva caracteres base64url y comillas dobles: es seguro
// dentro de una cadena JS entre comillas simples.
bootJs = bootJs.replace('__UPDATE_PUBKEY__', () => (updatePub
  ? JSON.stringify({ kty: 'EC', crv: 'P-256', x: updatePub.x, y: updatePub.y })
  : ''));
if (!updatePub) {
  console.warn('AVISO: no hay update-key.pub.json → este build sale con la auto-actualización DESACTIVADA.');
}

// El boot también se minifica (v1.12.3, punto 4: ligereza de datos):
// iba tal cual con comentarios (~6,9 KB) y con esbuild baja a ~3,3 KB.
// Se minifica DESPUÉS de sustituir los placeholders, para que la
// versión y la clave pública queden dentro del código minificado.
// charset 'utf8' (v1.12.6): igual que el bundle, los acentos de los
// mensajes del loader van crudos en UTF-8 en vez de escapes \uXXXX.
bootJs = transformSync(bootJs, { minify: true, charset: 'utf8' }).code;

// Archivo único descargable
// El CSS se minifica (ver tools/mincss.mjs): el archivo único se
// comparte por WhatsApp y se descarga con datos caros, así que cada
// KB cuenta; el CSS fuente queda legible en src/styles.css.
const css = minificarCss(readFileSync(join(src, 'styles.css'), 'utf8'));
let html = readFileSync(join(src, 'index.html'), 'utf8');
// Función de reemplazo (no string): evita que `$&` del bundle corrompa el HTML.
html = html.replace('<!--__STYLES__-->', () => `<style>${css}</style>`);
html = html.replace('<!--__FALLBACK__-->', () => `<script>${js}</script>`);
html = html.replace('<!--__BOOT__-->', () => `<script>${bootJs}</script>`);

const out = join(dist, 'cubmatch.html');
writeFileSync(out, html);
console.log('OK:', out, Math.round(Buffer.byteLength(html) / 1024) + ' KB', '| live:', version);
