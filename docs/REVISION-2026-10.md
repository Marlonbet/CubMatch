# Revisión 2026-10: qué se corrigió, cómo aplicarlo y qué falta

Base: `main` @ `b61ef53`. Todo lo de aquí es retrocompatible con las cuentas y el
código existentes salvo que se indique lo contrario.

## Corregido en este paquete

| Hallazgo | Archivos | Estado |
|---|---|---|
| El auto-update ejecutaba código de proxies de terceros sin verificar autoría | `src/boot.js`, `build.mjs`, `tools/firma.mjs`, `tools/gen-update-key.mjs` | ✅ Firma ECDSA P-256 verificada antes de ejecutar; falla cerrado |
| Reclamo de usuario sabotable con `created_at` falso (bloqueo del dueño) | `src/cuentas.js` (`fetchUsernameClaim`, `verifyCredentials`) | ✅ El login acepta a cualquier dueño legítimo del nombre |
| Contraseñas débiles / fuerza bruta offline | `src/cuentas.js` (`validateNewPassword`, `KDF` v2, `resolverCuenta`) | ⚠️ Código listo; **falta conectarlo en `app.js`** (ver abajo) |
| Reciprocidad: el dislike enviado sumaba +0.3 y el factor valía 0 para todo el mazo | `src/matching.js` | ✅ Corregido; el 5º factor ahora aprende de tus swipes (local) |
| Pool pequeño: relación y gate dejaban a la gente sin candidatos | `src/matching.js` (nivel 3 de `rankCandidates`) | ✅ Modo mínimo para <15 candidatos |
| Intereses por coincidencia exacta ("bailar" ≠ "baile") | `src/matching.js` (`stemTerm`) | ✅ Stemming ligero |
| Actividad = última edición del perfil | `src/matching.js` (`ctx.ultimaActividad`) | ⚠️ Soportado; **falta pasarlo desde `app.js`** |
| Sin CI | `.github/workflows/ci.yml` | ✅ `npm test` + `npm run build` |
| Documentación desactualizada | `README.md`, `PLAN.md` | ✅ |
| Sin `.gitignore` (riesgo de subir la clave privada de firma) | `.gitignore` | ✅ |

Tests nuevos: `test/aprendizaje.test.mjs`, `test/update-firma.test.mjs`, `test/cuentas-claims.test.mjs`.
Los tests existentes no se tocaron (se comprobó que `test/matching.test.mjs` sigue pasando contra el motor nuevo).

## Cómo aplicarlo

1. Copia los archivos respetando las rutas (o súbelos por la web de GitHub a una **rama**, no a `main`).
2. `npm install && npm test`.
3. Genera la clave de firma **una vez**: `node tools/gen-update-key.mjs`. Guarda `update-key.private.pem`
   fuera del repo (ya está en `.gitignore`); sube `update-key.pub.json`.
4. Sube la versión en `package.json` y compila **firmando**:
   `UPDATE_SIGNING_KEY=update-key.private.pem npm run build`.
5. Sube `app/live/`, `dist/` y `update-key.pub.json`.

⚠️ Mientras no hagas los pasos 3-5, `dist/` y `app/live/` siguen siendo los de antes (con el loader viejo e inseguro):
cambiar `src/` no cambia lo que reciben los usuarios hasta que recompiles.

⚠️ Transición: quienes ya tienen un `cubmatch.html` anterior cargan la primera versión nueva con el loader viejo
(sin verificación). Desde esa versión en adelante, las actualizaciones sí se verifican. Eso no se puede arreglar
con retroactividad.

## Pendiente (no hecho, y por qué)

**Requiere editar `app.js` (126 KB; no lo toqué porque no pude probar la UI):**

- *Login/registro con las contraseñas y la derivación nuevas.* Busca todas las llamadas a `deriveSecretKey`
  y `validatePassword` en `app.js`:
  ```js
  // Registro (cuenta nueva)
  validateNewPassword(password, username);                       // antes: validatePassword(password)
  const sk = await deriveSecretKey(username, password, { version: KDF_ACTUAL });
  // Login (cuentas v1 y v2)
  validatePassword(password);                                    // 8+ para no bloquear cuentas existentes
  const claim = await fetchUsernameClaim(pool, username);
  const cuenta = await resolverCuenta(username, password, claim); // prueba v2 y luego v1
  if (!cuenta) /* credenciales incorrectas */;
  const sk = cuenta.sk;
  ```
  Antes de activar v2 prueba el tiempo en un teléfono barato (`KDF[2].N`, 2^16 ≈ 64 MB).
- *Actividad real:* pasa `ctx.ultimaActividad = { [pubkey]: timestamp_en_segundos }` (presencia, último DM/like)
  a `rankCandidates`/`score`.

**Cambios de protocolo (necesitan plan de compatibilidad y pruebas en dispositivos reales):**

- Likes/dislikes públicos (`kind 7` con tag `p`): no publicar dislikes (guardarlos locales o cifrados a uno mismo)
  y enviar los likes con gift wrap (NIP-59). Hacerlo mal rompe los matches entre versiones.
- Migrar chats de NIP-04 a NIP-17/NIP-44 (metadatos visibles, sin cifrado autenticado).
- Prueba de trabajo (NIP-13) en perfiles y lista de relays configurable (hoy solo 4 relays fijos).
- Verificar firma y autor en un único punto del transporte (`red.js`, `_handleRelayMessage`) en vez de en cada sitio;
  `fetchProfile` hoy no verifica la firma ni que el autor coincida con el pedido.
- Dividir `app.js` / `llamadas.js` en módulos.

**Otros hallazgos menores:**

- `matching.js` ya no usa `prefs.distancia` ("solo mi provincia"…): solo pesa el factor geo.
- `build.mjs` no sustituye los placeholders `__TURNCF_*` (el comentario de `turncf.js` dice que sí).
- Si compilaste con `TURNMD_INJECT`, la API key de Metered está en el repo público; revisa que esté acotada
  y con alerta de cuota, o rótala.
- El reclamo de nombre sigue permitiendo que alguien "ocupe" nombres por adelantado.

## Cómo se probó (y qué NO)

- Se ejecutaron en local con Node 22: los 43 tests existentes de matching (copia funcional), los 15 nuevos de
  aprendizaje, los 10 de firma (contra WebCrypto real) y un extremo a extremo build → firma → loader del build anterior.
- **No** se pudo ejecutar con las dependencias reales (`nostr-tools`, `@noble/hashes`, `esbuild`, `jsdom`; no había
  red). `cuentas.js` se probó con stubs de esas librerías y `build.mjs` con un `esbuild` de mentira. El CI y
  `npm test` en tu máquina son la verificación definitiva.
