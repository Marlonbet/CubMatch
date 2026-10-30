// CUBMATCH — cuentas con usuario + contraseña, sin servidor.
//
// Cómo funciona: la contraseña (con scrypt) deriva de forma determinista
// la clave secreta Nostr del usuario. Misma cuenta → misma identidad en
// cualquier dispositivo, sin que el usuario copie claves de 63 caracteres.
// El nombre de usuario se "reclama" publicando un evento de reclamo en los
// relays. La contraseña NUNCA sale del dispositivo.
//
// Límites honestos: sin recuperación de contraseña (nadie la guarda).
// Si la olvidas, la identidad se pierde.
// (Patrón heredado de Espectro; reclamo en kind 30078 con d="cubmatch:perfil:<usuario>".)
//
// Seguridad (revisión 2026-10; resto de M4 cerrado en v1.11.2, M5 en v1.11.3):
//  · El created_at de un reclamo lo elige quien lo publica, así que NO es
//    una prueba de "quién llegó primero". Antes, publicar un reclamo con
//    created_at=1 dejaba fuera de su propia cuenta al dueño legítimo. Ahora
//    el login acepta CUALQUIER reclamo cuyo pubkey coincida con el derivado
//    de las credenciales (verifyCredentials), y el registro solo trata el
//    nombre como ocupado si algún reclamante está corroborado
//    (nombreOcupado): un reclamo pelado con created_at=1 ya no "ocupa"
//    el nombre por adelantado.
//  · M5 — carrera de registro simultáneo: en Nostr no hay un registro
//    atómico de nombres, así que dos registros a la vez NO se pueden
//    impedir: ambos publican reclamo + documentos y ambos creerían que
//    el nombre es suyo. Lo que sí se puede arreglar es el silencio:
//    tras registrar, la app vuelve a consultar los reclamos y, si OTRO
//    reclamante también está corroborado, avisa (nombreEnDisputa). El
//    último en publicar es el que ve el aviso; el primero lo verá al
//    entrar de nuevo. El aviso persiste en local hasta que un chequeo
//    nuevo diga lo contrario, porque un nombre en disputa lo sigue
//    estando: los reclamos no se borran.
//  · La clave sale de una contraseña y la pubkey y el salt son públicos, así
//    que cualquiera puede probar contraseñas OFFLINE contra un perfil. Mitigación:
//    contraseñas nuevas más largas (validateNewPassword) y scrypt más caro
//    (KDF v2, opt-in: deriveSecretKey(u, p, { version: 2 }) y resolverCuenta()).
//    El login debe usar resolverCuenta() para seguir aceptando cuentas v1.

import { scryptAsync } from '@noble/hashes/scrypt.js';
import { getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { eventoValido, esEventoNuevo } from './red.js';
import { KIND_PERFIL, KIND_RELAY_LIST, KIND_DM_INBOX, TAG_D } from './cubmatch.js';

export const KIND_CLAIM = 30078;
export const claimTag = (username) => `cubmatch:perfil:${username}`;

const enc = new TextEncoder();

// Parámetros de derivación por versión. v1 = cuentas existentes (NO tocar:
// cambiarlos cambiaría la identidad de todos los usuarios). v2 = cuentas
// nuevas; N=2^16 usa ~64 MB y tarda varios segundos en móviles modestos —
// pruébalo en un teléfono barato y baja a 2^15 si hace falta (solo afecta a
// cuentas creadas DESPUÉS del cambio, y el valor queda fijo por versión).
export const KDF = {
  1: { N: 16384, prefix: 'cubmatch:v1:' },
  2: { N: 65536, prefix: 'cubmatch:v2:' },
};
export const KDF_ACTUAL = 2; // la que deben usar las cuentas NUEVAS

export function normalizeUsername(raw) {
  const u = (raw || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,20}$/.test(u)) {
    throw new Error('El usuario debe tener entre 3 y 20 caracteres: letras, números, punto, guion o guion bajo.');
  }
  return u;
}

// Validación MÍNIMA (compatibilidad): es la que acepta las cuentas que ya
// existen. Úsala para INICIAR SESIÓN. Para crear una cuenta, validateNewPassword.
export function validatePassword(pw) {
  if (!pw || pw.length < 8) {
    throw new Error('La contraseña debe tener al menos 8 caracteres.');
  }
}

