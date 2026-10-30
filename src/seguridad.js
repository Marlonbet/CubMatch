// Punto 5 (refuerzos contra perfiles falsos y estafas): fricción al
// compartir datos sensibles en el chat. Detecta, en un mensaje
// SALIENTE, patrones de número de teléfono y de dinero/recargas y
// devuelve 'telefono' | 'dinero' | null. La app pide confirmación
// antes de enviar (nunca bloquea: el usuario puede enviar de todos
// modos). Es fricción, no acusación: el texto del aviso no dice que
// la otra persona sea estafadora, solo recuerda el riesgo.
//
// Diseño anti-falsos-positivos:
//  · Teléfono: +53 + 8 dígitos, 8 dígitos seguidos, o 4+4 con espacio
//    o guion (5123 4567, 5123-4567). Las fechas NO disparan: 12-10-2026
//    es 2-2-4, y un año solo (2026) son 4 dígitos.
//  · Dinero: solo frases de acción (recarg*, transfer*, "mándame /
//    envíame dinero|saldo", "número de tarjeta"). Un "no tengo dinero"
//    suelto NO dispara: hablar de dinero no es compartir datos.
export function detectarDatoSensible(texto) {
  if (!texto || typeof texto !== 'string') return null;
  const t = texto;
  const telefono = /(?:\+?53[\s-]*)?\d{8}\b/.test(t) ||
    /(?:\+?53[\s-]*)?\d{4}[\s-]\d{4}\b/.test(t);
  if (telefono) return 'telefono';
  const dinero = /recarg/i.test(t) ||
    /transf/i.test(t) ||
    /m[áa]ndame\s+(dinero|saldo|recarga|transferencia)/i.test(t) ||
    /env[íi]ame\s+(dinero|saldo)/i.test(t) ||
    /n[úu]mero\s+de\s+tarjeta/i.test(t);
  if (dinero) return 'dinero';
  return null;
}
