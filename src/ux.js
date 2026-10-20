// CUBMATCH — lógica UX pura y testeable (v1.2.0):
//  - fortaleza de contraseña (medidor visual)
//  - contador de perfiles publicados en la red (prueba social REAL)
//  - disponibilidad de nombre de usuario (chequeo en relays)
//  - logo cubano en SVG inline (reemplaza al emoji ❤️‍🔥)

import { fetchUsernameClaim } from './cuentas.js';
import { KIND_PERFIL, TAG_T, parsePerfilEvent } from './cubmatch.js';
import { eventoValido } from './red.js';

// ---------- fortaleza de contraseña ----------
// Puntúa por longitud (>=8, >=12) y variedad de clases
// (minúsculas, mayúsculas, dígitos, símbolos). Devuelve
// {score: 0..3, label: 'débil'|'media'|'fuerte'}.
export function passwordStrength(pw) {
  const s = String(pw || '');
  if (s.length < 8) return { score: 0, label: 'débil' };
  let score = 1;
  if (s.length >= 12) score++;
  const variedad = [
    /[a-záéíóúñü]/,
    /[A-ZÁÉÍÓÚÑÜ]/,
    /[0-9]/,
    /[^a-zA-Z0-9áéíóúñüÁÉÍÓÚÑÜ]/,
  ].filter((r) => r.test(s)).length;
  if (variedad >= 3) score++;
  if (variedad === 1) score = Math.max(0, score - 1);
  score = Math.max(0, Math.min(3, score));
  return { score, label: score <= 1 ? 'débil' : score === 2 ? 'media' : 'fuerte' };
}

// ---------- contador de perfiles en la red ----------
// Caché del contador en localStorage: válido por 1 hora.
export const NETCOUNT_TTL_MS = 60 * 60 * 1000;

// Cuenta autores únicos con perfil publicado y visible desde una lista
// de eventos crudos: verifica firma, parsea y descarta ocultos/duplicados.
export function contarPerfiles(eventos) {
  const porAutor = new Map();
  for (const ev of eventos || []) {
    if (!eventoValido(ev)) continue;
    const p = parsePerfilEvent(ev);
    if (!p || (p.profile && p.profile.oculto)) continue;
    const prev = porAutor.get(p.pubkey);
    if (!prev || p.created_at > prev.created_at) porAutor.set(p.pubkey, p);
  }
  return porAutor.size;
}

// Devuelve el conteo cacheado si sigue fresco; null si no hay o expiró.
export function netcountFromCache(cache, now = Date.now()) {
  if (!cache || typeof cache.n !== 'number' || typeof cache.ts !== 'number') return null;
  if (now - cache.ts > NETCOUNT_TTL_MS) return null;
  return cache.n;
}

// Consulta los relays (scope discovery) y cuenta perfiles publicados.
// Devuelve el número, o null si la consulta falla. No bloquea la UI:
// el EOSE tiene su propio timeout (red.js) y aquí hay uno extra de 15 s.
export async function fetchNetCount(pool, { limit = 500 } = {}) {
  const eventos = [];
  const vistos = new Set();
  try {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const sub = pool.discovery().subscribe(
        [{ kinds: [KIND_PERFIL], '#t': [TAG_T], limit }],
        (ev) => {
          if (!ev || typeof ev.id !== 'string' || vistos.has(ev.id)) return;
          vistos.add(ev.id);
          eventos.push(ev);
        }
      );
      sub.eose().then(() => { try { sub.unsub(); } catch {} finish(); });
      setTimeout(finish, 15000);
    });
  } catch { return null; }
  try { return contarPerfiles(eventos); } catch { return null; }
}

// ---------- disponibilidad de nombre de usuario ----------
// Devuelve 'tomado' | 'disponible' | 'sin-red'. El chequeo definitivo
// sigue siendo el de submitCuenta; esto es solo feedback en vivo.
export async function checkUsername(pool, username) {
  const claim = await fetchUsernameClaim(pool, username);
  if (claim) return 'tomado';
  const client = pool.discovery();
  const anyOpen = client.relays.some((u) => client.status(u) === 'open');
  return anyOpen ? 'disponible' : 'sin-red';
}

// ---------- logo cubano ----------
// Corazón con las franjas azul/blanca y el triángulo rojo con estrella
// de la bandera cubana, + llamita ámbar en homenaje al logo anterior.
// `variant` sufija los ids internos para poder usarlo dos veces en la
// misma página (landing + header) sin colisiones de clipPath.
export function logoSVG(size = 84, variant = '') {
  const s = Math.max(16, Math.round(size || 84));
  const clip = 'cm-corazon' + (variant ? '-' + String(variant).replace(/[^a-z0-9-]/gi, '') : '');
  const heart = 'M50 90C24 68 10 50 10 32 10 19 20 10 31 10c8 0 15 5 19 12 4-7 11-12 19-12 11 0 21 9 21 22 0 18-14 36-40 58z';
  return (
    '<svg width="' + s + '" height="' + Math.round(s * 1.04) + '" viewBox="0 0 100 104" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CubMatch">' +
    '<defs><clipPath id="' + clip + '"><path d="' + heart + '"/></clipPath></defs>' +
    '<g clip-path="url(#' + clip + ')">' +
    '<rect x="0" y="8" width="100" height="19" fill="#1565c0"/>' +
    '<rect x="0" y="27" width="100" height="19" fill="#ffffff"/>' +
    '<rect x="0" y="46" width="100" height="19" fill="#1565c0"/>' +
    '<rect x="0" y="65" width="100" height="19" fill="#ffffff"/>' +
    '<rect x="0" y="84" width="100" height="18" fill="#1565c0"/>' +
    '<polygon points="8,8 50,50 8,94" fill="#d32f2f"/>' +
    '<polygon points="20.5,43.6 22.2,47.9 26.7,48 23.2,51 24.3,55.4 20.5,52.9 16.7,55.4 17.8,51 14.3,48 18.8,47.9" fill="#ffffff"/>' +
    '</g>' +
    '<path d="' + heart + '" fill="none" stroke="rgba(93,64,55,.35)" stroke-width="2"/>' +
    '<path d="M50 1.5c1.7 3.2 4.4 4.5 4.4 7.9a4.4 4.4 0 1 1-8.8 0C45.6 6 48.3 4.7 50 1.5z" fill="#f9a825"/>' +
    '</svg>'
  );
}
