// Tests de ligereza (v1.12.7, punto 4: ligereza de datos).
// foto.js (foto de perfil) y chatx.js (stickers) traían COPIADA la misma
// carga de imágenes (createImageBitmap si está, si no <img> con object
// URL, con los mismos mensajes de error): el bundle llevaba la lógica
// dos veces. Ahora hay una sola definición, loadBitmap en foto.js, que
// chatx.js importa. Sin cambio de comportamiento: mismos errores, misma
// limpieza (revocar objUrl / cerrar la fuente) en los dos llamadores.
// Si la copia vuelve, el bundle vuelve a crecer y este test lo caza
// por las cadenas duplicadas y por el tamaño.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { buildSync } from 'esbuild';
import { loadBitmap } from '../src/foto.js';
import { prepareStickerBlob } from '../src/chatx.js';

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
  js = js.replace('__APP_VERSION__', '1.12.7');
  js = js.split('__TURNMD_APP__').join('').split('__TURNMD_APIKEY__').join('');
  return js;
}

test('loadBitmap: una sola definición en foto.js, importada por chatx.js', () => {
  const foto = read('src/foto.js');
  const chatx = read('src/chatx.js');
  assert.equal((foto.match(/export async function loadBitmap/g) || []).length, 1,
    'foto.js debe exportar loadBitmap una sola vez');
  assert.ok(chatx.includes("loadBitmap } from './foto.js'") || chatx.includes('loadBitmap'),
    'chatx.js debe importar loadBitmap de foto.js');
  assert.ok(!chatx.includes('loadStickerBitmap'), 'chatx.js no debe tener su propia copia');
  assert.ok(!chatx.includes('await createImageBitmap'),
    'chatx.js no debe cargar imágenes por su cuenta');
});

test('loadBitmap: rama createImageBitmap devuelve la fuente sin objUrl', async () => {
  const orig = globalThis.createImageBitmap;
  const falso = { width: 10, height: 10 };
  globalThis.createImageBitmap = async (blob) => { assert.ok(blob); return falso; };
  try {
    const out = await loadBitmap({ type: 'image/png' });
    assert.equal(out.source, falso);
    assert.equal(out.objUrl, null);
  } finally {
    if (orig === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = orig;
  }
});

test('loadBitmap: sin decodificador rechaza con el mensaje conocido', async () => {
  const origBitmap = globalThis.createImageBitmap;
  const origImage = globalThis.Image;
  delete globalThis.createImageBitmap;
  globalThis.Image = undefined;
  try {
    await assert.rejects(loadBitmap({ type: 'image/png' }), /sin decodificador de imágenes disponible/);
  } finally {
    if (origBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = origBitmap;
    if (origImage === undefined) delete globalThis.Image;
    else globalThis.Image = origImage;
  }
});

test('prepareStickerBlob: pasa por el cargador compartido (sin decodificador → original)', async () => {
  const origBitmap = globalThis.createImageBitmap;
  const origImage = globalThis.Image;
  delete globalThis.createImageBitmap;
  globalThis.Image = undefined;
  try {
    const png = new Blob(['x'], { type: 'image/png' });
    assert.equal(await prepareStickerBlob(png), png);
  } finally {
    if (origBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = origBitmap;
    if (origImage === undefined) delete globalThis.Image;
    else globalThis.Image = origImage;
  }
});

test('bundle: la lógica de carga aparece una sola vez y el vivo baja de peso', () => {
  const js = bundle();
  for (const cadena of ['sin decodificador de imágenes disponible', 'imagen no legible']) {
    const n = js.split(cadena).length - 1;
    assert.equal(n, 1, `esperaba 1 aparición de "${cadena}", hay ${n}`);
  }
  const bytes = Buffer.byteLength(js);
  assert.ok(bytes < 209043, `el bundle debe bajar de los 209043 B de v1.12.6, tiene ${bytes}`);
  assert.ok(js.includes('__cubmatchApp'), 'falta la app en el bundle');
});
