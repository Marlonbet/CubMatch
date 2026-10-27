// Tests de ligereza (v1.12.5, punto 4: ligereza de datos).
// nostr-tools fija @noble/hashes@2.0.1 exacto y la app usa 2.4.0:
// sin override, npm instalaba DOS copias (la anidada bajo nostr-tools
// y bajo @noble/curves) y esbuild metía ambas en el bundle (~12 KB
// duplicados: utils, sha2, hmac, _md). El override "$@noble/hashes"
// en package.json fuerza una sola copia (la de la raíz, 2.4.0) en
// todo el árbol; npm dedupe dejó el lockfile sin entradas anidadas.
// Si el override se pierde, el bundle vuelve a crecer y este test
// lo caza por el tamaño y por la copia duplicada en los inputs.
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
    format: 'iife',
    target: ['es2020'],
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  return r;
}

test('una sola copia de @noble/hashes en el bundle (sin copias anidadas)', () => {
  const r = bundle();
  const outs = r.metafile.outputs[Object.keys(r.metafile.outputs)[0]];
  const copias = Object.keys(outs.inputs).filter((k) => k.includes('@noble/hashes'));
  assert.ok(copias.length > 0, 'el bundle debe incluir @noble/hashes');
  for (const k of copias) {
    assert.ok(k.startsWith('node_modules/@noble/hashes/'),
      `copia anidada de @noble/hashes en el bundle: ${k} (falta el override en package.json)`);
  }
});

test('bundle con dedup: baja de 218 KB (antes 222,5 KB)', () => {
  const r = bundle();
  let js = r.outputFiles[0].text;
  js = js.replace('__APP_VERSION__', '1.12.5');
  js = js.split('__TURNMD_APP__').join('').split('__TURNMD_APIKEY__').join('');
  const bytes = Buffer.byteLength(js);
  assert.ok(bytes < 218000, `esperaba <218000 bytes, son ${bytes}`);
  assert.ok(bytes > 150000, `bundle sospechosamente chico: ${bytes} bytes`);
});

test('package.json + lockfile: @noble/hashes único en 2.4.0', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.overrides?.['@noble/hashes'], '$@noble/hashes',
    'falta overrides["@noble/hashes"]="$@noble/hashes" en package.json');
  const lock = JSON.parse(read('package-lock.json'));
  const entradas = Object.entries(lock.packages || {})
    .filter(([k]) => /(^|\/)@noble\/hashes$/.test(k));
  assert.equal(entradas.length, 1, `esperaba 1 entrada @noble/hashes en el lockfile, hay ${entradas.length}: ${entradas.map(([k]) => k).join(', ')}`);
  assert.equal(entradas[0][1].version, '2.4.0', `lockfile con @noble/hashes ${entradas[0][1].version}, no 2.4.0`);
});
