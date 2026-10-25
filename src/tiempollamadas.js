// CUBMATCH — presupuesto mensual de llamadas por relevo (v1.10.0,
// diferenciado voz/video desde v1.12.1).
//
// Por qué existe: las llamadas que no conectan directo (típico con
// datos móviles) pasan por un servicio de relevo gratuito cuya
// capacidad mensual es pequeña y COMPARTIDA por toda la comunidad.
// Para repartirla con justicia, cada persona tiene un presupuesto
// de minutos de relevo al mes; el tiempo por WiFi directo NO
// descuenta (no usa el relevo). Al agotarse, la llamada en curso se
// despide con cordialidad tras una gracia corta.
//
// Por qué DOS cubetas (v1.12.1): el video consume ~10 veces más
// ancho de banda que la voz, así que un solo tope era injusto en
// ambos sentidos: una videollamada corta se comía todo el cupo de
// voz, y un cupo pensado para voz dejaba pasar demasiado video.
// Cada medio tiene su propio presupuesto mensual: 20 min de voz y
// 5 min de video. Gastar uno no toca el otro. La cubeta vieja de
// una sola llave (sin medio) se conserva como cubeta de voz, así
// que nadie pierde lo que ya tenía: el video empieza de cero.
//
// Este módulo es puro (sin DOM ni red): la cubeta mensual, cuánto
// queda, si procede cortar y la lectura del par de candidatos ICE
// seleccionado (de donde sale si la llamada va por relevo) son
// funciones con reloj inyectable. La persistencia (localStorage) y
// el muestreo viven en app.js / llamadas.js.

// Presupuesto mensual de tiempo POR RELEVO por persona. Al cambiar
// de mes se reinicia solo. Para subir/bajar el límite, esta línea.
export const LIMITE_RELEVO_MS = 20 * 60 * 1000;
// Tope mensual de relevo para VIDEO: menor que el de voz porque el
// video consume ~10 veces más ancho de banda. 5 min alcanzan para
// una videollamada corta sin dejar que unas pocas agoten el cupo
// compartido de toda la comunidad.
export const LIMITE_RELEVO_VIDEO_MS = 5 * 60 * 1000;
// Límite que aplica a cada medio ('audio' por defecto: lo que no es
// video cuenta como voz, para no bloquear llamadas viejas sin medio).
export function limiteParaMedia(media) {
  return media === 'video' ? LIMITE_RELEVO_VIDEO_MS : LIMITE_RELEVO_MS;
}
// Gracia entre el aviso de "se acabó" y el corte de la llamada.
export const GRACIA_LIMITE_MS = 15000;
// Cada cuánto se mira si la llamada conectada va por relevo.
export const MUESTREO_RELEVO_MS = 10000;

// ---- textos de usuario (lenguaje simple, sin jerga) ----
// Explicación junto al tiempo restante en Ajustes → Llamadas.
export const TEXTO_LIMITE_EXPL =
  'Las llamadas que usan datos móviles pasan por un servicio de relevo gratuito ' +
  'con capacidad limitada para toda la comunidad. Para repartirla, cada persona ' +
  'tiene 20 minutos de voz y 5 minutos de videollamadas al mes; el tiempo ' +
  'se renueva el día 1. El video consume mucho más ancho de banda, por eso ' +
  'su tope es menor. Si la llamada conecta directa por WiFi, no se descuenta.';
// Aviso inmediato al agotarse el presupuesto con una llamada en curso.
export const TEXTO_LIMITE_AVISO =
  '⏳ Ya usaste tus 20 minutos de llamadas de este mes: esta llamada ' +
  'termina en unos segundos.';
// Despedida al cortarse la llamada por límite.
export const TEXTO_LIMITE_CORTE =
  'Se terminaron tus 20 minutos de llamadas de este mes 📞 Las llamadas con ' +
  'datos móviles pasan por un relevo gratuito que compartimos entre toda la ' +
  'comunidad; para repartirlo, cada persona tiene 20 minutos al mes que se ' +
  'renuevan el día 1. Por WiFi puedes seguir llamando sin límite.';
// Variantes para video (el aviso y el corte de voz siguen siendo las
// constantes de arriba, para no romper a quien ya las conoce).
export const TEXTO_LIMITE_AVISO_VIDEO =
  '⏳ Ya usaste tus 5 minutos de videollamadas de este mes: esta llamada ' +
  'termina en unos segundos.';
export const TEXTO_LIMITE_CORTE_VIDEO =
  'Se terminaron tus 5 minutos de videollamadas de este mes 📞 Las videollamadas con ' +
  'datos móviles pasan por un relevo gratuito que compartimos entre toda la ' +
  'comunidad; para repartirlo, cada persona tiene 5 minutos de video al mes que se ' +
  'renuevan el día 1. Por WiFi puedes seguir llamando sin límite.';
