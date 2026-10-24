# PLAN.md — CubMatch: del plan original al MVP GitHub+Nostr

Este documento mapea el plan original de la app (7 secciones) a lo que el MVP
implementa con **GitHub + Nostr, cero servidores**, y declara con honestidad
lo que **no** se puede hacer sin servidor central.

## 1. Visión general → qué cambia sin servidor

| Plan original | MVP GitHub+Nostr |
|---|---|
| Matching por compatibilidad estadística + preferencias | ✅ Igual: la fórmula corre 100% en el cliente (`src/matching.js`) |
| Optimizado para internet intermitente | ✅ Mejor aún: sin servidor que caiga; los relays Nostr son redundantes |
| Moderación fuerte y verificación de identidad | ⚠️ **Degradado** (ver §7): sin servidor no hay moderación central ni verificación de identidad real |
| Flujo Registro → Perfil → Matching → Chat → Encuentro | ✅ Igual, con registro = usuario+contraseña (sin SMS) |

## 2. Perfiles → implementado casi completo

- ✅ Todos los campos del plan (identidad, físico, educación/ocupación, estilo de vida, valores, rasgos 1-5, preferencias, intereses + tags libres, bio 600 con contador, 3 prompts Hinge, "3 palabras", visibilidad de edad).
- ✅ Score de completitud 0-100%; **≥70% requerido** para matching (`entraEnMatching`). Dentro del motor, el gate de completitud (`src/matching.js`) oculta perfiles por debajo de 40% (25% con pool pequeño; 0% en el modo mínimo, ver §3).
- ⚠️ **Fotos**: sin subida (no hay servidor). MVP: avatar SVG determinista generado + campo opcional `fotoURL`. (v1.1: subida a servicios compatibles o Blossom.)
- ❌ **Verificación de teléfono (+53)**: imposible sin proveedor SMS. Sustituto honesto: reclamo de nombre en relays + firma criptográfica de cada evento (cada perfil está firmado por su clave: no se puede falsificar, aunque no prueba quién eres). El reclamo **no es una garantía de exclusividad**: la fecha del evento la elige quien lo publica, así que el login acepta a cualquier dueño legítimo del nombre (`verifyCredentials`) y el orden solo decide quién "ocupa" el nombre al registrarse.
- ❌ **Detección de duplicados** por face embedding / device fingerprint: sin servidor no hay cómputo central. Mitigación: costo de crear cuentas (scrypt + publicar) y bloqueos/reportes locales.

## 3. Matching → implementado en cliente (motor v2.1)

Modelo v2: pocos filtros duros y muchos factores **blandos** (para pools pequeños, donde excluir deja a la gente sin candidatos):

```
score = gate · (0.35·afinidad + 0.25·ajuste_mutuo + 0.15·geo
                + 0.10·actividad + 0.15·interés) + jitter(±0.05)
```

- ✅ **Filtros duros** (`hardPass`), solo incompatibilidades reales: no soy yo, no bloqueado, ambos ≥18, género mutuo y tipo de relación en común. Edad exacta, distancia, completitud y "ya visto" **no** excluyen: pesan en el score.
- ✅ **Gate de completitud**: `min(la mía, la suya)`; por debajo de 0.40 → no aparece; por encima, `0.5 + 0.5·c`.
- ✅ **Afinidad**: solo compara los campos que **ambos** llenaron (el vacío es neutro y los pesos se renormalizan): texto libre (valores, intereses, tags) con TF-IDF coseno, idf suavizado, acentos normalizados y **stemming ligero** ("bailar" ≈ "baile"); hábitos, hijos, religión, mascotas y rasgos de personalidad.
- ✅ **Ajuste mutuo**: media geométrica de cuánto encaja cada uno en la edad y distancia que busca el otro (edad decae a 0 en 5 años fuera de rango).
- ✅ **Geo**: mismo municipio 1.0 / misma provincia 0.7 / provincia vecina 0.5 / resto 0.3. *Pendiente: la preferencia explícita `prefs.distancia` ("solo mi provincia"…) hoy no se aplica; solo pesa este factor.*
- ✅ **Actividad**: decaimiento exponencial desde el `created_at` del perfil (= su **última edición**). Si el llamador pasa `ctx.ultimaActividad {pubkey: ts}` (presencia, último like/DM) se usa lo más reciente de ambos. *Pendiente: conectar esa fuente desde `app.js`.*
- ✅ **Interés** (clave `rec`): 1.0 si te dio like, 0.3 si tú le diste like y, para el resto del mazo, la **preferencia aprendida de tus propios swipes**, 100 % local: cada ♥ suma y cada ✕ resta (con menos peso) a los rasgos del perfil, con semivida de 90 días; entra con ≥5 swipes y pesa por completo desde 25. *(En v2.0 un dislike enviado contaba 0.3 por error y, además, este factor valía 0 para todo el mazo.)*
- ✅ **Quien ya te dio like** no compite en el mazo: va a "Le gustas". Los dislikes reaparecen a los 21 días; los likes enviados, nunca.
- ✅ **Pool pequeño**, en tres niveles (`rankCandidates(...).nivel`): 1 normal (≥30 candidatos); 2 relajado (suelo 0.25, tolerancia de edad 10); 3 mínimo (<15 incluso relajado: suelo 0, tolerancia 15 y el tipo de relación solo penaliza ×0.6). Los niveles 2 y 3 se muestran como «Explorar».
- ✅ **Jitter** determinista por día y par de pubkeys: mismo orden todo el día, distinto mañana.
- ✅ **"Tus 10 mejores de hoy"**: batch en cliente sobre perfiles cacheados + re-ranking al abrir el deck.
- ⏳ Bayesian / collaborative filtering entre usuarios / LambdaMART / bandits: **v1.2+** (requieren historial agregado; la parte individual —aprender de tus propios likes— ya está).

