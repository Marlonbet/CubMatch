# Arquitectura de relays (v1.1)

CubMatch no tiene servidor: los relays Nostr **son** la base de datos.
Esta versión organiza los 4 relays por roles y reduce el tráfico en datos
móviles (caché-primero + `since`).

## Los 4 relays y sus roles

| Rol | Relays | Qué viaja por ahí |
|---|---|---|
| `discovery` | `wss://relay.damus.io`, `wss://nos.lol` | perfiles (30079), likes (kind 7), reclamos de nombre (30078), listas 10002/10050 |
| `messaging` | `wss://relay.primal.net`, `wss://relay.nostr.band` | DMs (kind 4, inbox NIP-17), receipts (24503), typing/presencia + respaldo de lo crítico |

Reglas de tráfico:

- **Publicaciones infrecuentes** (perfil, claim de nombre, 10002, 10050,
  likes, reportes): a los **4 relays** de una vez, firmadas una sola vez
  (el mismo evento viaja por ambos clientes, sin ids duplicados).
- **Descubrimiento**: consulta `discovery`; si discovery está degradado y no
  hubo resultados, cae a `messaging`.
- **Chat**: vive en `messaging`.

## kind 10002 (NIP-65) y kind 10050 (NIP-17)

Al crear cuenta y al publicar el perfil, la app publica también:

- **10002**: mi lista de relays (tags `["r", <url>]` de los 4). Dice dónde
  encontrar mis cosas.
- **10050**: mi *inbox* de DMs (tags `["r", <url>]` = los relays de
  `messaging`). Dice dónde **recibo** mensajes privados.

Al **enviar** un DM, la app busca el 10050 del destinatario (cacheado en
`localStorage` con TTL de 24 h) y publica el DM solo en la intersección
(inbox del otro ∩ mi `messaging`). Si el otro no tiene 10050 (versión vieja
de CubMatch) o no hay intersección, se usa todo `messaging` como fallback.
Al **recibir**, la suscripción de DMs escucha en `messaging` (mi inbox).

Mejora futura (no implementada): leer el 10002 de otros usuarios para
descubrir relays extra donde buscar sus eventos.

## Caché-primero + sync incremental (ahorro de datos)

- `cubmatch_lastSync_descubrimiento` y `cubmatch_lastSync_chat` guardan la
  última sincronización (segundos).
- Los fetches piden a los relays solo lo nuevo (`since: lastSync`) y lo
  fusionan con la caché de `localStorage`: dedup por id de evento, y en el
  reemplazable 30079 gana el `created_at` más nuevo.
- La UI muestra la caché al instante y sincroniza en segundo plano; el
  botón "Re-descubrir" / "Actualizar" borra la caché y descarga todo
  (fuerza actualización).
- Los fetches de chat usan un solape de 60 s y los de descubrimiento de
  120 s: lo que nazca durante un fetch se re-trae la próxima vez (el dedup
  lo absorbe).

## Conexiones lazy

La app **no** conecta los 4 relays al arrancar. `RelayPool` (en `src/red.js`)
mantiene un cliente por scope (`discovery` | `messaging`); cada pantalla
adquiere su scope al entrar (`acquire`) y lo libera al salir (`release`),
con refcount y ~10 s de gracia para no reconectar al navegar rápido:

- Deck / Top 10 / Matches → `discovery`
- Chat → `messaging`
- Ajustes → ambos
- Inicio / cuenta / onboarding → ninguno (el boot no conecta nada)

## Nota: relay propio

Un relay propio (p. ej. **strfry**) queda para cuando haya VPS: hoy no es
posible (sin pago internacional). Con los 4 relays públicos y la
publicación redundante, ningún relay individual es punto único de fallo.
