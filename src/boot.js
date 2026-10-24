// CUBMATCH loader: arranca la versión incluida al instante (offline-first)
// y en segundo plano busca una versión más nueva vía proxies de GitHub.
//
// SEGURIDAD: los proxies son terceros y NO son de fiar. Antes de ejecutar
// una sola línea descargada se verifica una firma ECDSA P-256/SHA-256
// (WebCrypto) hecha con la clave de publicación del proyecto, cuya parte
// pública va incrustada aquí (UPDATE_PUBKEY). El mensaje firmado es
// "<versión>\n" + <bytes exactos del bundle>, así que un proxy no puede
// alterar el código ni reutilizar una firma con otra versión.
// FALLA CERRADO: sin clave pública, sin WebCrypto o con firma inválida
// no se ejecuta nada descargado y la app sigue con la versión incluida.
// Diagnóstico: window.__cubmatchUpdateLog (ver en consola).
(function () {
  var BUNDLED_VERSION = '__BUNDLED_VERSION__';
  // JWK público (JSON) de la clave de firma; '' = auto-actualización desactivada.
  var UPDATE_PUBKEY = '__UPDATE_PUBKEY__';
  var PROXIES = [
    'https://gh-proxy.com/',
    'https://ghproxy.com/',
    'https://hub.gitmirror.com/',
  ];
  var LIVE_BASE = 'https://raw.githubusercontent.com/Marlonbet/CubMatch/main/app/live/';
  var log = (window.__cubmatchUpdateLog = []);

  function note(msg) {
    try { log.push(new Date().toISOString().slice(11, 19) + ' ' + msg); } catch (e) {}
  }

  function cmp(a, b) {
    var pa = String(a).split('.').map(Number);
    var pb = String(b).split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      var d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  // kind: 'text' | 'buf'. El bundle se baja como bytes para verificar la
  // firma sobre los bytes EXACTOS (sin que una decodificación los cambie).
  function fetchAs(url, timeoutMs, kind) {
    return new Promise(function (resolve, reject) {
      if (typeof fetch === 'undefined') { reject(new Error('sin fetch')); return; }
      var ctrl;
      try { ctrl = new AbortController(); } catch (e) { reject(e); return; }
      var timer = setTimeout(function () {
        try { ctrl.abort(); } catch (e) {}
        reject(new Error('timeout'));
      }, timeoutMs);
      fetch(url, { signal: ctrl.signal }).then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return kind === 'buf' ? res.arrayBuffer() : res.text();
      }).then(function (t) { clearTimeout(timer); resolve(t); })
        .catch(function (e) { clearTimeout(timer); reject(e); });
    });
  }
  function fetchText(url, timeoutMs) { return fetchAs(url, timeoutMs, 'text'); }
  function fetchBuf(url, timeoutMs) { return fetchAs(url, timeoutMs, 'buf'); }

  function validVersionText(t) {
    var m = /^\s*window\.__CUBMATCH_REMOTE_VERSION\s*=\s*"(\d+\.\d+\.\d+)"\s*;\s*$/.exec(t || '');
    return m ? m[1] : null;
  }

  function validLiveText(t) {
    return typeof t === 'string' && t.length > 50000 &&
      t.indexOf('__cubmatchApp') !== -1 &&
      t.charAt(0) !== '<' && t.indexOf('<!DOCTYPE') === -1 && t.indexOf('<html') === -1;
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Devuelve la versión firmada si la firma es válida; null si no.
  // sigText = contenido de cubmatch-live.sig.json: {"v":"x.y.z","sig":"<base64 r||s>"}.
  async function verifyLive(buf, sigText) {
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle || !UPDATE_PUBKEY) return null;
    var meta = JSON.parse(sigText);
    if (!meta || typeof meta.sig !== 'string' || !/^\d+\.\d+\.\d+$/.test(String(meta.v))) return null;
    var key = await subtle.importKey(
      'jwk', JSON.parse(UPDATE_PUBKEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );
    var head = new TextEncoder().encode(meta.v + '\n');
    var body = new Uint8Array(buf);
    var msg = new Uint8Array(head.length + body.length);
    msg.set(head, 0);
    msg.set(body, head.length);
    var ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64ToBytes(meta.sig), msg);
    return ok ? meta.v : null;
  }

  function runInline(code) {
    var s = document.createElement('script');
    s.textContent = code;
    document.head.appendChild(s);
    s.parentNode.removeChild(s);
  }

  function start() {
    var fallback = window.__cubmatchApp;
    if (!fallback || !fallback.boot) { note('sin app incluida'); return; }
    fallback.boot();

    // Chequeo de actualización en segundo plano: nunca bloquea la UI y
    // solo toma el control en la pantalla de inicio (no interrumpe un chat).
    (async function () {
      if (!UPDATE_PUBKEY) { note('actualización desactivada: este build no trae clave de firma'); return; }
      if (!(window.crypto && window.crypto.subtle)) { note('actualización desactivada: sin WebCrypto'); return; }
      var bust = 'v=' + Date.now();
      for (var i = 0; i < PROXIES.length; i++) {
        var base = PROXIES[i] + LIVE_BASE;
        try {
          note('probando ' + PROXIES[i]);
          // version.js NO está firmado: solo sirve de chequeo barato. La
          // decisión real se toma con la versión que trae la firma.
          var remote = validVersionText(await fetchText(base + 'version.js?' + bust, 7000));
          if (!remote) { note('version.js inválido, siguiente proxy'); continue; }
          note('remoto=' + remote + ' local=' + BUNDLED_VERSION);
          if (cmp(remote, BUNDLED_VERSION) <= 0) { note('al día'); return; }
          var liveBuf = await fetchBuf(base + 'cubmatch-live.js?' + bust, 30000);
          var sigText = await fetchText(base + 'cubmatch-live.sig.json?' + bust, 7000);
          var signed = await verifyLive(liveBuf, sigText);
          if (!signed) { note('firma inválida o ausente, siguiente proxy'); continue; }
          if (cmp(signed, BUNDLED_VERSION) <= 0) { note('versión firmada no es más nueva, siguiente proxy'); continue; }
          var liveText = new TextDecoder('utf-8').decode(liveBuf);
          if (!validLiveText(liveText)) { note('live inválido, siguiente proxy'); continue; }
          runInline(liveText);
          var live = window.__cubmatchApp;
          var inicio = document.getElementById('pantalla-inicio');
          if (live && live !== fallback && live.version === signed && live.boot && inicio && !inicio.hidden) {
            note('takeover a ' + signed);
            fallback.dispose();
            live.boot();
          } else {
            note('live cargado pero no tomó el control');
          }
          return;
        } catch (e) { note('falló: ' + (e && e.message)); }
      }
      note('sin actualización');
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
