# Verificación de identidad sin SMS para CubMatch

**Objetivo**: probar que detrás de un perfil hay una persona real, única y que coincide con sus fotos — sin SMS, sin servidor, sin costo, y resistente a contenido generado por IA (selfies sintéticas, videos deepfake, deepfakes en tiempo real).

## 1. Restricciones del entorno (por qué el diseño es así)

- Sin SMS (+53): imposible sin un proveedor que no tenemos.
- Sin servidor central: nadie puede ser "la autoridad" que verifica.
- Sin presupuesto: nada de APIs pagas de verificación de identidad.
- Privacidad: es una app de citas; nadie quiere su carnet circulando por ahí.
- Conectividad intermitente: el protocolo debe tolerar asincronía total.

## 2. Modelo de amenaza

Atacante con acceso a IA generativa actual:

- **A1**: selfie 100% sintética como foto de perfil.
- **A2**: video deepfake pre-generado "cumpliendo" un reto conocido.
- **A3**: deepfake en tiempo real durante una videollamada.
- **A4**: una misma cara (sintética o robada) usada en N cuentas (Sybil).
- **A5**: fotos robadas de una persona real (catfish clásico).
- **A6**: reuso del video de verificación de otra cuenta (replay).

**Principio central**: no intentamos *detectar IA con un algoritmo* (es una carrera armamentista perdida y pesaría MB en la app). En su lugar: **impredecibilidad + costo humano + reputación en juego**. Un humano en vivo, frente a un reto que el atacante no pudo predecir, es hoy la defensa más fiable — y no requiere ni un servidor.

## 3. Niveles de verificación

- **Nivel 0**: sin verificar. Sin insignia.
- **Nivel 1 — "Persona real"**: superó el reto de gestos (captura en la app) revisado por 1 verificador autorizado.
- **Nivel 2 — "Verificado por la comunidad"**: interacción en vivo (videollamada o en persona) con 2 verificadores independientes + retos físicos impredecibles.
- **Nivel 3 — "Embajador"**: Nivel 2 con ≥90 días de antigüedad y ≥10 verificaciones otorgadas sin fraude probado. La semilla inicial es el creador + su círculo de confianza (público y auditable, ver §10).

Insignia visible en el perfil: ✓ (N1), ✓✓ (N2), ★ (N3). Filtro en descubrimiento: "solo verificados".

## 4. Protocolo Nivel 1: reto de gestos (asíncrono, sin llamada)

1. El usuario toca "Verificar identidad".
2. La app genera un **reto aleatorio**: 3 gestos de un catálogo de 10 (mirar a la izquierda, parpadear 2 veces, 2 dedos junto a la cara, taparse un ojo con la mano, girar a la derecha, sonreír mostrando dientes, tocarse la nariz, perfil izquierdo 2 segundos, levantar cejas, mano abierta ante la cara) + una **palabra nonce** que debe decir en voz alta. El reto lleva `reto_id` (uuid) y **expira en 15 minutos**.
3. **Captura obligatoria dentro de la app** (getUserMedia): video ≤45 s, una sola toma continua, cuenta regresiva 3-2-1. **Prohibido subir archivos**: los bytes tienen que nacer en la cámara *ahora mismo*. Esto solo ya elimina A1 y el 99% de A2 — el atacante no puede subir su video pre-generado.
4. La app **encadena hashes de frames** (cada frame incluye el hash del anterior) → cualquier corte o empalme es detectable. Incluye timestamp.
5. El usuario elige **cómo** el verificador ve la prueba. El protocolo es agnóstico al transporte — los bytes pesados **no** viajan por Nostr:
   - Vía principal (realidad cubana): se la pasa por WhatsApp / Bluetooth / en persona al verificador elegido de la lista.
6. El verificador comprueba: (a) los 3 gestos + palabra coinciden con el reto — como fue aleatorio e impredecible, un deepfake pre-generado no puede acertar (muere A2); (b) toma continua sin cortes (hash encadenado); (c) el rostro coincide con las fotos del perfil (muere A5); (d) se ve persona real.
7. Si pasa, el verificador publica la **atestación** en Nostr (§6). El video se borra; **nunca se publica**.

## 5. Protocolo Nivel 2: verificación en vivo

- Videollamada (WhatsApp, la que ya todos usan) o encuentro en persona, con **2 verificadores** que idealmente no se conozcan entre sí.
- Cada verificador pide **2 retos físicos impredecibles en el momento**: oclusiones mano-cara (rompen a casi todos los deepfakes en tiempo real — muere A3), mostrar en cámara un objeto o palabra que el verificador elige *durante* la llamada (imposible de pre-generar), giro completo, etc.
- Ambos publican su atestación. Quórum: 2.

## 6. Eventos Nostr (nadie auto-firma su propia verificación)

