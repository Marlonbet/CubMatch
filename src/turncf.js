// CUBMATCH — Cloudflare Realtime TURN (v1.9.0): relevo prioritario
// para las llamadas cuando la conexión directa no atraviesa (datos
// móviles tras CGNAT). Cloudflare regala 1 TB/mes de TURN; las
// credenciales son TEMPORALES (TTL 24 h) y se piden a su API en el
// momento de la llamada — nunca se guardan credenciales de TURN de
// larga duración en la app.
//
// CÓMO LLEGAN LAS CREDENCIALES A ESTE ARCHIVO (sin servidor propio):
// el código fuente trae los placeholders literales __TURNCF_KEY_ID__
// y __TURNCF_TOKEN__. El build (build.mjs) los sustituye por valores
// reales SOLO si la variable de entorno TURNCF_INJECT apunta a un
// JSON {keyId, token} (la clave de TURN y su token API de la cuenta
// de Cloudflare del dueño). Sin esa variable, el build sustituye los
// placeholders por cadena vacía y esta función queda DESACTIVADA:
// getCfIceServers devuelve siempre null y las llamadas usan la
// configuración de siempre (OpenRelay + STUN, ver llamadas.js).
//
// OJO, con honestidad: lo inyectado queda VISIBLE en el bundle
// publicado (es una app de un solo archivo, sin backend donde
// esconderlo). El token solo puede acuñar credenciales temporales
// de TURN de esa cuenta gratuita — no da acceso a nada más — pero
// quien lo copie puede gastar la cuota de 1 TB/mes. Es el precio de
// no tener servidor; el respaldo (OpenRelay público) no depende de
// estas credenciales y sigue funcionando aunque se desactiven.
//
// Este módulo es puro: fetch y reloj inyectables para probarlo en
// Node sin red.

// Placeholders: build.mjs los reemplaza en el bundle (ver arriba).
export const CF_KEY_ID = '__TURNCF_KEY_ID__';
export const CF_TOKEN = '__TURNCF_TOKEN__';

export const CF_API_BASE = 'https://rtc.live.cloudflare.com';
export const CF_TTL_SEG = 86400;                    // credenciales de 24 h
export const CF_CACHE_MAX_MS = 6 * 60 * 60 * 1000;  // reutilizar 6 h
export const CF_FETCH_TIMEOUT_MS = 4000;            // la llamada no espera más

let _cache = null; // { servers, ts } — solo en memoria, por sesión

// Una credencial es "real" si no está vacía ni es el placeholder del
// código fuente (build sin TURNCF_INJECT, o tests corriendo sobre src/).
function esCredencialReal(v) {
  return typeof v === 'string' && v.trim() !== '' && !v.startsWith('__TURNCF');
}

// ¿Está la función configurada? (credenciales inyectadas en el build)
export function cfConfigurado(keyId = CF_KEY_ID, token = CF_TOKEN) {
  return esCredencialReal(keyId) && esCredencialReal(token);
}

// Solo para tests: olvida la caché en memoria.
export function _resetCfCache() { _cache = null; }

// Pide a Cloudflare credenciales temporales de TURN y devuelve su
// array `iceServers` listo para RTCPeerConnection (trae su propio
// STUN + TURN). Con caché en memoria: se reutiliza si tiene menos de
// CF_CACHE_MAX_MS, salvo { force: true }. Sin credenciales, sin red
// o con cualquier error devuelve null — NUNCA lanza: el llamante
// cae siempre a la configuración de respaldo.
export async function getCfIceServers({ force = false, fetchFn, nowFn, keyId, token } = {}) {
  const kid = keyId !== undefined ? keyId : CF_KEY_ID;
  const tok = token !== undefined ? token : CF_TOKEN;
  if (!cfConfigurado(kid, tok)) return null;
  const ahora = typeof nowFn === 'function' ? nowFn : Date.now;
  if (!force && _cache && ahora() - _cache.ts < CF_CACHE_MAX_MS) return _cache.servers;
  const doFetch = fetchFn !== undefined ? fetchFn
    : (typeof fetch === 'function' ? fetch : null);
  if (typeof doFetch !== 'function') return null;
  let timer = null;
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) {
      timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, CF_FETCH_TIMEOUT_MS);
    }
    const res = await doFetch(
      CF_API_BASE + '/v1/turn/keys/' + encodeURIComponent(kid) + '/credentials/generate-ice-servers',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: CF_TTL_SEG }),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      }
    );
    if (!res || res.ok !== true) return null;
    const data = await res.json();
    const servers = data && Array.isArray(data.iceServers)
      ? data.iceServers.filter((e) => e && typeof e === 'object' && e.urls != null)
      : null;
    if (!servers || !servers.length) return null;
    _cache = { servers, ts: ahora() };
    return servers;
  } catch {
    return null; // red caída, timeout, JSON roto: respaldo en silencio
  } finally {
    if (timer) clearTimeout(timer);
  }
}
