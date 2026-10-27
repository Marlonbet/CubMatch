// Tests de ligereza (v1.12.4, punto 4: ligereza de datos).
// Importar el paquete 'nostr-tools' pelado metía en el bundle el código
// de pool/relay aunque la app no lo usa (el tree-shaking no lo sacaba:
// 273 KB de JS). Importar solo los subpaths que se usan — pure, nip04
// y nip19 — baja el bundle a ~222 KB sin cambiar ni una llamada:
// nip04/nip19 se importan como namespace (* as) y conservan su API
// (nip04.encrypt, nip19.nsecEncode, ...). Los tests de la app no
// cuentan: no se empaquetan, así que pueden seguir importando pelado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { buildSync } from 'esbuild';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const PERMITIDOS = new Set(['nostr-tools/pure', 'nostr-tools/nip04', 'nostr-tools/nip19']);

test('src solo importa subpaths de nostr-tools (nunca el paquete pelado)', () => {
  for (const f of readdirSync(new URL('src', ROOT)).filter((x) => x.endsWith('.js'))) {
    const src = read(`src/${f}`);
    for (const m of src.matchAll(/from '([^']*nostr-tools[^']*)'/g)) {
      assert.ok(PERMITIDOS.has(m[1]),
        `${f}: import prohibido '${m[1]}' (usa pure, nip04 o nip19)`);
    }
  }
});

test('bundle con subpaths: baja de 240 KB (antes 273 KB)', () => {
  const r = buildSync({
    entryPoints: [new URL('src/entry.js', ROOT).pathname],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020'],
    write: false,
    logLevel: 'silent',
  });
  let js = r.outputFiles[0].text;
  js = js.replace('__APP_VERSION__', '1.12.4');
  js = js.split('__TURNMD_APP__').join('').split('__TURNMD_APIKEY__').join('');
  const bytes = Buffer.byteLength(js);
  assert.ok(bytes < 240000, `esperaba <240000 bytes, son ${bytes}`);
  assert.ok(bytes > 150000, `bundle sospechosamente chico: ${bytes} bytes`);
});
