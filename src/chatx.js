// CUBMATCH — extras del chat de matches (v1.6.0): ubicación y stickers.
//
// Los DMs especiales viajan como texto cifrado NIP-04 igual que los
// demás, pero con contenido JSON en vez de texto plano:
//   ubicación: {"t":"loc","lat":23.11,"lon":-82.36}
//   sticker:   {"t":"sticker","url":"https://…"}
// Un cliente viejo no los entiende y vería el JSON crudo; la app se
// autoactualiza, así que se acepta esa compatibilidad hacia atrás.
//
// La biblioteca de stickers es PERSONAL y local (localStorage por
// cuenta): WhatsApp no deja que ninguna app web lea sus stickers, así
// que el usuario guarda los suyos como imagen y los sube aquí. La
// subida reutiliza Blossom (foto.js); el sticker conserva su formato
// con alfa (WebP/PNG): nada de recompresión a JPEG.

import { targetDimensions, loadBitmap } from './foto.js';

export const MAX_STICKER_LADO = 512;
export const MAX_STICKER_BYTES = 1024 * 1024; // ~1 MB
export const MAX_STICKERS = 60; // tope de la biblioteca personal

// ------------------------------------------------------------ validación

export function coordsValidas(lat, lon) {
  return typeof lat === 'number' && typeof lon === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export function esUrlHttp(url) {
  return typeof url === 'string' && url.length <= 2048 && /^https?:\/\//i.test(url);
}

// ------------------------------------------------------------ payloads

// Payload de ubicación. Redondea a 6 decimales (~0,1 m): es la
// ubicación exacta que el usuario aceptó compartir en la confirmación.
export function buildLocPayload(lat, lon) {
  if (!coordsValidas(lat, lon)) throw new Error('coordenadas inválidas');
  const r = (n) => Math.round(n * 1e6) / 1e6;
  return JSON.stringify({ t: 'loc', lat: r(lat), lon: r(lon) });
}

// Payload de borrado para ambos (v1.12.16): un DM cifrado como los
// demás, no un evento público kind 5 — el borrado no debe filtrar
// metadatos a terceros. Solo el id del DM a borrar; la regla justa
// (solo el autor borra lo suyo) la aplica aplicarBorrado en mensajes.js.
export function buildBorrarPayload(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) throw new Error('id de mensaje inválido');
  return JSON.stringify({ t: 'borrar', id });
}
export function buildStickerPayload(url) {
  if (!esUrlHttp(url)) throw new Error('URL de sticker inválida');
  return JSON.stringify({ t: 'sticker', url });
}

// Reconoce un DM especial. Devuelve {tipo:'loc',lat,lon} |
// {tipo:'sticker',url} | null (texto normal o JSON inválido/hostil).
// Nunca lanza: cualquier cosa rara se renderiza como texto plano.
export function parseChatPayload(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t[0] !== '{') return null;
  let o;
  try { o = JSON.parse(t); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.t === 'loc') {
    if (!coordsValidas(o.lat, o.lon)) return null;
    return { tipo: 'loc', lat: o.lat, lon: o.lon };
  }
  if (o.t === 'sticker') {
    if (!esUrlHttp(o.url)) return null;
    return { tipo: 'sticker', url: o.url };
  }
  if (o.t === 'borrar') {
    if (typeof o.id !== 'string' || !/^[0-9a-f]{64}$/.test(o.id)) return null;
    return { tipo: 'borrar', id: o.id };
  }
  return null;
}

// Enlace al mapa: OpenStreetMap (no Google Maps: bloqueado en Cuba).
export function osmUrl(lat, lon) {
  return 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lon +
    '#map=16/' + lat + '/' + lon;
}

// Texto en español para los errores de la Geolocation API.
export function geoErrorTexto(err) {
  const code = err && typeof err === 'object' ? err.code : err;
  if (code === 1) return 'Permiso de ubicación denegado. Si quieres compartirla, revisa los permisos del navegador.';
  if (code === 2) return 'No se pudo obtener tu posición ahora mismo. Inténtalo de nuevo.';
  if (code === 3) return 'La ubicación tardó demasiado en llegar. Inténtalo de nuevo.';
  return 'No se pudo obtener tu ubicación.';
}

