// CUBMATCH — cuentas con usuario + contraseña, sin servidor.
//
// Cómo funciona: la contraseña (con scrypt) deriva de forma determinista
// la clave secreta Nostr del usuario. Misma cuenta → misma identidad en
// cualquier dispositivo, sin que el usuario copie claves de 63 caracteres.
// El nombre de usuario se "reclama" publicando un evento de reclamo en los
// relays; el primero en reclamarlo se lo queda (por created_at).
// La contraseña NUNCA sale del dispositivo.
//
// Límites honestos: sin recuperación de contraseña (nadie la guarda).
// Si la olvidas, la identidad se pierde.
// (Patrón heredado de Espectro; reclamo en kind 30078 con d="cubmatch:perfil:<usuario>".)

import { scryptAsync } from '@noble/hashes/scrypt.js';
import { getPublicKey, nip19 } from 'nostr-tools';

export const KIND_CLAIM = 30078;
export const claimTag = (username) => `cubmatch:perfil:${username}`;

const enc = new TextEncoder();

export function normalizeUsername(raw) {
  const u = (raw || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,20}$/.test(u)) {
    throw new Error('El usuario debe tener entre 3 y 20 caracteres: letras, números, punto, guion o guion bajo.');
  }
  return u;
}

export function validatePassword(pw) {
  if (!pw || pw.length < 8) {
    throw new Error('La contraseña debe tener al menos 8 caracteres.');
  }
}

// Deriva la clave secreta (32 bytes) de usuario+contraseña.
export async function deriveSecretKey(username, password) {
  const salt = enc.encode('cubmatch:v1:' + username);
  let counter = 0;
  for (;;) {
    const input = counter === 0 ? enc.encode(password) : enc.encode(password + '#' + counter);
    const key = await scryptAsync(input, salt, { N: 16384, r: 8, p: 1, dkLen: 32 });
    try {
      getPublicKey(key); // valida que sirva como clave secp256k1
      return key;
    } catch { counter++; }
  }
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

// De varios reclamos del mismo usuario, gana el más antiguo.
export function pickEarliestClaim(parsed) {
  if (!parsed.length) return null;
  return parsed.reduce((a, b) => (b.created_at < a.created_at ? b : a));
}

export async function fetchUsernameClaim(client, username) {
  const out = [];
  const sub = client.subscribe(
    [{ kinds: [KIND_CLAIM], '#d': [claimTag(username)], limit: 10 }],
    (ev) => { const p = parseClaimEvent(ev); if (p && p.username === username) out.push(p); }
  );
  await sub.eose();
  sub.unsub();
  return pickEarliestClaim(out);
}

// ¿Las credenciales corresponden al dueño del reclamo?
export function verifyCredentials(derivedPubkey, claim) {
  return !!claim && claim.pubkey === derivedPubkey;
}

export function nsecOf(sk) { return nip19.nsecEncode(sk); }
