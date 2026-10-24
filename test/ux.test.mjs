// Tests de UX CubMatch (v1.2.0): fortaleza de contraseña, contador de
// perfiles en red, disponibilidad de usuario y logo cubano.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  passwordStrength, contarPerfiles, netcountFromCache, NETCOUNT_TTL_MS,
  checkUsername, logoSVG,
} from '../src/ux.js';
import { buildClaimEvent, claimTag } from '../src/cuentas.js';
import { buildPerfilEvent } from '../src/cubmatch.js';
import { newProfile } from '../src/perfil.js';

// ---------- passwordStrength ----------
test('passwordStrength: corta siempre es débil', () => {
  assert.equal(passwordStrength('abc').label, 'débil');
  assert.equal(passwordStrength('abc1234').score, 0);
});

test('passwordStrength: solo minúsculas de 8 es débil', () => {
  assert.equal(passwordStrength('password').label, 'débil');
});

test('passwordStrength: 8+ con variedad es media', () => {
  assert.equal(passwordStrength('Password1').label, 'media');
  assert.equal(passwordStrength('Pass123!').label, 'media');
});

test('passwordStrength: 12+ con variedad es fuerte', () => {
  assert.equal(passwordStrength('Password123!x').label, 'fuerte');
  assert.equal(passwordStrength('clave-Segura-2024').label, 'fuerte');
});

test('passwordStrength: larga pero de una sola clase baja a débil/media', () => {
  assert.equal(passwordStrength('abcdefghijklmnop').label, 'débil');
});

// ---------- contarPerfiles ----------
function perfilFirmado(sk, apodo, { oculto = false, created_at = 1700000000 } = {}) {
  const p = newProfile();
  p.apodo = apodo;
  p.oculto = oculto;
  const tpl = buildPerfilEvent(p);
  const ev = finalizeEvent({ ...tpl, created_at }, sk);
  return ev;
}

test('contarPerfiles: cuenta autores únicos con firma válida', () => {
  const a = perfilFirmado(generateSecretKey(), 'Ana');
  const b = perfilFirmado(generateSecretKey(), 'Luis');
  assert.equal(contarPerfiles([a, b]), 2);
});

test('contarPerfiles: duplicado del mismo autor cuenta una vez', () => {
  const sk = generateSecretKey();
  const a1 = perfilFirmado(sk, 'Ana', { created_at: 1700000000 });
  const a2 = perfilFirmado(sk, 'Ana María', { created_at: 1700000100 });
  assert.equal(contarPerfiles([a1, a2]), 1);
});

test('contarPerfiles: firma manipulada se descarta', () => {
  const bueno = perfilFirmado(generateSecretKey(), 'Ana');
  const malo = perfilFirmado(generateSecretKey(), 'Falso');
  malo.content = malo.content.replace('Falso', 'Suplantado');
  assert.equal(contarPerfiles([bueno, malo]), 1);
});

test('contarPerfiles: perfiles ocultos no cuentan', () => {
  const sk = generateSecretKey();
  const vis = perfilFirmado(sk, 'Ana');
  const oc = perfilFirmado(generateSecretKey(), 'Secreto', { oculto: true });
  assert.equal(contarPerfiles([vis, oc]), 1);
});

test('contarPerfiles: lista vacía o inválida → 0', () => {
  assert.equal(contarPerfiles([]), 0);
  assert.equal(contarPerfiles(null), 0);
  assert.equal(contarPerfiles([{ kind: 1 }]), 0);
});

// ---------- netcountFromCache ----------
test('netcountFromCache: caché fresca devuelve el número', () => {
  const now = Date.now();
  assert.equal(netcountFromCache({ n: 42, ts: now - 1000 }, now), 42);
});

test('netcountFromCache: expirada o malformada → null', () => {
  const now = Date.now();
  assert.equal(netcountFromCache({ n: 42, ts: now - NETCOUNT_TTL_MS - 1 }, now), null);
  assert.equal(netcountFromCache(null, now), null);
  assert.equal(netcountFromCache({ n: 'x', ts: now }, now), null);
  assert.equal(netcountFromCache({}, now), null);
});