// ------------------------------------------------------------ stickers: formato

// Formato de salida al reducir un sticker: se conserva el alfa.
// WebP queda WebP; cualquier otra cosa sale PNG (con alfa), nunca JPEG.
export function stickerOutType(tipo) {
  return String(tipo || '').toLowerCase() === 'image/webp' ? 'image/webp' : 'image/png';
}

// Plan de reducción de un sticker: lado mayor ≤ MAX_STICKER_LADO,
// proporciones intactas, nunca agranda.
export function planSticker(ancho, alto, tipo) {
  const w = Math.max(1, Math.round(Number(ancho) || 0) || 1);
  const h = Math.max(1, Math.round(Number(alto) || 0) || 1);
  const dims = targetDimensions(w, h, MAX_STICKER_LADO);
  return {
    width: dims.width,
    height: dims.height,
    needsResize: dims.width !== w || dims.height !== h,
    outType: stickerOutType(tipo),
  };
}

export function stickerPesoOk(size) {
  const n = Number(size);
  return Number.isFinite(n) && n >= 0 && n <= MAX_STICKER_BYTES;
}

// Prepara el blob de un sticker para subirlo: si ya cabe (≤512px de
// lado) se devuelve TAL CUAL — formato y alfa intactos, sin pasar por
// canvas —; si es más grande, se reduce con canvas exportando en un
// formato con alfa (WebP/PNG según el original). Cualquier fallo
// (canvas ausente, WebView viejo) devuelve el original: la subida
// nunca se bloquea por la preparación.
export async function prepareStickerBlob(blob) {
  try {
    if (!blob || typeof blob.type !== 'string' || !blob.type.startsWith('image/')) return blob;
    const { source, objUrl } = await loadBitmap(blob);
    try {
      const naturalW = source.naturalWidth || source.width;
      const naturalH = source.naturalHeight || source.height;
      if (!naturalW || !naturalH) return blob;
      const plan = planSticker(naturalW, naturalH, blob.type);
      if (!plan.needsResize) return blob;
      const canvas = document.createElement('canvas');
      canvas.width = plan.width;
      canvas.height = plan.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return blob;
      ctx.drawImage(source, 0, 0, plan.width, plan.height);
      const out = await new Promise((res) => {
        try { canvas.toBlob(res, plan.outType, 0.92); }
        catch { res(null); }
      });
      return out || blob;
    } finally {
      if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch {} }
      if (source && typeof source.close === 'function') { try { source.close(); } catch {} }
    }
  } catch {
    return blob;
  }
}

// La carga de la imagen la hace loadBitmap de foto.js (una sola
// definición compartida con la foto de perfil): createImageBitmap si
// está, si no <img> con object URL. Sin decodificador, rechaza y el
// llamador devuelve el blob original intacto.

// ------------------------------------------------------------ biblioteca

// La biblioteca vive en un storage inyectable {get(k,def), set(k,v)}
// (en la app es el LS con prefijo; en tests, un mapa en memoria),
// con clave por cuenta: cada identidad tiene sus stickers.
export function stickerStorageKey(pubkey) {
  return 'stickers:' + String(pubkey || '');
}

export function loadStickers(store, pubkey) {
  let raw;
  try { raw = store.get(stickerStorageKey(pubkey), []); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.filter(esUrlHttp);
}

// Añade un sticker (el más reciente primero). Dedup por URL y tope
// MAX_STICKERS: al pasar del tope se cae el más viejo. Devuelve la
// lista resultante (sin cambios si la URL no es válida).
export function addSticker(store, pubkey, url) {
  const list = loadStickers(store, pubkey);
  if (!esUrlHttp(url)) return list;
  const out = [url, ...list.filter((u) => u !== url)].slice(0, MAX_STICKERS);
  try { store.set(stickerStorageKey(pubkey), out); } catch {}
  return out;
}

export function removeSticker(store, pubkey, url) {
  const out = loadStickers(store, pubkey).filter((u) => u !== url);
  try { store.set(stickerStorageKey(pubkey), out); } catch {}
  return out;
}