- **Atestación** — kind `30081`, **firmada por el VERIFICADOR** (nunca por el sujeto): tags `[["p", pubkey_sujeto], ["t","cubmatch-verificacion"], ["t","cubmatch"]]`, contenido JSON: `{nivel: 1|2, metodo: "reto-gestos"|"videollamada"|"en-persona", reto_id, verificado_en, expira_en, rostro_simhash, fotos_hash: [...], nota}`.
- **Vouch social** (respaldo informal, no otorga insignia) — kind 1 con tags `[["p", sujeto],["t","cubmatch-vouch"]]`. Visible como "3 personas lo respaldan".
- **Prueba de fraude** — kind `1984` (NIP-56) contra el sujeto. Si se sostiene, su nivel cae a 0 y cada verificador que lo atestó recibe un *strike* (2 strikes = pierde el estatus de verificador).
- **Nivel efectivo calculado en cliente** (determinista, sin servidor): N2 = ≥2 atestaciones N2 de verificadores distintos, vigentes, sin fraude abierto; N1 = ≥1 atestación N1 vigente. **Regla de oro**: las auto-atestaciones se ignoran siempre.
- Las atestaciones **expiran a los 12 meses** → re-verificación ligada al recordatorio de "perfil vivo" del plan.

## 7. Tabla anti-IA (ataque → contramedida)

| Ataque | Contramedida |
|---|---|
| A1 selfie sintética (upload) | Captura solo en-app; uploads prohibidos en el flujo de verificación |
| A2 deepfake pre-generado | Reto aleatorio generado en el momento + ventana de 15 min + hash encadenado anti-cortes |
| A3 deepfake en vivo | Retos físicos impredecibles (oclusiones mano-cara, objeto/palabra nonce elegida en el momento) + 2 verificadores independientes |
| A4 una cara en N cuentas | `rostro_simhash` publicado en la atestación → detección de duplicados en red (v1.2; en v1 lo hacen los verificadores humanos) |
| A5 fotos robadas de persona real | El rostro del reto debe coincidir con las fotos del perfil o no hay atestación |
| A6 replay de video ajeno | `reto_id` único + palabra nonce + timestamps; un reto jamás se reutiliza |

## 8. Anti-Sybil: economía, no algoritmos

- Verificar cuesta trabajo humano real → escalar cuentas falsas es caro.
- Cada verificador N2: máximo 5 atestaciones/mes (escasez programada).
- Las atestaciones son públicas y **ponen en juego el nivel del verificador** (strikes) → atestar a un fake tiene costo reputacional.
- N3 solo se gana con historial; no se compra ni se auto-otorga.

## 9. Privacidad

- El video/prueba **nunca** se publica en relays. Solo viaja la atestación firmada (metadatos, no biometría cruda: se publica un simhash, no el embedding ni la foto).
- El usuario elige a sus verificadores.
- Sin carnet de identidad, sin documentos gubernamentales.
- Caducidad a 12 meses: ningún dato de verificación vive para siempre.

## 10. Bootstrap (el problema del huevo y la gallina)

- **Día 0**: Marlon + 3–5 personas de confianza = embajadores semilla (N3) por decisión documentada del creador en el repo.
- **Semanas 1–4**: los embajadores verifican en persona / videollamada a los primeros usuarios.
- **Regla anti-camarilla**: un embajador no puede otorgar N3 a otro embajador; la lista semilla es pública y auditable por cualquiera.

## 11. UX propuesta

- En el perfil: botón "Verificar identidad" → explica los niveles → elige método → genera reto → graba → elige verificador de la lista (N2+ marcados "disponible") → espera → insignia.
- En Ajustes: "Quiero ser verificador" (opt-in), lista de atestaciones recibidas y otorgadas, strikes.
- En el deck: insignia ✓/✓✓/★ sobre la tarjeta; filtro "solo verificados".

## 12. Roadmap

- **v1.1**: flujo de reto de gestos + atestaciones kind 30081 + insignias + filtro + lista de verificadores. Cero ML, cero peso extra.
- **v1.2**: `rostro_simhash` + detección de duplicados en cliente; modelo de embedding liviano con carga diferida, solo en modo verificador.
- **v2**: reputación visible de verificadores, programa de embajadores formal, jurado comunitario para fraudes.

## 13. Lo que NO hacemos (y por qué)

- **Sin SMS**: imposible técnicamente en nuestro contexto.
- **Sin carnet/ID**: privacidad + nadie quiere OCR de documentos oficiales en una app de citas cubana.
- **Sin "detección de IA" algorítmica en el MVP**: carrera perdida contra los generadores; el humano con reto impredecible es más fiable y no pesa ni un KB.
- **Sin autoridad central**: la confianza la computa cada cliente a partir de atestaciones firmadas.

**Limitación honesta**: el sistema es tan fuerte como su comunidad semilla. En una red pequeña y real como la cubana, eso es una ventaja, no un defecto: la gente se conoce.
