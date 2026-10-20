// CUBMATCH — subida de foto de perfil desde la galería (v1.5.0).
//
// Sin servidor propio: las fotos se suben a servidores Blossom (BUD-02),
// la misma infraestructura que ya aloja la página web. La subida se
// autentica con la clave Nostr del propio usuario (evento kind 24242
// firmado), así que no hay cuentas nuevas ni contraseñas extra.
//
// La foto resultante es PÚBLICA (igual que el perfil): en el evento del
// perfil solo viaja la URL resultante, nunca los bytes de la imagen.
//
// Flujo: elegir archivo → comprimir en el cliente (canvas, lado mayor
// ≤1024px, JPEG ~0.82: pensado para conexiones lentas y, de paso, sin
// metadatos EXIF/GPS) → sha256 → auth firmada → PUT al servidor.
// Si la compresión no está disponible (WebView viejo, jsdom), se sube
// el archivo original tal cual: la función nunca rompe el editor.

import { sha256 } from '@noble/hashes/sha2.js';
import { finalizeEvent } from 'nostr-tools';

// Servidores Blossom, en orden de preferencia. El que responde primero
// es el primario; el resto reciben copia espejo (best-effort).
// Orden verificado en real (2026-10-20): cdn.hzrd149.com acepta subidas
// BUD-02 de claves nuevas (201); nostr.download devolvió 409.
export const BLOSSOM_SERVERS = ['https://cdn.hzrd149.com', 'https://nostr.download'];

export const KIND_BLOSSOM_AUTH = 24242;
export const AUTH_EXPIRATION_SEGS = 600; // 10 min, como pide BUD-02
export const MAX_FOTO_LADO = 1024;
export const FOTO_JPEG_CALIDAD = 0.82;

// ---------------------------------------------------------------- sha256

export function sha256Hex(bytes) {
  const digest = sha256(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  return Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- base64

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Base64 estándar de un Uint8Array (sin depender de Buffer ni de btoa:
// funciona igual en navegador, WebView y Node, y es testeable).
export function b64EncodeBytes(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

// ------------------------------------------------------- auth Blossom BUD-02

// Plantilla (sin firmar) del evento de autorización de subida.
// BUD-02: kind 24242, tag "t" con la acción, tag "x" con el sha256 del
// blob y "expiration" en unix. Sin tag "server": vale para cualquier
// servidor Blossom, así el mismo evento sirve de primario y de espejo.
export function buildBlossomAuth({ sha256: sha, now, expirationSegs = AUTH_EXPIRATION_SEGS } = {}) {
  const ts = Math.floor(Number(now) || 0);
  return {
    kind: KIND_BLOSSOM_AUTH,
    created_at: ts,
    tags: [
      ['t', 'upload'],
      ['x', String(sha || '')],
      ['expiration', String(ts + expirationSegs)],
    ],
    content: 'Subir foto de perfil a CubMatch',
  };
}

// Firma la autorización con la identidad del usuario (finalizeEvent,
// el mismo mecanismo de firma que usa el resto de la app).
export function signBlossomAuth(sk, sha, now) {
  return finalizeEvent(buildBlossomAuth({ sha256: sha, now }), sk);
}

// Cabecera HTTP de BUD-02: "Nostr <base64 del evento firmado en JSON>".
export function blossomAuthHeader(signedEvent) {
  const json = JSON.stringify(signedEvent);
  return 'Nostr ' + b64EncodeBytes(new TextEncoder().encode(json));
}

// ------------------------------------------------------- respuesta del servidor

// Extrae la URL pública del blob de la respuesta de un servidor Blossom:
// normalmente viene en el campo "url"; algunos servidores solo devuelven
// el evento NIP-94, cuyo tag "url" es la misma dirección.
export function parseBlossomResponse(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.url === 'string' && json.url) return json.url;
  const ev = json.nip94_event;
  if (ev && Array.isArray(ev.tags)) {
    const t = ev.tags.find((tag) => Array.isArray(tag) && tag[0] === 'url' && tag[1]);
    if (t) return t[1];
  }
  return null;
}

// ---------------------------------------------------------------- compresión

// Dimensiones destino al reducir: el lado mayor queda en maxLado como
// mucho, manteniendo proporciones. Nunca agranda una imagen pequeña.
export function targetDimensions(ancho, alto, maxLado = MAX_FOTO_LADO) {
  const w = Math.max(1, Math.round(Number(ancho) || 0) || 1);
  const h = Math.max(1, Math.round(Number(alto) || 0) || 1);
  if (w <= maxLado && h <= maxLado) return { width: w, height: h };
  const escala = maxLado / Math.max(w, h);
  return {
    width: Math.max(1, Math.round(w * escala)),
    height: Math.max(1, Math.round(h * escala)),
  };
}

// Comprime una imagen en el cliente (canvas → JPEG). Cualquier fallo
// (canvas no disponible, formato raro, WebView viejo) devuelve el blob
// original: subir la foto nunca se bloquea por la compresión.
export async function preparePhotoBlob(blob) {
  try {
    if (!blob || typeof blob.type !== 'string' || !blob.type.startsWith('image/')) return blob;
    const { source, objUrl } = await loadBitmap(blob);
    try {
      const naturalW = source.naturalWidth || source.width;
      const naturalH = source.naturalHeight || source.height;
      if (!naturalW || !naturalH) return blob;
      const { width, height } = targetDimensions(naturalW, naturalH);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return blob;
      ctx.drawImage(source, 0, 0, width, height);
      const out = await new Promise((res) => {
        try { canvas.toBlob(res, 'image/jpeg', FOTO_JPEG_CALIDAD); }
        catch { res(null); }
      });
      if (!out) return blob;
      // Si no hubo que reducir y el JPEG salió más pesado, quédate el original.
      if (width === naturalW && height === naturalH && out.size >= blob.size) return blob;
      return out;
    } finally {
      if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch {} }
      if (source && typeof source.close === 'function') { try { source.close(); } catch {} }
    }
  } catch {
    return blob;
  }
}

async function loadBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    return { source: await createImageBitmap(blob), objUrl: null };
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw new Error('sin decodificador de imágenes disponible');
  }
  const objUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('imagen no legible'));
      im.src = objUrl;
    });
    return { source: img, objUrl };
  } catch (e) {
    try { URL.revokeObjectURL(objUrl); } catch {}
    throw e;
  }
}

