// CUBMATCH — presencia en el chat (lógica pura, sin DOM).
//
// Diseño honesto: con la app abierta publico un beacon efímero
// kind 21005 cada ~45 s en los relays de mensajería. "En línea"
// significa SOLO "su app publicó un beacon hace <2 min" (app abierta
// recientemente); nada más preciso existe sin un servidor. Si no hay
// beacon fresco, muestro la última vez que ESTE teléfono lo vio
// (persistida en localStorage): un dato local, no una verdad de red.
// Al cerrar sesión se intenta un beacon con contenido "off" para
// acortar el falso "en línea"; la garantía real es el TTL de 2 min.

export const KIND_PRESENCIA = 21005; // efímero (20000–29999)
export const TTL_EN_LINEA_MS = 120000; // 2 minutos
export const BEACON_CADA_MS = 45000;

// Normaliza un registro de presencia guardado: {ts, off} | ts | null.
export function regDe(reg) {
  if (typeof reg === 'number' && reg > 0) return { ts: reg, off: false };
  if (reg && typeof reg.ts === 'number' && reg.ts > 0) return { ts: reg.ts, off: !!reg.off };
  return null;
}

export function estaEnLinea(reg, ahoraMs) {
  const r = regDe(reg);
  if (!r || r.off) return false;
  const dif = ahoraMs - r.ts;
  // Futura cercana = reloj del otro adelantado: cuenta como en línea.
  return dif > -30000 && dif < TTL_EN_LINEA_MS;
}

const MIN = 60000, HORA = 3600000, DIA = 86400000;

// "hace 5 min" | "hace 2 h" | "hace 3 d" | "el 12/10/2026"
export function haceTexto(ts, ahoraMs) {
  const dif = Math.max(0, ahoraMs - ts);
  if (dif < MIN) return 'hace un momento';
  if (dif < HORA) return 'hace ' + Math.floor(dif / MIN) + ' min';
  if (dif < DIA) return 'hace ' + Math.floor(dif / HORA) + ' h';
  if (dif < 7 * DIA) return 'hace ' + Math.floor(dif / DIA) + ' d';
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return 'el ' + dd + '/' + mm + '/' + d.getFullYear();
}

// Lo que pinta la UI: {enLinea, texto}. Sin datos (nunca visto desde
// este teléfono) → texto vacío: no se afirma nada.
export function textoPresencia(reg, ahoraMs) {
  const r = regDe(reg);
  if (!r) return { enLinea: false, texto: '' };
  if (estaEnLinea(r, ahoraMs)) return { enLinea: true, texto: 'En línea' };
  return { enLinea: false, texto: 'Últ. vez ' + haceTexto(r.ts, ahoraMs) };
}

// Valida un evento de beacon recibido (la firma la verifica la app
// con eventoValido antes, como en toda ingesta). Devuelve
// {pubkey, off, tsRecibido} o null. El instante que manda es el de
// RECEPCIÓN en este teléfono (Date.now() del llamante), no el
// created_at del otro: honestidad ante relojes ajenos falseables.
export function parseBeacon(ev, ahoraMs) {
  if (!ev || ev.kind !== KIND_PRESENCIA) return null;
  if (typeof ev.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(ev.pubkey)) return null;
  return { pubkey: ev.pubkey, off: ev.content === 'off', ts: ahoraMs };
}
