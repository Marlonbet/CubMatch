# CubMatch 💘🇨🇺

App de citas para cubanos dentro de la isla. **Sin servidor, sin costo, sin VPN.**

- **Código y distribución:** repo público en GitHub. La app es **un solo archivo HTML** (`dist/cubmatch.html`): se abre con `file://`, se comparte por WhatsApp/Bluetooth y funciona en el teléfono.
- **Red:** [Nostr](https://nostr.com). Perfiles, likes y chats viajan por relays públicos — verificado que conectan desde Cuba sin VPN (2026-10-19).
- **Cuentas:** usuario + contraseña. La contraseña deriva tu clave Nostr con scrypt **en tu dispositivo**; nadie la guarda, no hay que copiar claves largas.

## Cómo usarla desde Cuba

1. **Descarga** `dist/cubmatch.html` (o pídela por WhatsApp a quien ya la tenga).
   - Vía proxy de GitHub (funciona sin VPN): `https://gh-proxy.com/https://github.com/Marlonbet/CubMatch/raw/main/dist/cubmatch.html` → guárdala y ábrela.
   - ⚠️ Esa **primera descarga** pasa por un proxy de terceros y no se puede verificar. Si puedes, pídesela a alguien de confianza que ya la tenga. Las actualizaciones posteriores sí van firmadas (ver abajo).
2. **Ábrela** en el navegador del teléfono (Chrome/Safari). Funciona con `file://`, no necesita internet para abrir.
3. **Crea tu cuenta** (usuario + contraseña). El nombre se reclama en la red.
4. **Completa tu perfil** (8 pasos). Necesitas **≥70% de completitud** para entrar al matching automático.
5. **Descubre**: el deck te muestra perfiles ordenados por compatibilidad (y, con el uso, aprende de tus ♥ y ✕ — solo en tu teléfono), más "Tus 10 mejores de hoy".
6. **Match mutuo** (ambos ♥) → se abre el **chat cifrado**.

## Cómo se actualiza (sin re-descargar)

La app trae un **loader**: arranca al instante la versión incluida y en segundo plano revisa si hay una más nueva en el repo (vía proxies `gh-proxy.com`, que son de terceros). **Antes de ejecutar nada descargado, verifica una firma digital** (ECDSA P-256) hecha con la clave de publicación del proyecto, cuya parte pública va incrustada en el loader. Si la firma no verifica, el navegador no soporta WebCrypto o el build no trae clave, **no se ejecuta nada** y la app sigue con la versión incluida. El registro de intentos vive en `window.__cubmatchUpdateLog` (consola del navegador).

## Qué hace y qué no (honesto)

| Sí hace (MVP) | No hace (MVP) |
|---|---|
| Registro/login sin servidor (scrypt) | ❌ Verificación por SMS (+53): imposible sin proveedor de SMS |
| Perfiles con 40+ campos + % de completitud | ❌ Subida de fotos: no hay servidor; usa avatar generado o URL |
| Matching con fórmula estadística en tu teléfono | ❌ Moderación central: no hay servidor que modere |
| Likes, dislikes, super-like (1/día), match mutuo | ❌ Búsqueda garantizada: solo ves lo que devuelvan los relays |
| Chat 1:1 cifrado (NIP-04) tras match mutuo | ❌ Notas de voz (quedan para v1.1) |
| Reportes NIP-56 + bloqueos locales | ❌ Verificación de identidad con documento |
| Funciona con internet intermitente | |

**Seguridad que sí tienes:** el contenido de tus chats va cifrado (solo tú y tu match pueden leerlo); tu contraseña nunca sale del teléfono; puedes ocultar tu perfil cuando quieras (se publica un perfil marcado `oculto` y los demás clientes lo filtran).

**Riesgos que debes conocer:**

- **Los perfiles son públicos** en los relays (cualquiera puede leerlos), incluidas tus preferencias de género y tipo de relación. No pongas datos que te identifiquen de más.
- **Tus ♥ y ✕ también son públicos**: son eventos de la red firmados con tu clave y etiquetados con el perfil al que van, así que cualquiera que consulte un relay puede ver a quién le diste like o dislike.
- **Los chats ocultan el contenido, no quién habla con quién ni cuándo**: los mensajes usan NIP-04, que deja visibles emisor, receptor y hora.
- **Tu clave sale de tu contraseña**, y el nombre de usuario y tu clave pública son públicos: alguien puede probar contraseñas contra tu perfil sin conexión. Usa una **frase larga** (4 palabras o más, ≥12 caracteres); si te la adivinan, pueden leer tus chats y hacerse pasar por ti.
- No hay verificación de identidad: un match no prueba quién es la otra persona.
- Si olvidas tu contraseña, **pierdes tu cuenta** (nadie la guarda).

Lee `PLAN.md` para el detalle.

## Para desarrolladores

```
src/
  app.js       # UI (entry point del bundle)
  index.html   # esqueleto + placeholders del build
  styles.css   # tema cálido cubano, mobile-first
  boot.js      # loader con auto-actualización FIRMADA
  cuentas.js   # usuario+contraseña → clave Nostr (scrypt), reclamos de nombre
  red.js       # transporte Nostr (WebSocket, DMs NIP-04)
  cubmatch.js  # perfiles kind 30079, likes kind 7, reportes 1984
  perfil.js    # esquema, opciones cubanas, completitud, avatar SVG
  matching.js  # motor de matching puro (v2.1)
  llamadas.js  # llamadas WebRTC (TURN: turncf.js / turnmd.js)
  …            # más módulos de chat, presencia, foto y UI: ver src/
tools/
  firma.mjs           # firma/verificación ECDSA P-256 de las versiones vivas
  gen-update-key.mjs  # genera el par de claves de firma (una sola vez)
test/          # node:test + jsdom (+ mock relay en e2e)
app/live/      # cubmatch-live.js + version.js + cubmatch-live.sig.json (auto-update remoto)
dist/          # cubmatch.html (el archivo que se comparte)
```

```bash
npm install
npm test        # node --test "test/*.test.mjs"
npm run build   # genera app/live/* y dist/cubmatch.html
```

### Publicar una versión (firmada)

```bash
# Una sola vez: genera update-key.private.pem (SECRETA, no se sube) y update-key.pub.json (pública, sí se sube)
node tools/gen-update-key.mjs

# En cada release: sube la versión en package.json y compila firmando
UPDATE_SIGNING_KEY=update-key.private.pem npm run build
git add app/live dist update-key.pub.json && git commit && git push
```

Sin `UPDATE_SIGNING_KEY` el build funciona pero no genera `cubmatch-live.sig.json`, y los clientes con verificación **no aceptarán** esa versión viva. Guarda `update-key.private.pem` fuera del repo (gestor de contraseñas/USB): si la pierdes hay que repartir un `dist/cubmatch.html` nuevo con otra clave. Si el build no encuentra `update-key.pub.json`, sale con la auto-actualización **desactivada**.

Versión: ver `package.json`.