// ---------------------------------------------------------------- subida

// PUT de un blob a UN servidor Blossom con la cabecera de autorización.
// Devuelve la URL pública; lanza si el servidor falla o no da URL.
export async function uploadToBlossom(server, blob, authHeader, fetchImpl) {
  const base = String(server || '').replace(/\/+$/, '');
  const res = await fetchImpl(base + '/upload', {
    method: 'PUT',
    headers: {
      Authorization: authHeader,
      'Content-Type': (blob && blob.type) || 'application/octet-stream',
    },
    body: blob,
  });
  if (!res || !res.ok) {
    throw new Error('Blossom ' + base + ' respondió ' + (res ? res.status : 'sin respuesta'));
  }
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  const url = parseBlossomResponse(json);
  if (!url) throw new Error('Blossom ' + base + ' no devolvió la URL de la foto');
  return url;
}

// Sube la foto ya preparada firmando con la clave del usuario.
// Prueba los servidores en orden; el primero que acepta manda y su URL
// es la que se devuelve. Los demás reciben copia espejo best-effort
// (sin esperarlos y sin que su fallo afecte a la operación).
// Lanza solo si TODOS los servidores fallan.
export async function uploadPhoto(blob, sk, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch no disponible');
  const servers = (Array.isArray(opts.servers) && opts.servers.length ? opts.servers : BLOSSOM_SERVERS)
    .map((s) => String(s).replace(/\/+$/, ''));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha = sha256Hex(bytes);
  const now = opts.nowSec || Math.floor(Date.now() / 1000);
  const header = blossomAuthHeader(signBlossomAuth(sk, sha, now));
  let lastErr = null;
  for (let i = 0; i < servers.length; i++) {
    try {
      const url = await uploadToBlossom(servers[i], blob, header, fetchImpl);
      for (let j = 0; j < servers.length; j++) {
        if (j === i) continue;
        // Espejo: misma auth (el tag "x" es el mismo blob), sin bloquear.
        uploadToBlossom(servers[j], blob, header, fetchImpl).catch(() => {});
      }
      return url;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('No se pudo subir la foto');
}