// ---------- checkUsername ----------
// Pool falso que respeta los filtros (kinds/authors/#d), como un relay real.
function fakePool({ eventos = [], open = true } = {}) {
  const client = {
    relays: ['wss://x.test'],
    status: () => (open ? 'open' : 'down'),
    subscribe: (filters, cb) => {
      setImmediate(() => {
        for (const ev of eventos) {
          for (const f of filters) {
            if (f.kinds && !f.kinds.includes(ev.kind)) continue;
            if (f.authors && !f.authors.includes(ev.pubkey)) continue;
            if (f['#d'] && !ev.tags.some((t) => t[0] === 'd' && f['#d'].includes(t[1]))) continue;
            cb(ev);
          }
        }
      });
      return { eose: () => new Promise((r) => setImmediate(r)), unsub() {} };
    },
  };
  return { discovery: () => client, messaging: () => client, scopeDegraded: () => false };
}

function claimFirmado(username) {
  const sk = generateSecretKey();
  return finalizeEvent({ ...buildClaimEvent(username), created_at: 1700000000 }, sk);
}

test('checkUsername: reclamo corroborado (10002 del mismo pubkey) → tomado', async () => {
  const sk = generateSecretKey();
  const claimEv = finalizeEvent({ ...buildClaimEvent('marlon'), created_at: 1700000000 }, sk);
  const docEv = finalizeEvent({ kind: 10002, created_at: 1700000000, tags: [], content: '' }, sk);
  const pool = fakePool({ eventos: [claimEv, docEv] });
  assert.equal(await checkUsername(pool, 'marlon'), 'tomado');
});

test('checkUsername: reclamo pelado (M4, v1.11.2) → disponible', async () => {
  const pool = fakePool({ eventos: [claimFirmado('marlon')] });
  assert.equal(await checkUsername(pool, 'marlon'), 'disponible');
});

test('checkUsername: sin reclamo y relay abierto → disponible', async () => {
  const pool = fakePool({ open: true });
  assert.equal(await checkUsername(pool, 'libre123'), 'disponible');
});

test('checkUsername: sin reclamo y sin conexión → sin-red', async () => {
  const pool = fakePool({ open: false });
  assert.equal(await checkUsername(pool, 'libre123'), 'sin-red');
});

// ---------- logoSVG ----------
test('logoSVG: devuelve SVG válido y determinista', () => {
  const a = logoSVG(84);
  const b = logoSVG(84);
  assert.ok(a.startsWith('<svg'));
  assert.ok(a.includes('</svg>'));
  assert.equal(a, b);
  assert.ok(a.includes('width="84"'));
  assert.ok(a.includes('clipPath'));
  assert.ok(a.includes('#d32f2f')); // triángulo rojo
  assert.ok(a.includes('#1565c0')); // franjas azules
});

test('logoSVG: variant evita colisiones de ids', () => {
  const a = logoSVG(30, 'deck');
  assert.ok(a.includes('cm-corazon-deck'));
  assert.ok(!logoSVG(30).includes('cm-corazon-deck'));
  assert.ok(logoSVG(16).includes('width="16"'));
});

// ---------- borde redondeado de los campos de texto (fix v1.10.2) ----------
// El CSS estila input[type="text"] (border-radius 14px); un <input> sin
// atributo type no casa con ese selector y perdía el estilo (Apodo,
// Municipio, Profesión, Religión, Tags, Tres palabras, prompts).
test('inputs de texto: todos llevan type explícito para recibir el borde redondeado', () => {
  const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const bare = [...src.matchAll(/<input(?![^>]*\btype=)[^>]*>/g)].map(m => m[0]);
  assert.deepEqual(bare, [], 'inputs sin type explícito: ' + JSON.stringify(bare));
});
