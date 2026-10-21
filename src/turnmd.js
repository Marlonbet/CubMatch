// CUBMATCH — Metered / Open Relay TURN con cuenta propia (v1.9.1):
// relevo prioritario para las llamadas cuando la conexión directa
// no atraviesa (datos móviles tras CGNAT). Metered (empresa
// canadiense) regala 20 GB/mes de TURN permanentes, sin tarjeta
// bancaria registrada: si se agota la cuota, el relevo se corta
// hasta el mes siguiente — nunca cobra. La app pide credenciales
// frescas a la API de la cuenta al momento de la llamada.
//
// CÓMO LLEGAN LAS CREDENCIALES A ESTE ARCHIVO (sin servidor propio):
// el código fuente trae los placeholders literales __TURNMD_APP__
// y __TURNMD_APIKEY__. El build (build.mjs) los sustituye por
// valores reales SOLO si la variable de entorno TURNMD_INJECT
// apunta a un JSON {app, apiKey} (el nombre de la app y la API key
// de la cuenta de Metered del dueño). Sin esa variable, el build
// sustituye los placeholders por cadena vacía y esta función queda
// DESACTIVADA: getMeteredIceServers devuelve siempre null y las
// llamadas usan la configuración de siempre (OpenRelay público +
// STUN, ver llamadas.js).
//
// OJO, con honestidad: lo inyectado queda VISIBLE en el bundle
// publicado (es una app de un solo archivo, sin backend donde
// esconderlo). Quien copie la API key puede pedir credenciales y
// gastar la cuota gratuita de 20 GB/mes — no puede cobrarle nada al
// dueño (la cuenta free no tiene tarjeta) ni acceder a nada más.
// Es el precio de no tener servidor; el respaldo (OpenRelay
// público) no depende de esta cuenta y sigue funcionando aunque
// esta se desactive.
//
// Este módulo es puro: fetch y reloj inyectables para probarlo en
// Node sin red.

// Placeholders: build.mjs los reemplaza en el bundle (ver arriba).
export const MD_APP = '__TURNMD_APP__';
export const MD_APIKEY = '__TURNMD_APIKEY__';

export const MD_CACHE_MAX_MS = 6 * 60 * 60 * 1000;  // reutilizar 6 h
export const MD_FETCH_TIMEOUT_MS = 4000;            // la llamada no espera más

let _cache = null; // { servers, ts } — solo en memoria, por sesión

// Una credencial es "real" si no está vacía ni es el placeholder del
// código fuente (build sin TURNMD_INJECT, o tests corriendo sobre src/).
function esCredencialReal(v) {
  return typeof v === 'string' && v.trim() !== '' && !v.startsWith('__TURNMD');
}

// ¿Está la función configurada? (credenciales inyectadas en el build)
export function mdConfigurado(app = MD_APP, apiKey = MD_APIKEY) {
  return esCredencialReal(app) && esCredencialReal(apiKey);
}

// Solo para tests: olvida la caché en memoria.
export function _resetMdCache() { _cache = null; }

// Pide a la API de Metered las credenciales TURN de la cuenta y
// devuelve su array `iceServers` listo para RTCPeerConnection (la
// respuesta de la API ES directamente el array). Con caché en
// memoria: se reutiliza si tiene menos de MD_CACHE_MAX_MS, salvo
// { force: true }. Sin credenciales, sin red o con cualquier error
// devuelve null — NUNCA lanza: el llamante cae siempre a la
// configuración de respaldo.
export async function getMeteredIceServers({ force = false, fetchFn, nowFn, app, apiKey } = {}) {
  const a = app !== undefined ? app : MD_APP;
  const k = apiKey !== undefined ? apiKey : MD_APIKEY;
  if (!mdConfigurado(a, k)) return null;
  const ahora = typeof nowFn === 'function' ? nowFn : Date.now;
  if (!force && _cache && ahora() - _cache.ts < MD_CACHE_MAX_MS) return _cache.servers;
  const doFetch = fetchFn !== undefined ? fetchFn
    : (typeof fetch === 'function' ? fetch : null);
  if (typeof doFetch !== 'function') return null;
  let timer = null;
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) {
      timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, MD_FETCH_TIMEOUT_MS);
    }
    const res = await doFetch(
      'https://' + a + '.metered.live/api/v1/turn/credentials?apiKey=' + encodeURIComponent(k),
      {
        method: 'GET',
        ...(ctrl ? { signal: ctrl.signal } : {}),
      }
    );
    if (!res || res.ok !== true) return null;
    const data = await res.json();
    const servers = Array.isArray(data)
      ? data.filter((e) => e && typeof e === 'object' && e.urls != null)
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