## 4. Arquitectura → GitHub + Nostr (sin servidor)

```
┌─────────────┐   eventos firmados   ┌──────────────────────┐
│ cubmatch.html│ ◄──────────────────► │ Relays Nostr         │
│ (tu teléfono)│   kind 30079 perfil  │ (lista en src/red.js)│
│ 100% cliente │   kind 7 likes       │                      │
└─────────────┘   kind 4 DMs (NIP-04)│                      │
       ▲          kind 1984 reportes  └──────────────────────┘
       │ actualiza vía                        ▲
┌──────┴──────┐   gh-proxy.com         sin cuentas,
│ GitHub      │   (solo lectura,       sin costo,
│ Marlonbet/  │    versión FIRMADA)    sin VPN en Cuba
│ CubMatch    │
└─────────────┘
```

- **Frontend**: un solo HTML (vanilla JS + CSS), mobile-first, modo datos bajos (límite de perfiles descargados configurable).
- **"Backend"**: los relays Nostr (redundancia gratis). Sin PostgreSQL/Redis/S3: el estado vive en eventos + localStorage.
- **Esquema Nostr**: perfil `kind 30079` (`d=cubmatch-v1`, `#t=cubmatch`); likes NIP-25 `kind 7`; chat `kind 4` NIP-04; reportes NIP-56 `kind 1984`; reclamo de cuenta `kind 30078` (`d=cubmatch:perfil:<usuario>`).
- **Auto-actualización firmada**: los proxies de GitHub son terceros no confiables, así que el loader (`src/boot.js`) solo ejecuta una versión descargada si su firma ECDSA P-256 verifica con la clave pública incrustada (ver README, "Publicar una versión"). La firma cubre la versión y los bytes exactos del bundle; falla cerrado. *Límite: la primera descarga de `dist/cubmatch.html` y las instalaciones anteriores a este mecanismo no se pueden autenticar retroactivamente.*

## 5. Funcionalidades → estado MVP

- ✅ Swipe (✕/♥) + super-like limitado (1/día) | ❌ Boost (requiere economía/servidor; v2)
- ✅ "Tus 10 mejores de hoy" | ✅ Chat texto 1:1 cifrado | ❌ Notas de voz (v1.1)
- ✅ Reportes + bloqueos locales | ❌ Moderación IA central (imposible; ver §7)
- ✅ Filtros avanzados: **gratis para todos** (sin servidor no hay paywall que valga)
- ⏳ Eventos locales: v2 (se pueden anunciar como eventos Nostr `kind 31923`)

## 6. Roadmap

- **MVP (esta versión)**: cuenta, perfil por pasos, matching con fórmula, deck, top-10, matches, chat cifrado, reportes/bloqueos, auto-actualización firmada vía GitHub.
- **Seguridad/privacidad (siguiente)**: likes y dislikes privados (dislikes solo locales o cifrados a uno mismo; likes con gift wrap NIP-59), chats con NIP-17/NIP-44 en vez de NIP-04, derivación de clave v2 con scrypt más caro y contraseñas nuevas más largas (ya en `src/cuentas.js`, falta conectarlo en `app.js`), prueba de trabajo (NIP-13) en perfiles contra spam, lista de relays configurable.
- **v1.1**: notas de voz en chat (cifradas, como adjuntos), subida de fotos vía Blossom/servidor compatible, verificación social (vouches: perfiles que se avalan entre sí con kind 7 sobre el perfil), mejor reintento offline.
- **v1.2**: collaborative filtering entre usuarios, learning-to-rank en cliente, matriz de distancias entre municipios, modo "datos ultra-bajos" (solo texto).
- **v2**: eventos/encuentros grupales (NIP-53 calendar events), reputación comunitaria (web-of-trust con los reportes NIP-56), relay comunitario cubano si aparece infraestructura.

## 7. Las 3 limitaciones más importantes (honestidad primero)

1. **Sin verificación de identidad.** No hay SMS (+53), ni revisión de documentos, ni moderador que banee. Cada perfil está *firmado* (no falsificable), pero nada prueba que la persona sea quien dice. **Regla de oro: verifica a tu match por videollamada u otro canal antes de un encuentro, y los primeros encuentros en lugares públicos.**
2. **Sin moderación central.** Los reportes (NIP-56) quedan registrados en la red para que futuros clientes construyan reputación, y los bloqueos locales te protegen a ti — pero nadie puede borrar el perfil de un acosador de los relays ajenos. La defensa es individual + reputación futura (v2).
3. **Descubrimiento limitado a los relays.** Solo ves los perfiles que los relays te devuelven: si un relay filtra, cae o limita historial, verás menos gente. Mitigación: varios relays redundantes + re-descubrimiento manual. Y todo perfil es público por diseño: **no publiques datos sensibles** (dirección exacta, documentos, rutinas).

## Notas legales/privacidad

- El **contenido** de los chats está cifrado (NIP-04): los relays no pueden leerlo, pero sí ven quién escribe a quién y cuándo.
- Los perfiles son **públicos**: cualquiera con acceso a un relay puede descargarlos, incluidas tus preferencias de género y tipo de relación.
- Tus likes y dislikes son eventos **públicos** (kind 7): cualquiera puede ver a quién se los diste.
- La contraseña nunca sale del dispositivo, pero tu clave se deriva de ella y tu clave pública es pública: usa una frase larga para dificultar que la prueben sin conexión. Si la olvidas, la cuenta se pierde (nadie la guarda).
- Revisar regulaciones locales sobre apps de citas y tratamiento de datos antes de promoverla masivamente.
