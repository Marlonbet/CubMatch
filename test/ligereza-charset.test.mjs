// Tests de ligereza (v1.12.6, punto 4: ligereza de datos).
// esbuild emite ASCII por defecto: cada carácter no ASCII de las
// cadenas en español (acentos, emoji) sale como escape \uXXXX de
// 6 bytes. Con charset:'utf8' esos caracteres van crudos en UTF-8
// (2-3 bytes) y el bundle baja ~1,6 KB sin cambiar ni la sintaxis
// (mismo target es2020) ni ninguna función: el HTML único declara
// charset utf-8, el loader decodifica el vivo con TextDecoder
// utf-8 y build.mjs escribe y firma los archivos como UTF-8.
// Si el charset se pierde, el bundle vuelve a crecer y este test
// lo caza por el tamaño y por los escapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { buildSync, transformSync } from 'esbuild';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function bundle(charset) {
  const r = buildSync({
    entryPoints: [new URL('src/entry.js', ROOT).pathname],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020'],
    ...(charset ? { charset } : {}),
    write: false,
    logLevel: 'silent',
  });
  let js = r.outputFiles[0].text;
  js = js.replace('__APP_VERSION__', '1.12.6');
  js = js.split('__TURNMD_APP__').join('').split('__TURNMD_APIKEY__').join('');
  return js;
}

test('bundle utf8: más chico que el ascii y con acentos crudos', () => {
  const ascii = bundle();
  const utf8 = bundle('utf8');
  const bytesAscii = Buffer.byteLength(ascii);
  const bytesUtf8 = Buffer.byteLength(utf8);
  assert.ok(bytesUtf8 < bytesAscii - 1000,
    `esperaba ahorrar >1000 bytes: ascii ${bytesAscii}, utf8 ${bytesUtf8}`);
  assert.ok(utf8.includes('Sin conexión'), 'el bundle utf8 debe llevar acentos crudos');
  assert.ok(!utf8.includes('Sin conexi\\u00f3n'), 'el bundle utf8 no debe escapar los acentos');
  for (const clave of ['__cubmatchApp', 'CubMatch', 'Descubrir']) {
    assert.ok(utf8.includes(clave), `falta en el bundle utf8: ${clave}`);
  }
  assert.ok(!utf8.includes('__APP_VERSION__'), 'sin placeholders sin reemplazar');
});

test('boot utf8: más chico que el ascii y con acentos crudos', () => {
  let boot = read('src/boot.js');
  boot = boot.replace('__BUNDLED_VERSION__', '1.12.6');
  boot = boot.replace('__UPDATE_PUBKEY__', () =>
    JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'BBBB' }));
  const ascii = transformSync(boot, { minify: true }).code;
  const utf8 = transformSync(boot, { minify: true, charset: 'utf8' }).code;
  assert.ok(Buffer.byteLength(utf8) < Buffer.byteLength(ascii),
    `boot utf8 ${Buffer.byteLength(utf8)} debe ser menor que ascii ${Buffer.byteLength(ascii)}`);
  assert.ok(utf8.includes('actualización'), 'el boot utf8 debe llevar acentos crudos');
  assert.ok(utf8.includes('cubmatch-live.js'), 'falta el nombre del vivo en el boot');
});

test("build.mjs: charset 'utf8' en el bundle y en el boot", () => {
  const build = read('build.mjs');
  const usos = (build.match(/charset:\s*'utf8'/g) || []).length;
  assert.ok(usos >= 2, `esperaba charset 'utf8' en bundle y boot, hay ${usos} usos en build.mjs`);
});