// Aviso / corte según el medio de la llamada en curso.
export function avisoLimite(media) {
  return media === 'video' ? TEXTO_LIMITE_AVISO_VIDEO : TEXTO_LIMITE_AVISO;
}
export function corteLimite(media) {
  return media === 'video' ? TEXTO_LIMITE_CORTE_VIDEO : TEXTO_LIMITE_CORTE;
}

// ---- cubeta mensual ----
// Registro guardado: { mes: 'AAAA-MM', ms: <usado en el mes> }.

// Clave del mes local (AAAA-MM) para un instante en ms.
export function mesClave(ahoraMs) {
  const d = new Date(ahoraMs);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function regSano(reg) {
  return !!reg && typeof reg.mes === 'string' && typeof reg.ms === 'number' && reg.ms >= 0;
}

// Milisegundos de relevo usados en el mes del instante dado. Un
// registro de otro mes (o basura) cuenta como cero: el presupuesto
// se reinicia solo al cambiar el mes.
export function usoEnMes(reg, ahoraMs) {
  if (!regSano(reg)) return 0;
  return reg.mes === mesClave(ahoraMs) ? reg.ms : 0;
}

// Suma tiempo de relevo y devuelve el registro NUEVO a guardar
// (si el mes cambió, la cubeta nace de cero con la suma de ahora).
export function conUso(reg, deltaMs, ahoraMs) {
  const d = typeof deltaMs === 'number' && deltaMs > 0 ? deltaMs : 0;
  return { mes: mesClave(ahoraMs), ms: usoEnMes(reg, ahoraMs) + d };
}

// Cuánto presupuesto queda este mes (nunca negativo).
export function restanteMs(reg, ahoraMs, limite = LIMITE_RELEVO_MS) {
  return Math.max(0, limite - usoEnMes(reg, ahoraMs));
}

// ¿Procede cortar? Presupuesto agotado en este mes.
export function agotado(reg, ahoraMs, limite = LIMITE_RELEVO_MS) {
  return restanteMs(reg, ahoraMs, limite) <= 0;
}

// Minutos que quedan, redondeados hacia arriba (con 30 s restantes
// no se anuncia "0 min": queda 1).
export function minutosRestantes(reg, ahoraMs, limite = LIMITE_RELEVO_MS) {
  return Math.ceil(restanteMs(reg, ahoraMs, limite) / 60000);
}

// La frase de Ajustes → Llamadas: "Te quedan X min de llamadas este mes".
export function textoRestante(reg, ahoraMs, limite = LIMITE_RELEVO_MS) {
  if (agotado(reg, ahoraMs, limite)) return 'Ya no te quedan minutos de llamadas este mes';
  return 'Te quedan ' + minutosRestantes(reg, ahoraMs, limite) + ' min de llamadas este mes';
}

// Frase por medio, con el límite que le toca: voz 20 min, video 5 min.
// "Te quedan X min de llamadas de voz este mes" /
// "Te quedan X min de videollamadas este mes" (o el "Ya no te quedan…"
// de cada uno). La app muestra las dos líneas en Ajustes → Llamadas.
export function textoRestanteMedia(reg, ahoraMs, media) {
  const limite = limiteParaMedia(media);
  if (agotado(reg, ahoraMs, limite)) {
    return media === 'video'
      ? 'Ya no te quedan minutos de videollamadas este mes'
      : 'Ya no te quedan minutos de llamadas de voz este mes';
  }
  return media === 'video'
    ? 'Te quedan ' + minutosRestantes(reg, ahoraMs, limite) + ' min de videollamadas este mes'
    : 'Te quedan ' + minutosRestantes(reg, ahoraMs, limite) + ' min de llamadas de voz este mes';
}

// ---- ¿la llamada va por relevo? ----
// Lee un reporte de estadísticas WebRTC (el de pc.getStats(): un
// Map, o cualquier iterable/forEach de objetos con .type) y devuelve
// el tipo del candidato local del par seleccionado:
// 'relay' | 'host' | 'srflx' | 'prflx' | null si no se puede saber.
// Solo el par seleccionado cuenta: prefiere el marcado `selected`
// (spec nuevo) y si no, el primer par en estado `succeeded`.
export function tipoDelParSeleccionado(stats) {
  if (!stats) return null;
  const lista = [];
  if (Array.isArray(stats)) lista.push(...stats);
  else if (typeof stats.forEach === 'function') stats.forEach((v) => lista.push(v));
  else if (typeof stats.values === 'function') for (const v of stats.values()) lista.push(v);
  else return null;
  const locales = new Map();
  for (const s of lista) {
    if (s && s.type === 'local-candidate' && s.id) locales.set(s.id, s.candidateType);
  }
  let elegido = null;
  for (const s of lista) {
    if (s && s.type === 'candidate-pair' && s.selected === true) { elegido = s; break; }
  }
  if (!elegido) {
    for (const s of lista) {
      if (s && s.type === 'candidate-pair' && s.state === 'succeeded') { elegido = s; break; }
    }
  }
  if (!elegido || !elegido.localCandidateId) return null;
  const tipo = locales.get(elegido.localCandidateId);
  return typeof tipo === 'string' && tipo ? tipo : null;
}
