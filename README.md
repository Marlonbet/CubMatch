# CubMatch 💘🇨🇺

App de citas para cubanos dentro de la isla. **Sin servidor, sin costo, sin VPN.**

- **Código y distribución:** repo público en GitHub. La app es **un solo archivo HTML** (`dist/cubmatch.html`): se abre con `file://`, se comparte por WhatsApp/Bluetooth y funciona en el teléfono.
- **Red:** [Nostr](https://nostr.com). Perfiles, likes y chats viajan por relays públicos — verificado que conectan desde Cuba sin VPN (2026-10-19).
- **Cuentas:** usuario + contraseña. La contraseña deriva tu clave Nostr con scrypt **en tu dispositivo**; nadie la guarda, no hay que copiar claves largas.

## Cómo usarla desde Cuba

1. **Descarga** `dist/cubmatch.html` (o pídela por WhatsApp a quien ya la tenga).
   - Vía proxy de GitHub (funciona sin VPN): `https://gh-proxy.com/https://github.com/Marlonbet/CubMatch/raw/main/dist/cubmatch.html` → guárdala y ábrela.
2. **Ábrela** en el navegador del teléfono (Chrome/Safari). Funciona con `file://`, no necesita internet para abrir.
3. **Crea tu cuenta** (usuario + contraseña, mín. 8 caracteres). El nombre se reclama en la red: el primero que lo usa se lo queda.
4. **Completa tu perfil** (8 pasos). Necesitas **≥70% de completitud** para entrar al matching automático.
5. **Descubre**: el deck te muestra perfiles ordenados por compatibilidad, más "Tus 10 mejores de hoy".
6. **Match mutuo** (ambos ♥) → se abre el **chat cifrado**.

## Cómo se actualiza (sin re-descargar)

La app trae un **loader**: arranca al instante la versión incluida y en segundo plano revisa si hay una más nueva en el repo (vía proxies `gh-proxy.com`). Si la hay y estás en la pantalla de inicio, cambia sola a la nueva versión. El registro de intentos vive en `window.__cubmatchUpdateLog` (consola del navegador).

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

**Seguridad que sí tienes:** tus chats van cifrados de extremo a extremo (solo tú y tu match pueden leerlos); tu contraseña nunca sale del teléfono; puedes ocultar tu perfil cuando quieras (se publica un perfil marcado `oculto` y los demás clientes lo filtran).

**Riesgos que debes conocer:** los perfiles son públicos en los relays (cualquiera puede leerlos: no pongas datos que te identifiquen de más); no hay verificación de identidad — un match no prueba quién es la otra persona; si olvidas tu contraseña, **pierdes tu cuenta** (nadie la guarda). Lee `PLAN.md` para el detalle.

## Para desarrolladores

```
src/
  app.js       # UI (entry point del bundle)
  index.html   # esqueleto + placeholders del build
  styles.css   # tema cálido cubano, mobile-first
  boot.js      # loader con auto-actualización
  cuentas.js   # usuario+contraseña → clave Nostr (scrypt)
  red.js       # transporte Nostr (WebSocket, DMs NIP-04)
  cubmatch.js  # perfiles kind 30079, likes kind 7, reportes 1984
  perfil.js    # esquema, opciones cubanas, completitud, avatar SVG
  matching.js  # motor de matching puro (fórmula del plan)
test/          # node:test + jsdom (+ mock relay en e2e)
app/live/      # cubmatch-live.js + version.js (auto-update remoto)
dist/          # cubmatch.html (el archivo que se comparte)
```

```bash
npm install
npm test        # node --test "test/*.test.mjs"
npm run build   # genera app/live/* y dist/cubmatch.html
```

Versión: 1.0.0 (MVP).
