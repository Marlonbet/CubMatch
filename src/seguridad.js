// Punto 5 (refuerzos contra perfiles falsos y estafas): fricción al
// compartir datos sensibles en el chat. Detecta, en un mensaje
// SALIENTE, patrones de número de teléfono, de códigos de
// verificación, de contraseñas, de regalos/paquetes con pago por
// adelantado, de préstamos con pago por adelantado, de inversiones
// que prometen multiplicar el dinero, de fotos/vídeos íntimos, de
// dinero/recargas y de invitación a seguir fuera de la app, y devuelve
// 'telefono' | 'codigo' | 'clave' | 'regalo' | 'prestamo' | 'inversion' | 'intimo' | 'dinero' | 'externo' | null. La app pide confirmación
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
//  · Externo (v1.12.17): solo la invitación explícita a seguir por
//    WhatsApp/Telegram/Instagram/Facebook/Signal ("hablemos por
//    WhatsApp", "búscame en Instagram", "mi Telegram es @…"). Un
//    "¿tienes WhatsApp?" o "¿usas Telegram?" NO dispara: preguntar
//    no es invitar a salir. Un número en el mensaje ya es 'telefono'
//    y se clasifica antes.
//  · Código (v1.12.18): pedir o compartir un código de verificación
//    ("código de verificación", "pásame el código que te llegó",
//    "te paso mi código", "mi código es 482913"). Un código de
//    descuento, el código postal o el código de la puerta NO
//    disparan: no son códigos que den acceso a una cuenta. Un
//    número de teléfono en el mensaje sigue siendo 'telefono' y
//    se clasifica antes.
//  · Clave (v1.12.19): pedir o compartir una contraseña ("mi
//    contraseña es…", "pásame tu contraseña", "te doy mi clave").
//    Hablar de una contraseña sin compartirla ni pedirla NO dispara:
//    "olvidé mi contraseña" o "voy a cambiar mi contraseña" no son
//    entrega de credenciales. Un número o un código en el mensaje
//    se clasifican antes, como siempre.
//  · Regalo (v1.12.20): regalo/paquete/premio JUNTO a un pago por
//    adelantado para recibirlo (envío, aduana, impuesto, pagar,
//    tarifa, liberar). Solo el regalo sin pago NO dispara ("te
//    compré un regalo"), y solo hablar del envío de un paquete
//    que ya llegó tampoco ("el envío del paquete llegó bien"):
//    el timo es prometer algo y cobrar antes de entregarlo. Se
//    clasifica antes que 'dinero'.
//  · Inversión (v1.12.21): promesa de multiplicar el dinero o
//    ganancias seguras/garantizadas (duplicar, devolver el doble,
//    "invierte y gana", trading/cripto con retorno). Hablar de
//    inversiones sin promesa NO dispara: "invertí en mi negocio",
//    "¿invertiste en cripto?" o "trabajo en trading" no son ofertas;
//    "te doy el doble de amor" tampoco (el doble sin dinero ni
//    plazo no es una promesa de ganancia). Un número, un código
//    o una clave en el mensaje se clasifican antes, como siempre.
//    Se clasifica antes que 'dinero'.
//  · Íntimo (v1.12.23): pedir o compartir foto/vídeo/imagen íntima
//    ("mándame fotos íntimas", "foto sin ropa", "quiero verte
//    desnuda", "video íntimo", "fotos hot"). Requiere el sustantivo
//    (foto/vídeo/imagen) JUNTO a un calificativo íntimo, o un verbo
//    de petición/envío junto al sustantivo íntimo. Hablar de fotos
//    NO dispara ("¿viste mis fotos?", "foto de mi perro", "fotos
//    de mi viaje"), ni un piropo sin petición de foto ("qué sexy
//    te ves hoy"). Se clasifica antes que 'dinero'.
//  · Préstamo (v1.12.22): préstamo/crédito JUNTO a un pago por
//    adelantado para recibirlo (comisión, garantía, depósito,
//    activación, "por adelantado", "para liberarlo"; el seguro
//    solo si hay que pagarlo o depositarlo). Solo hablar de un
//    préstamo NO dispara ("pedí un préstamo en el banco",
//    "el banco me aprobó un préstamo", "mi primo me dio un
//    préstamo y le pago en dos meses", "mi préstamo tiene un
//    seguro de vida"): el timo es cobrar antes de dar el dinero.
//    Se clasifica antes que 'dinero'.
export function detectarDatoSensible(texto) {
  if (!texto || typeof texto !== 'string') return null;
  const t = texto;
  const telefono = /(?:\+?53[\s-]*)?\d{8}\b/.test(t) ||
    /(?:\+?53[\s-]*)?\d{4}[\s-]\d{4}\b/.test(t);
  if (telefono) return 'telefono';
  const codigo = /c[oó]digo\s+de\s+(verificaci[oó]n|confirmaci[oó]n)/i.test(t) ||
    /(p[aá]same|m[aá]ndame|env[íi]ame)\b[^.]{0,20}c[oó]digo/i.test(t) ||
    /(te\s+(paso|mando|doy))\b[^.]{0,20}c[oó]digo/i.test(t) ||
    /mi\s+c[oó]digo\s+(es|:)/i.test(t) ||
    /c[oó]digo\s+que\s+(te\s+)?(lleg[oó]|recibiste)/i.test(t);
  if (codigo) return 'codigo';
  const clave = /mi\s+(contrase[ñn]a|clave)\s+(es\b|:)/i.test(t) ||
    /(p[aá]same|m[aá]ndame|env[íi]ame|dime)\b[^.]{0,20}(tu\s+)?(contrase[ñn]a|clave)/i.test(t) ||
    /(te\s+(paso|doy|mando))\b[^.]{0,20}mi\s+(contrase[ñn]a|clave)/i.test(t) ||
    /cu[áa]l\s+es\s+tu\s+(contrase[ñn]a|clave)/i.test(t);
  if (clave) return 'clave';
  const regalo = /(regalo|paquete|obsequio|premio|encomienda)\b[^.]{0,40}(env[ií]o|aduanas?|impuestos?|pagar|pago|tarifa|costo|liberar)/i.test(t) ||
    /(aduanas?|impuestos?|pagar|pago|tarifa)\b[^.]{0,40}(regalo|paquete|obsequio|premio|encomienda)/i.test(t);
  if (regalo) return 'regalo';
  const inversion = /(duplic|triplic|multiplic)\w*\b[^.]{0,30}(dinero|plata|inversi[oó]n|ganancia)/i.test(t) ||
    /te\s+devuelvo\b[^.]{0,20}(el\s+)?(doble|triple)/i.test(t) ||
    /(te\s+doy)\b[^.]{0,20}(el\s+)?(doble|triple)\b[^.]{0,15}(dinero|plata|lo\s+que|en\s+\d+\s*(horas?|d[ií]as?|semana))/i.test(t) ||
    /invierte\b[^.]{0,30}(gana|ganancia|devuelvo|doble|triple|retorno|multiplic|duplic)/i.test(t) ||
    /ganancias?\s+(seguras?|garantizadas?)/i.test(t) ||
    /(retorno|rendimiento)\s+(garantizado|garantizada|seguro|segura|sin\s+riesgo)/i.test(t) ||
    /inversi[oó]n\s+(garantizada?|sin\s+riesgo)/i.test(t) ||
    /(trading|cripto\w*|bitcoin|forex)\b[^.]{0,30}(invierte|invertir|duplica|te\s+devuelvo|retorno)/i.test(t);
  if (inversion) return 'inversion';
  const prestamo = /(pr[eé]stamo|cr[eé]dito)\b[^.]{0,50}(comisi[oó]n|garant[ií]a|dep[oó]sito|activaci[oó]n|activar|por\s+adelantado|para\s+liberarlo)/i.test(t) ||
    /(comisi[oó]n|garant[ií]a|dep[oó]sito|activaci[oó]n|activar|por\s+adelantado|para\s+liberarlo)\b[^.]{0,50}(pr[eé]stamo|cr[eé]dito)/i.test(t) ||
    /(pr[eé]stamo|cr[eé]dito)\b[^.]{0,50}(pagar|paga|deposit\w*)\b[^.]{0,25}(el\s+)?seguro/i.test(t) ||
    /(pagar|paga|deposit\w*)\b[^.]{0,25}(el\s+)?seguro\b[^.]{0,40}(pr[eé]stamo|cr[eé]dito)/i.test(t);
  if (prestamo) return 'prestamo';
  const intimo = /(foto|fotos|v[íi]deo|v[íi]deos|imagen|im[áa]genes)\b[^.]{0,30}(íntim\w*|desnud\w*|sin\s+ropa|ropa\s+interior|hot|er[óo]tic\w*|porno|xxx)/i.test(t) ||
    /(m[áa]ndame|env[íi]ame|p[áa]same|mu[ée]strame|quiero\s+ver)\b[^.]{0,15}(foto|fotos|v[íi]deo|v[íi]deos|imagen|im[áa]genes|desnud\w*|íntim\w*)/i.test(t) ||
    /(te\s+(mando|paso|env[íi]o))\b[^.]{0,30}(mis\s+)?(foto|fotos|v[íi]deo|v[íi]deos|imagen|im[áa]genes)\b[^.]{0,20}(íntim\w*|desnud\w*|sin\s+ropa|ropa\s+interior|hot|er[óo]tic\w*|porno|xxx)/i.test(t) ||
    /verte\s+(desnud\w*|sin\s+ropa|en\s+ropa\s+interior)/i.test(t);
  if (intimo) return 'intimo';
  const dinero = /recarg/i.test(t) ||
    /transf/i.test(t) ||
    /m[áa]ndame\s+(dinero|saldo|recarga|transferencia)/i.test(t) ||
    /env[íi]ame\s+(dinero|saldo)/i.test(t) ||
    /n[úu]mero\s+de\s+tarjeta/i.test(t);
  if (dinero) return 'dinero';
  const externo = /(hablemos|pasemos|sigamos|escr[íi]beme|b[úu]scame|agr[ée]game|te\s+(paso|doy|mando)|p[áa]same\s+tu)\b[^.]{0,24}(whatsapp|telegram|instagram|facebook|signal|\big\b)/i.test(t) ||
    /mi\s+(whatsapp|telegram|instagram|facebook)\b[^@]{0,20}@/i.test(t) ||
    /mi\s+usuario\b[^@]{0,20}@/i.test(t);
  if (externo) return 'externo';
  return null;
}
