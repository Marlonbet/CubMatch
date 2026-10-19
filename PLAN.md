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
- ✅ Score de completitud 0-100%; **≥70% requerido** para matching (`entraEnMatching`).
- ⚠️ **Fotos**: sin subida (no hay servidor). MVP: avatar SVG determinista generado + campo opcional `fotoURL`. (v1.1: subida a servicios compatibles o Blossom.)
- ❌ **Verificación de teléfono (+53)**: imposible sin proveedor SMS. Sustituto honesto: reclamo de nombre único en relays (el primero se lo queda) + firma criptográfica de cada evento (cada perfil está firmado por su clave: no se puede falsificar, aunque no prueba quién eres).
- ❌ **Detección de duplicados** por face embedding / device fingerprint: sin servidor no hay cómputo central. Mitigación: costo de crear cuentas (scrypt + publicar) y bloqueos/reportes locales.

## 3. Matching → implementado en cliente

La fórmula del plan, textual:

```
Score(u,v) = w1·cos(pu,pv) + w2·cos(pu,prefv) + w3·cos(pv,prefu)
           + w4·geo + w5·actividad + w6·reciprocidad
```

- ✅ **Filtros duros** (`hardPass`): edad mutua, género mutuo, distancia mutua (misma/vecinas/toda Cuba), tipo de relación con overlap, bloqueos, ya-vistos, completitud ≥70, no uno mismo.
- ✅ **Vectores**: categóricas → one-hot; numéricas → normalizadas; intereses/valores/tags → TF-IDF sobre el corpus local descargado; preferencias → `desiredVector` en el mismo espacio.
- ✅ **Pesos** por defecto `w=[0.3, 0.2, 0.2, 0.15, 0.05, 0.1]`, configurables por parámetro.
- ✅ **Geo**: mismo municipio 1.0 / misma provincia 0.7 / resto 0.3. *Mejora futura documentada: matriz de distancias reales entre municipios.*
- ✅ **Actividad**: decaimiento exponencial desde `created_at` del perfil.
- ✅ **Reciprocidad**: +1.0 si te dio like, +0.3 si hay interacción previa.
- ✅ **"Tus 10 mejores de hoy"**: batch en cliente sobre perfiles cacheados + re-ranking al abrir el deck.
- ⏳ Bayesian / collaborative filtering / LambdaMART / bandits: **v1.2+** (requieren historial agregado; en cliente se puede hacer collaborative filtering local cuando haya suficientes likes propios).

## 4. Arquitectura → GitHub + Nostr (sin servidor)

```
┌─────────────┐   eventos firmados   ┌──────────────────────┐
│ cubmatch.html│ ◄──────────────────► │ Relays Nostr (5)     │
│ (tu teléfono)│   kind 30079 perfil  │ damus, nos.lol,      │
│ 100% cliente │   kind 7 likes       │ nostr.band, primal,  │
└─────────────┘   kind 4 DMs (NIP-04)│ wellorder            │
       ▲          kind 1984 reportes  └──────────────────────┘
       │ actualiza vía                        ▲
┌──────┴──────┐   gh-proxy.com         sin cuentas,
│ GitHub      │   (solo lectura)       sin costo,
│ Marlonbet/  │                        sin VPN en Cuba
│ CubMatch    │
└─────────────┘
```

- **Frontend**: un solo HTML (vanilla JS + CSS), mobile-first, modo datos bajos (límite de perfiles descargados configurable).
- **"Backend"**: los relays Nostr (redundancia gratis). Sin PostgreSQL/Redis/S3: el estado vive en eventos + localStorage.
- **Esquema Nostr**: perfil `kind 30079` (`d=cubmatch-v1`, `#t=cubmatch`); likes NIP-25 `kind 7`; chat `kind 4` NIP-04; reportes NIP-56 `kind 1984`; reclamo de cuenta `kind 30078` (`d=cubmatch:perfil:<usuario>`).

## 5. Funcionalidades → estado MVP

- ✅ Swipe (✕/♥) + super-like limitado (1/día) | ❌ Boost (requiere economía/servidor; v2)
- ✅ "Tus 10 mejores de hoy" | ✅ Chat texto 1:1 cifrado | ❌ Notas de voz (v1.1)
- ✅ Reportes + bloqueos locales | ❌ Moderación IA central (imposible; ver §7)
- ✅ Filtros avanzados: **gratis para todos** (sin servidor no hay paywall que valga)
- ⏳ Eventos locales: v2 (se pueden anunciar como eventos Nostr `kind 31923`)

## 6. Roadmap

- **MVP (esta versión)**: cuenta, perfil por pasos, matching con fórmula, deck, top-10, matches, chat cifrado, reportes/bloqueos, auto-actualización vía GitHub.
- **v1.1**: notas de voz en chat (cifradas, como adjuntos), subida de fotos vía Blossom/servidor compatible, verificación social (vouches: perfiles que se avalan entre sí con kind 7 sobre el perfil), mejor reintento offline.
- **v1.2**: collaborative filtering local (likes propios → "gente como tú"), learning-to-rank simple en cliente, matriz de distancias entre municipios, modo "datos ultra-bajos" (solo texto).
- **v2**: eventos/encuentros grupales (NIP-53 calendar events), reputación comunitaria (web-of-trust con los reportes NIP-56), relay comunitario cubano si aparece infraestructura.

## 7. Las 3 limitaciones más importantes (honestidad primero)

1. **Sin verificación de identidad.** No hay SMS (+53), ni revisión de documentos, ni moderador que banee. Cada perfil está *firmado* (no falsificable), pero nada prueba que la persona sea quien dice. **Regla de oro: verifica a tu match por videollamada u otro canal antes de un encuentro, y los primeros encuentros en lugares públicos.**
2. **Sin moderación central.** Los reportes (NIP-56) quedan registrados en la red para que futuros clientes construyan reputación, y los bloqueos locales te protegen a ti — pero nadie puede borrar el perfil de un acosador de los relays ajenos. La defensa es individual + reputación futura (v2).
3. **Descubrimiento limitado a los relays.** Solo ves los perfiles que los relays te devuelven: si un relay filtra, cae o limita historial, verás menos gente. Mitigación: 5 relays redundantes + re-descubrimiento manual. Y todo perfil es público por diseño: **no publiques datos sensibles** (dirección exacta, documentos, rutinas).

## Notas legales/privacidad

- Los chats están cifrados (NIP-04): ni los relays pueden leerlos.
- Los perfiles son **públicos**: cualquiera con acceso a un relay puede descargarlos.
- La contraseña nunca sale del dispositivo; si la olvidas, la cuenta se pierde (nadie la guarda).
- Revisar regulaciones locales sobre apps de citas y tratamiento de datos antes de promoverla masivamente.
