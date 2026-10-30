// CUBMATCH — lógica pura de los mensajes del chat (sin DOM):
// estados de envío de MIS mensajes y fusión de la lista local con lo
// que llega de la red. Testeable en Node.
//
// Señales reales que respaldan cada estado (nada inventado):
//  - 'enviando': pintado optimista local; la publicación del evento
//    kind 4 aún no se confirma.
//  - 'enviado' : la publicación resolvió (≥1 relay aceptó con OK) o el
//    propio evento volvió por la red (eco/sync): el mensaje está en
//    los relays, disponible para que el otro lo recoja.
//  - 'error'   : la publicación rechazó (ningún relay aceptó); el
//    mensaje queda visible con opción de reintentar.
//  - 'visto'   : NO vive en `estado`: es el flag `read`, que solo
//    voltea el receipt kind 24503 que el cliente del otro envía al
//    abrir el chat (ver handleReceipt en app.js).
//
// No se muestra "entregado" (✓✓ gris): en Nostr el modelo es pull —
// que el teléfono del otro haya recogido el DM de un relay no genera
// ninguna señal observable distinta de su receipt de lectura.
// Fingir ese estado sería mentir; disponibles solo los de arriba.

export const TMP_PREFIX = 'tmp:';
const RANGO = { error: 0, enviando: 1, enviado: 2 };

export function esTmpId(id) {
  return typeof id === 'string' && id.startsWith(TMP_PREFIX);
}

// Estado de envío normalizado de un mensaje. Los mensajes guardados
// por versiones viejas no traen `estado`: si son míos, o se publicaron
// en su momento o se importaron de la red — en ambos casos 'enviado'.
export function estadoNormalizado(m) {
  if (!m || m.from !== 'me') return null;
  if (m.estado === 'enviando' || m.estado === 'enviado' || m.estado === 'error') return m.estado;
  return 'enviado';
}

// Lo que la UI pinta junto a la hora: 'enviando' | 'enviado' |
// 'error' | 'visto' | null (mensajes del otro / registros locales /
// mensajes eliminados para ambos: sin estado de envío).
export function estadoVisible(m) {
  if (!m || m.from !== 'me' || m.tipo || m.eliminado) return null;
  if (m.read) return 'visto';
  return estadoNormalizado(m);
}

// Fusiona `entrante` en la lista (mutación in situ, como pushMsg
// siempre hizo: el llamante puede conservar la referencia al mensaje
// optimista y seguir actualizándolo). Devuelve la lista ordenada
// por ts. Reglas:
//  - Mismo id: se conserva el estado más avanzado y read = OR.
//  - Eco de un optimista (entrante mío con id real y un tmp pendiente
//    con el mismo texto): el tmp adopta el id real y pasa a 'enviado',
//    sin duplicar. El eco NUNCA adopta sobre otro tmp si el entrante
//    también es tmp (dos envíos idénticos seguidos no se confunden).
//  - En la fusión se conserva el ts del mensaje ya presente (el
//    momento en que el usuario lo envió manda sobre created_at).
export function fusionarMensajes(lista, entrante) {
  const arr = Array.isArray(lista) ? lista : [];
  if (!entrante || typeof entrante.id !== 'string') return arr;
  let ex = arr.find((m) => m.id === entrante.id);
  if (!ex && entrante.from === 'me' && !esTmpId(entrante.id)) {
    ex = arr.find((m) => m.from === 'me' && esTmpId(m.id) && m.text === entrante.text &&
      (estadoNormalizado(m) === 'enviando' || estadoNormalizado(m) === 'error'));
    if (ex) ex.id = entrante.id;
  }
  if (ex) {
    ex.read = !!(ex.read || entrante.read);
    if (entrante.from === 'me') {
      const a = estadoNormalizado(ex);
      const b = estadoNormalizado(entrante);
      ex.estado = (RANGO[b] ?? 0) >= (RANGO[a] ?? 0) ? b : a;
    }
  } else {
    arr.push(entrante);
  }
  arr.sort((x, y) => (x.ts || 0) - (y.ts || 0));
  return arr;
}

// Borrado para ambos (v1.12.16), regla JUSTA en una sola función:
// solo el autor puede borrar su propio mensaje, y solo el contenido
// desaparece: queda la huella (id, autor, hora) para que el borrado
// sea visible en ambos lados, nunca silencioso. Devuelve true si se
// aplicó. NO borra: mensajes del otro (esMio debe coincidir con el
// autor), registros locales de llamada (tipo 'call', no son DMs) ni
// mensajes ya eliminados (idempotente: un segundo borrado no cambia
// nada). La lista se muta in situ, como fusionarMensajes.
export function aplicarBorrado(lista, targetId, esMio) {
  const arr = Array.isArray(lista) ? lista : [];
  const m = arr.find((x) => x && x.id === targetId);
  if (!m || m.tipo || m.eliminado) return false;
  if (esMio ? m.from !== 'me' : m.from !== 'peer') return false;
  m.text = '';
  m.eliminado = true;
  return true;
}

// colgado (la app se cerró a mitad de envío, p. ej.): pasa a 'error'
// para que el usuario pueda reintentar. Devuelve cuántos cambiaron.
export function marcarColgados(lista, ahoraMs, umbralMs = 60000) {
  let n = 0;
  for (const m of lista || []) {
    if (m && m.from === 'me' && !m.tipo && m.estado === 'enviando' &&
        typeof m.ts === 'number' && ahoraMs - m.ts > umbralMs) {
      m.estado = 'error';
      n++;
    }
  }
  return n;
}