// Contraseñas muy comunes (normalizadas: minúsculas, sin acentos).
const COMUNES = new Set([
  'password', 'contrasena', 'contrasena1', 'passw0rd', 'p@ssw0rd', 'password1', 'pass',
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345678910', '111111', '000000',
  '123123', '654321', '1q2w3e4r', '1qaz2wsx', 'qwerty', 'qwerty123', 'qwertyuiop', 'abc123',
  'iloveyou', 'teamo', 'tequiero', 'amor', 'amorcito', 'corazon', 'princesa', 'mariposa',
  'estrella', 'lamejor', 'dios', 'jesus', 'cuba', 'cubana', 'cubano', 'habana', 'lahabana',
  'santiago', 'cubmatch', 'admin', 'letmein', 'welcome', 'monkey', 'dragon', 'football',
]);

function sinAcentos(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Validación para contraseñas NUEVAS (registro / cambio). Más estricta porque
// la contraseña es la ÚNICA protección de la clave: ≥12 caracteres, no común,
// sin el nombre de usuario y con variedad. Una frase de 4 palabras largas
// cumple y es más fácil de recordar que una clave "rara".
export function validateNewPassword(pw, username = '') {
  const p = String(pw || '');
  if (p.length < 12) {
    throw new Error('La contraseña debe tener al menos 12 caracteres. Una frase de 4 palabras es más fácil de recordar y más segura.');
  }
  if (new Set(p).size < 6) {
    throw new Error('La contraseña es demasiado repetitiva. Usa más variedad de caracteres.');
  }
  const n = sinAcentos(p).trim();
  const base = n.replace(/[0-9!@#$%^&*._\-\s]+$/, '');
  if (COMUNES.has(n) || COMUNES.has(base)) {
    throw new Error('Esa contraseña es de las más comunes. Elige otra.');
  }
  const u = sinAcentos(username).trim();
  if (u.length >= 3 && n.includes(u)) {
    throw new Error('La contraseña no debe contener tu nombre de usuario.');
  }
  if (/^\d+$/.test(p)) {
    throw new Error('La contraseña no puede ser solo números.');
  }
}

// Deriva la clave secreta (32 bytes) de usuario+contraseña.
// version 1 (por defecto) = cuentas existentes; 2 = scrypt más caro.
export async function deriveSecretKey(username, password, opts = {}) {
  const version = opts.version === undefined ? 1 : opts.version;
  const params = KDF[version];
  if (!params) throw new Error('Versión de derivación desconocida: ' + version);
  const salt = enc.encode(params.prefix + username);
  let counter = 0;
  for (;;) {
    const input = counter === 0 ? enc.encode(password) : enc.encode(password + '#' + counter);
    const key = await scryptAsync(input, salt, { N: params.N, r: 8, p: 1, dkLen: 32 });
    try {
      getPublicKey(key); // valida que sirva como clave secp256k1
      return key;
    } catch { counter++; }
  }
}

// Login tolerante a versiones: prueba v2 y luego v1 y se queda con la que
// coincide con el reclamo publicado. Devuelve { sk, version, pubkey } o null.
// (Calcula v1 solo si v2 no coincide; con un reclamo nulo no deriva nada.)
export async function resolverCuenta(username, password, claim, versiones = [2, 1]) {
  if (!claim) return null;
  for (const version of versiones) {
    const sk = await deriveSecretKey(username, password, { version });
    const pubkey = getPublicKey(sk);
    if (verifyCredentials(pubkey, claim)) return { sk, version, pubkey };
  }
  return null;
}

export function buildClaimEvent(username) {
  return {
    kind: KIND_CLAIM,
    tags: [['d', claimTag(username)], ['t', 'cubmatch-cuenta']],
    content: JSON.stringify({ v: 1, username, creado: Date.now() }),
  };
}

export function parseClaimEvent(ev) {
  if (!ev || ev.kind !== KIND_CLAIM) return null;
  const d = (ev.tags.find((t) => t[0] === 'd') || [])[1] || '';
  if (!d.startsWith('cubmatch:perfil:')) return null;
  let body;
  try { body = JSON.parse(ev.content); } catch { return null; }
  if (!body || body.v !== 1 || !body.username) return null;
  return { username: body.username, pubkey: ev.pubkey, created_at: ev.created_at, id: ev.id };
}

// Reclamantes corroborados del nombre: pubkeys de TODOS los reclamos
// vistos que además tienen un 10002/10050 o un perfil 30079 con firma
// válida. Un reclamo pelado no corrobora a nadie (M4).
export async function pubkeysCorroborados(pool, claim) {
  if (!claim) return new Set();
  const pubkeys = [...new Set(
    [claim.pubkey, ...((claim.todos || []).map((c) => c && c.pubkey))]
      .filter((p) => typeof p === 'string' && p)
  )];
  if (!pubkeys.length) return new Set();
  const corroborados = new Set();
  const run = (client) => new Promise((resolve) => {
    const sub = client.subscribe(
      [{ kinds: [KIND_RELAY_LIST, KIND_DM_INBOX, KIND_PERFIL], authors: pubkeys, limit: pubkeys.length }],
      (ev) => {
        if (!ev || !pubkeys.includes(ev.pubkey)) return;
        if (ev.kind !== KIND_RELAY_LIST && ev.kind !== KIND_DM_INBOX && ev.kind !== KIND_PERFIL) return;
        if (!eventoValido(ev)) return;
        if (ev.kind === KIND_PERFIL) {
          const d = (ev.tags || []).find((t) => t[0] === 'd') || [];
          if (d[1] !== TAG_D) return;
        }
        corroborados.add(ev.pubkey);
      }
    );
    sub.eose().then(() => { sub.unsub(); resolve(); });
  });
  await run(pool.discovery());
  if (!corroborados.size && pool.scopeDegraded('discovery')) await run(pool.messaging());
  return corroborados;
}

export async function nombreOcupado(pool, claim) {
  return (await pubkeysCorroborados(pool, claim)).size > 0;
}

// ¿El nombre está en disputa para mí (M5)? True si ALGÚN reclamante
// corroborado tiene un pubkey distinto del mío: otra cuenta completó el
// registro del mismo nombre. Mi propia corroboración no cuenta (si no,
// todo registro se marcaría en disputa a sí mismo), y que yo aún no
// tenga documentos no me salva: si el otro sí los tiene, yo perdí.
// Best-effort por diseño: si los relays no devuelven aún los
// documentos del rival, este chequeo no los ve — por eso se repite en
// cada login, no solo tras el registro.
export async function nombreEnDisputa(pool, claim, miPubkey) {
  if (!claim || !miPubkey) return false;
  const corroborados = await pubkeysCorroborados(pool, claim);
  return [...corroborados].some((p) => p !== miPubkey);
}

// De varios reclamos del mismo usuario, el de created_at más bajo. OJO: ese
// campo lo elige el autor del evento, así que NO prueba quién fue primero;
// solo se conserva por compatibilidad (formato anterior y atajo en
// verifyCredentials). Quién "ocupa" un nombre lo decide nombreOcupado(),
// no este orden.
export function pickEarliestClaim(parsed) {
  if (!parsed.length) return null;
  return parsed.reduce((a, b) => (b.created_at < a.created_at ? b : a));
}

// Devuelve el reclamo "ganador" (compatible con el formato anterior:
// {username, pubkey, created_at, id}) más `todos`: TODOS los reclamos válidos
// vistos, para que verifyCredentials no deje fuera al dueño legítimo.
export async function fetchUsernameClaim(pool, username) {
  const out = [];
  const vistos = new Set(); // ids ya verificados en esta suscripción
  const run = (client) => new Promise((resolve) => {
    const sub = client.subscribe(
      [{ kinds: [KIND_CLAIM], '#d': [claimTag(username)], limit: 10 }],
      (ev) => {
        if (!esEventoNuevo(vistos, ev)) return;
        if (!eventoValido(ev)) { console.warn('[cubmatch] reclamo con firma inválida, descartado:', ev.id); return; }
        const p = parseClaimEvent(ev); if (p && p.username === username) out.push(p);
      }
    );
    sub.eose().then(() => { sub.unsub(); resolve(); });
  });
  await run(pool.discovery());
  if (!out.length && pool.scopeDegraded('discovery')) await run(pool.messaging());
  const ganador = pickEarliestClaim(out);
  return ganador ? { ...ganador, todos: out.slice() } : null;
}

// ¿Las credenciales corresponden a ALGÚN dueño legítimo del nombre?
// Con `claim.todos` (de fetchUsernameClaim) basta con que el pubkey derivado
// coincida con cualquiera de los reclamos: un reclamo falso con created_at
// adulterado ya no puede dejar fuera al verdadero dueño. Sin `todos`
// (reclamos antiguos o armados a mano) se comporta como antes.
export function verifyCredentials(derivedPubkey, claim) {
  if (!claim) return false;
  if (claim.pubkey === derivedPubkey) return true;
  return Array.isArray(claim.todos) && claim.todos.some((c) => c && c.pubkey === derivedPubkey);
}

export function nsecOf(sk) { return nip19.nsecEncode(sk); }
