// CUBMATCH — motor de matching v2.1, 100% en cliente.
// Puro (sin DOM): testeable en Node. ES module.
//
// Modelo v2 (rediseño para pools pequeños): el v1 fallaba por EXCLUSIÓN —
// seis filtros duros mutuos se multiplicaban y la gente se quedaba sin
// candidatos. Ahora:
//   · Filtros duros MÍNIMOS (hardPass): no soy yo, no bloqueado, ambos ≥18,
//     género mutuo y tipo de relación en común. Nada más excluye.
//   · Todo lo demás son factores BLANDOS que multiplican el score:
//       score = gate · (0.35·afinidad + 0.25·ajuste mutuo + 0.15·geo
//                       + 0.10·actividad + 0.15·interés) + jitter
//     gate = gate de completitud (min de ambos): <0.40 → 0 (no aparece).
//   · La afinidad compara SOLO campos que ambos llenaron (el vacío es
//     neutro y los pesos se renormalizan), con texto normalizado sin
//     acentos, stemming ligero ("bailar" ≈ "baile") e idf suavizado.
//   · Quien ya me dio like NO compite en el mazo: va a la fila
//     "Le gustas" (likesYou), que solo exige los filtros duros.
//   · Los dislikes reaparecen a los 21 días; los likes enviados, nunca.
//   · Pool pequeño (<30): se reintenta con suelo 0.25 y tolerancia de
//     edad 10, marcado como relajado.
//   · Pool diminuto (<15 tras relajar): último recurso — suelo 0,
//     tolerancia de edad 15 y el tipo de relación deja de excluir (se
//     penaliza ×0.6). Siempre se muestra como «Explorar».
//   · Jitter determinista ±0.05 (semilla: día + ambas pubkeys) contra el
//     estancamiento: mismo orden todo el día para mí, distinto mañana.
//
// Cambios v2.1 respecto a v2:
//   · FIX reciprocity(): un dislike enviado ya NO cuenta como interés
//     (antes daba +0.3 a los dislikes que reaparecían a los 21 días).
//   · El 5º factor (clave `rec`, peso 0.15) es ahora la "señal de
//     interés": 1.0 si me dio like, 0.3 si yo le di like y, para el
//     resto (todo el mazo, ya que esos dos casos salen de él), la
//     PREFERENCIA APRENDIDA de mis propios swipes (buildPrefModel).
//     Antes valía 0 para todos los candidatos del mazo.
//   · La preferencia aprendida es 100% local: usa solo ctx.likes.sent y
//     los perfiles ya descargados. Entra con ≥5 swipes y pesa por
//     completo desde 25.
//   · Actividad: si el llamador aporta ctx.ultimaActividad
//     {pubkey: ts_seg} (presencia, último like/DM) se usa el más
//     reciente entre eso y el created_at del perfil (que es solo la
//     última EDICIÓN del perfil).

import { completitud, nivelDistancia } from './perfil.js';

// Pesos de la fórmula v2. Suman 1.0.
// `reciprocity` es el peso de la señal de interés (ver cabecera).
export const WEIGHTS_V2 = { affinity: 0.35, mutual: 0.25, geo: 0.15, activity: 0.10, reciprocity: 0.15 };

export const GATE_FLOOR = 0.4;          // suelo de completitud normal
export const GATE_FLOOR_RELAXED = 0.25; // suelo con pool pequeño
export const POOL_MIN = 30;             // por debajo → relajación
export const POOL_BAJO = 15;            // por debajo tras relajar → modo mínimo
export const TOL_EDAD = 5;              // años de decaimiento de ageFit
export const TOL_EDAD_RELAXED = 10;
export const TOL_EDAD_MINIMA = 15;
export const DIAS_REAPARICION = 21;     // los dislikes vuelven a los 21 días
export const JITTER_MAX = 0.05;
export const REL_PENALIZACION = 0.6;    // sin tipo de relación en común (modo mínimo)

// Aprendizaje local de preferencias.
export const MIN_SWIPES = 5;            // swipes mínimos para activar el modelo
export const SWIPES_PLENO = 25;         // con ≥25 swipes pesa al 100 %
export const PREF_SEMIVIDA_DIAS = 90;   // un swipe pesa la mitad a los 90 días
export const PREF_PESO_DISLIKE = 0.6;   // el dislike es una señal más ruidosa
export const PREF_PESO_SUPERLIKE = 1.5;
export const PREF_CONTRACCION = 3;      // evidencia mínima antes de fiarse

const DIA_SEC = 86400;
const REAPARICION_SEC = DIAS_REAPARICION * DIA_SEC;

// ------------------------------------------------------------ utilidades

// Normaliza texto para comparar: minúsculas, sin acentos (NFD y fuera
// marcas diacríticas) — "Música" y "musica" cruzan.
export function normTerm(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

// Stemming ligero para texto libre (intereses/tags): quita plural,
// infinitivo/gerundio y la vocal final, de modo que "bailar", "baile",
// "bailes" y "bailando" caen en "bail". Solo para comparar TEXTO LIBRE;
// los campos categóricos (religión, hábitos…) siguen usando normTerm.
// Palabras de ≤4 letras no se tocan.
function stemPalabra(w) {
  if (w.length <= 4) return w;
  let s = w;
  if (s.endsWith('es') && s.length > 5) s = s.slice(0, -2);
  else if (s.endsWith('s')) s = s.slice(0, -1);
  for (const suf of ['iendo', 'ando', 'ar', 'er', 'ir']) {
    if (s.endsWith(suf) && s.length - suf.length >= 3) return s.slice(0, -suf.length);
  }
  if (s.length > 4 && 'aeo'.includes(s[s.length - 1])) s = s.slice(0, -1);
  return s;
}

export function stemTerm(raw) {
  return normTerm(raw).split(/\s+/).filter(Boolean).map(stemPalabra).join(' ');
}

// Hash determinista FNV-1a (32 bits) — semilla del jitter diario.
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Similitud coseno. 0 si algún vector tiene norma 0.
export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function nowMsOf(ctx) {
  if (ctx && typeof ctx.nowMs === 'number') return ctx.nowMs;
  if (ctx && typeof ctx.nowSec === 'number') return ctx.nowSec * 1000;
  return Date.now();
}
function nowSecOf(ctx) { return Math.floor(nowMsOf(ctx) / 1000); }
function diaDe(nowMs) { return new Date(nowMs).toISOString().slice(0, 10); }

// ------------------------------------------------------- filtros duros

// ¿Comparten al menos un tipo de relación buscado?
export function relacionEnComun(mp, op) {
  const a = (mp && mp.prefs && mp.prefs.relacion) || [];
  const b = (op && op.prefs && op.prefs.relacion) || [];
  return a.some((r) => b.includes(r));
}

// SOLO incompatibilidades reales: identidad, bloqueo, mayoría de edad,
// género mutuo y tipo de relación en común. La completitud, la edad
// exacta, la distancia y el "ya visto" ya NO excluyen: pesan en el score.
// opts.relajarRelacion: el tipo de relación deja de excluir (solo se usa
// en el modo mínimo de rankCandidates; score() lo penaliza).
export function hardPass(me, other, opts = {}) {
  if (!me || !other || !me.profile || !other.profile) return false;
  if (other.pubkey === me.pubkey) return false;
  if ((me.bloqueados || []).includes(other.pubkey)) return false;

  const mp = me.profile, op = other.profile;

  // Ambos mayores de edad.
  if (!(Number(mp.edad) >= 18) || !(Number(op.edad) >= 18)) return false;

  // Género mutuo (con esto basta: toda pareja incompatible por
  // orientación queda fuera porque el género buscado no coincidirá).
  const prefsMe = mp.prefs || {}, prefsOther = op.prefs || {};
  if (!(prefsMe.generos || []).includes(op.genero)) return false;
  if (!(prefsOther.generos || []).includes(mp.genero)) return false;

  // Relación: intersección no vacía.
  if (!opts.relajarRelacion && !relacionEnComun(mp, op)) return false;

  return true;
}

// ------------------------------------------------- factores blandos

// Gate de completitud: c = min(la mía, la suya) como fracción 0..1.
// Por debajo del suelo → 0 (no aparece); por encima, 0.5 + 0.5·c.
export function gateCompletitud(cMe, cOther, floor = GATE_FLOOR) {
  const c = Math.min(Number(cMe) || 0, Number(cOther) || 0) / 100;
  return c < floor ? 0 : 0.5 + 0.5 * c;
}

// Ajuste de edad: 1 dentro del rango; fuera, decae linealmente a 0
// en `tol` años. rango: [min, max] o {edadMin, edadMax}.
export function ageFit(edad, rango, tol = TOL_EDAD) {
  const a = Number(edad);
  if (!Number.isFinite(a)) return 0;
  let min, max;
  if (Array.isArray(rango)) { min = Number(rango[0]); max = Number(rango[1]); }
  else if (rango) { min = Number(rango.edadMin); max = Number(rango.edadMax); }
  if (!Number.isFinite(min)) min = 18;
  if (!Number.isFinite(max)) max = 99;
  if (min > max) { const t = min; min = max; max = t; }
  if (a >= min && a <= max) return 1;
  const fuera = a < min ? min - a : a - max;
  return Math.max(0, 1 - fuera / Math.max(1, tol));
}

// Ajuste de distancia: 1.0 mismo municipio, 0.7 misma provincia,
// 0.5 provincia vecina, 0.3 resto.
export function distFit(pa, pb) {
  const munA = normTerm(pa && pa.municipio), munB = normTerm(pb && pb.municipio);
  if (munA && munB && munA === munB) return 1.0;
  if (pa && pb && pa.provincia && pa.provincia === pb.provincia) return 0.7;
  if (nivelDistancia(pa && pa.provincia, pb && pb.provincia) === 1) return 0.5;
  return 0.3;
}

function rangoEdadDe(profile) {
  const prefs = (profile && profile.prefs) || {};
  return [prefs.edadMin, prefs.edadMax];
}

// Cuánto encaja b en las preferencias (edad y distancia) de a.
export function fitAB(pa, pb, tol = TOL_EDAD) {
  return ageFit(pb && pb.edad, rangoEdadDe(pa), tol) * distFit(pa, pb);
}

// Ajuste mutuo: media geométrica de ambos sentidos — si en un sentido
// no encaja, el producto lo castiga aunque el otro sea perfecto.
export function mutualFit(pa, pb, tol = TOL_EDAD) {
  return Math.sqrt(fitAB(pa, pb, tol) * fitAB(pb, pa, tol));
}

// Actividad: exp(−(now − min(ts, now))/86400/45). Una fecha futura
// falsa NO da ventaja: ts se capa a `now` (máximo 1.0).
export function activityScore(created_at, nowSec) {
  const ts = Number(created_at) || 0;
  const now = Number(nowSec) || 0;
  const delta = Math.max(0, now - Math.min(ts, now));
  return Math.exp(-delta / DIA_SEC / 45);
}

// Reciprocidad de likes: 1.0 si el otro ya me dio '+'; 0.3 si yo le di
// '+'; 0.0 en cualquier otro caso. (v2.0 contaba también el dislike
// enviado como 0.3: un error, ya corregido.)
export function reciprocity(peerPubkey, likes) {
  const l = likes || { sent: {}, received: {} };
  const rec = l.received && l.received[peerPubkey];
  if (rec && rec.tipo === '+') return 1.0;
  const sent = l.sent && l.sent[peerPubkey];
  if (sent && sent.tipo === '+') return 0.3;
  return 0.0;
}

// Jitter anti-estancamiento: determinista por (día, mi pubkey, su
// pubkey), uniforme en [−0.05, +0.05). Mismo orden todo el día para
// mí; mañana cambia; para otro usuario el orden es otro.
export function jitterDiario(myPubkey, otherPubkey, dayStr) {
  const h = hash32(String(dayStr) + '|' + String(myPubkey) + '|' + String(otherPubkey));
  return (h / 4294967296) * 2 * JITTER_MAX - JITTER_MAX;
}

// ---------------------------------------------------------- afinidad

// Términos de un perfil: valores + intereses + tags, normalizados sin
// acentos, con stemming y sin duplicados dentro del perfil.
function termsOf(profile) {
  const set = new Set();
  for (const arr of [profile.valores, profile.intereses, profile.tags]) {
    for (const t of (arr || [])) {
      const s = stemTerm(t);
      if (s) set.add(s);
    }
  }
  return [...set];
}

// Corpus TF-IDF: df = nº de perfiles que contienen cada término
// (ya normalizado). n = total de perfiles del corpus.
export function buildCorpus(profiles) {
  const df = {};
  const list = profiles || [];
  for (const p of list) {
    for (const t of termsOf(p || {})) df[t] = (df[t] || 0) + 1;
  }
  return { df, n: list.length };
}

// idf suavizado para pools pequeños: ln((20+n)/(20+df)) + 1. Con pocos
// perfiles, un tag único ya no pesa al máximo ni domina el score.
export function idfSuavizado(df, n) {
  return Math.log((20 + (Number(n) || 0)) / (20 + (Number(df) || 0))) + 1;
}

// Similitud de texto libre (TF-IDF coseno sobre términos presentes).
// null si alguno de los dos no tiene términos (campo neutro).
function textoSim(pa, pb, corpus) {
  const ta = termsOf(pa), tb = termsOf(pb);
  if (!ta.length || !tb.length) return null;
  const df = (corpus && corpus.df) || {};
  const n = corpus && typeof corpus.n === 'number' ? corpus.n : 0;
  const setB = new Set(tb);
  let dot = 0, na = 0, nb = 0;
  for (const t of ta) {
    const w = idfSuavizado(df[t] || 0, n);
    na += w * w;
    if (setB.has(t)) dot += w * w;
  }
  for (const t of tb) {
    const w = idfSuavizado(df[t] || 0, n);
    nb += w * w;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const INTERMEDIOS = new Set(['ocasional', 'a veces', 'tal vez']);

// Categórico: 1 si coinciden, 0.5 si alguno es intermedio
// ('ocasional'/'a veces'/'tal vez'), 0 si difieren. null si alguno
// está vacío (neutro: no se compara).
function catSim(a, b) {
  const x = normTerm(a), y = normTerm(b);
  if (!x || !y) return null;
  if (x === y) return 1;
  if (INTERMEDIOS.has(x) || INTERMEDIOS.has(y)) return 0.5;
  return 0;
}

// Promedio de los pares comparables; null si ninguno lo es.
function promSim(pares) {
  const vals = pares.filter((v) => v !== null);
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

const RASGO_IDS = ['extroversion', 'amabilidad', 'responsabilidad', 'apertura', 'calma'];

// Rasgos "llenos": el usuario movió al menos un slider del neutro (3)
// — mismo criterio que completitud() en perfil.js.
function rasgosLlenos(r) {
  return !!r && RASGO_IDS.some((id) => Number(r[id]) !== 3);
}

// Personalidad: 1 − (distancia media absoluta entre rasgos)/4.
function rasgosSim(ra, rb) {
  if (!rasgosLlenos(ra) || !rasgosLlenos(rb)) return null;
  let s = 0;
  for (const id of RASGO_IDS) s += Math.abs((Number(ra[id]) || 3) - (Number(rb[id]) || 3));
  return 1 - (s / RASGO_IDS.length) / 4;
}

// Religión: texto libre normalizado (SIN buckets por hash: dos
// religiones distintas ya no colisionan). Igual → 1, distinta → 0,
// vacía en alguno → null.
function religionSim(pa, pb) {
  const x = normTerm(pa.religion), y = normTerm(pb.religion);
  if (!x || !y) return null;
  return x === y ? 1 : 0;
}

// Pesos base de cada componente de afinidad. Solo cuentan los
// componentes comparables (ambos perfiles llenaron el campo) y los
// pesos se renormalizan sobre los presentes: el vacío es neutro.
const AFFINITY_W = { texto: 3, habitos: 2, rasgos: 2, hijos: 1.5, religion: 1, mascotas: 0.5 };

// Afinidad entre dos perfiles: valores, intereses, tags, hábitos,
// religión, hijos, mascotas y personalidad. Sin ningún campo
// comparable → 0.5 (neutro; el gate ya castiga perfiles vacíos).
export function affinity(pa, pb, corpus) {
  const a = pa || {}, b = pb || {};
  const comps = [];
  const add = (w, v) => { if (v !== null && v !== undefined && Number.isFinite(v)) comps.push([w, v]); };
  add(AFFINITY_W.texto, textoSim(a, b, corpus));
  add(AFFINITY_W.habitos, promSim([catSim(a.fumador, b.fumador), catSim(a.bebedor, b.bebedor), catSim(a.deporte, b.deporte)]));
  add(AFFINITY_W.rasgos, rasgosSim(a.rasgos, b.rasgos));
  add(AFFINITY_W.hijos, promSim([catSim(a.hijosTiene, b.hijosTiene), catSim(a.hijosQuiere, b.hijosQuiere)]));
  add(AFFINITY_W.religion, religionSim(a, b));
  add(AFFINITY_W.mascotas, catSim(a.mascotas, b.mascotas));
  if (!comps.length) return 0.5;
  const tw = comps.reduce((s, [w]) => s + w, 0);
  return comps.reduce((s, [w, v]) => s + w * v, 0) / tw;
}

// ------------------------------------------------ preferencia aprendida

// Campos categóricos que también alimentan el modelo aprendido.
const CAMPOS_CAT = ['fumador', 'bebedor', 'deporte', 'hijosQuiere', 'religion', 'mascotas'];

// Rasgos de un perfil para el modelo: sus términos (stemmed) y sus
// valores categóricos ("cat:fumador=no").
function featuresOf(profile) {
  const p = profile || {};
  const out = termsOf(p);
  for (const c of CAMPOS_CAT) {
    const v = normTerm(p[c]);
    if (v) out.push(`cat:${c}=${v}`);
  }
  return out;
}

// Modelo de preferencia aprendido de MIS swipes (100 % local).
//   likesSent: ctx.likes.sent {pubkey: {tipo:'+'|'-', ts, superlike?}}
//   others:    perfiles ya descargados [{pubkey, profile}]
// Cada swipe suma (like) o resta (dislike, con menos peso) a cada
// rasgo del perfil al que se lo di, con decaimiento de 90 días de
// semivida. avg[rasgo] ∈ [−1, 1] se contrae hacia 0 cuando hay poca
// evidencia. Devuelve { n, avg }; n = swipes con perfil conocido.
export function buildPrefModel(others, likesSent, ctx) {
  const porPk = new Map();
  for (const o of others || []) if (o && o.pubkey && o.profile) porPk.set(o.pubkey, o);
  const nowSec = nowSecOf(ctx);
  const suma = {}, abs = {};
  let n = 0;
  for (const [pk, s] of Object.entries(likesSent || {})) {
    const o = porPk.get(pk);
    if (!o || !s || (s.tipo !== '+' && s.tipo !== '-')) continue;
    n++;
    const dias = Math.max(0, (nowSec - (Number(s.ts) || nowSec)) / DIA_SEC);
    const decay = Math.pow(0.5, dias / PREF_SEMIVIDA_DIAS);
    const signo = s.tipo === '+' ? (s.superlike ? PREF_PESO_SUPERLIKE : 1) : -PREF_PESO_DISLIKE;
    for (const f of featuresOf(o.profile)) {
      suma[f] = (suma[f] || 0) + signo * decay;
      abs[f] = (abs[f] || 0) + decay;
    }
  }
  const avg = {};
  for (const f of Object.keys(suma)) {
    avg[f] = Math.max(-1, Math.min(1, suma[f] / (abs[f] + 1)));
  }
  return { n, avg };
}

// Cuánto se parece `profile` a lo que me ha gustado: 0..1 (0.5 =
// neutro). null si no comparte ningún rasgo con mi historial.
export function prefScore(model, profile) {
  if (!model || !model.avg) return null;
  let s = 0, m = 0;
  for (const f of featuresOf(profile)) {
    const v = model.avg[f];
    if (v === undefined) continue;
    s += v;
    m++;
  }
  if (!m) return null;
  const x = Math.max(-1, Math.min(1, s / (m + PREF_CONTRACCION)));
  return (x + 1) / 2;
}

// Señal de interés (5º factor, clave `rec`): reciprocidad explícita si
// existe; si no, la preferencia aprendida, escalada por cuántos swipes
// hay (0 hasta MIN_SWIPES, 100 % desde SWIPES_PLENO).
export function interestSignal(other, ctx) {
  const r = reciprocity(other && other.pubkey, ctx && ctx.likes);
  if (r > 0) return r;
  const m = ctx && ctx.prefModel;
  if (!m || !(m.n >= MIN_SWIPES)) return 0;
  const g = Math.min(1, m.n / SWIPES_PLENO);
  const p = prefScore(m, other && other.profile);
  return g * (p === null ? 0.5 : p);
}

// ------------------------------------------------------- vistos/likes

// ¿Debe ocultarse este perfil del mazo por "ya visto"?
//  · Like que yo envié ('+' en mis kind 7): NUNCA reaparece.
//  · Dislike ('−'): reaparece tras DIAS_REAPARICION días (ts = el
//    created_at de mi propio evento kind 7).
//  · Respaldo local: mapa de vistos {pubkey: ts} de este dispositivo
//    (solo si la red no dice nada de ese peer).
export function ocultoPorVisto(me, other, ctx) {
  const pk = other && other.pubkey;
  if (!pk) return false;
  const nowSec = nowSecOf(ctx);
  const sent = ctx && ctx.likes && ctx.likes.sent && ctx.likes.sent[pk];
  if (sent) {
    if (sent.tipo === '+') return true;
    if (sent.tipo === '-') return nowSec - (Number(sent.ts) || 0) < REAPARICION_SEC;
  }
  const vistos = me && me.vistos;
  if (vistos && typeof vistos === 'object' && !Array.isArray(vistos)) {
    const ts = Number(vistos[pk]);
    if (Number.isFinite(ts) && ts > 0) return nowSec - ts < REAPARICION_SEC;
  }
  return false;
}

// Fila "Le gustas": perfiles que ya me dieron like '+' y pasan los
// filtros DUROS (se saltan todos los factores blandos). Excluye a
// quien ya respondí (like mío → ya es match; dislike reciente →
// oculto). Orden: like recibido más reciente primero.
// Devuelve [{ other, ts }].
export function likesYou(me, others, ctx) {
  const received = (ctx && ctx.likes && ctx.likes.received) || {};
  const res = [];
  for (const other of others || []) {
    const rec = received[other.pubkey];
    if (!rec || rec.tipo !== '+') continue;
    if (!hardPass(me, other)) continue;
    if (ocultoPorVisto(me, other, ctx)) continue;
    res.push({ other, ts: Number(rec.ts) || 0 });
  }
  res.sort((a, b) => b.ts - a.ts);
  return res;
}

// ------------------------------------------------------------ score

// Score v2.1 entre me y other.
// ctx = { corpus, likes: { sent, received }, nowMs, prefModel?, ultimaActividad? }
// opts = { floor, tol } (suelo de completitud y tolerancia de edad).
export function score(me, other, ctx, opts = {}) {
  const floor = typeof opts.floor === 'number' ? opts.floor : GATE_FLOOR;
  const tol = typeof opts.tol === 'number' ? opts.tol : TOL_EDAD;
  const gate = gateCompletitud(completitud(me.profile), completitud(other.profile), floor);
  const aff = affinity(me.profile, other.profile, ctx && ctx.corpus);
  const mut = mutualFit(me.profile, other.profile, tol);
  const geo = distFit(me.profile, other.profile);
  // Actividad: lo más reciente entre la última edición del perfil y,
  // si el llamador la aporta, la última actividad real (presencia/DM/like).
  const ultima = ctx && ctx.ultimaActividad ? Number(ctx.ultimaActividad[other.pubkey]) : NaN;
  const ts = Math.max(Number(other.created_at) || 0, Number.isFinite(ultima) ? ultima : 0);
  const act = activityScore(ts, nowSecOf(ctx));
  const rec = interestSignal(other, ctx);
  const parts = { affinity: aff, mutual: mut, geo, act, rec };
  let base = WEIGHTS_V2.affinity * aff + WEIGHTS_V2.mutual * mut + WEIGHTS_V2.geo * geo
    + WEIGHTS_V2.activity * act + WEIGHTS_V2.reciprocity * rec;
  // Sin tipo de relación en común (solo alcanzable en el modo mínimo,
  // donde hardPass ya no lo exige): castigo suave en vez de exclusión.
  if (!relacionEnComun(me.profile, other.profile)) base *= REL_PENALIZACION;
  const jitter = jitterDiario(me.pubkey, other.pubkey, diaDe(nowMsOf(ctx)));
  const total = gate * base + jitter;
  return { total, base, gate, parts };
}

// Etiqueta visible de compatibilidad (sustituye al %): Alta ≥0.65,
// Media 0.4–0.65, Explorar <0.4 o si el pool fue relajado.
export function compatLabel(total, relajado = false) {
  if (relajado) return 'Explorar';
  const t = Number(total) || 0;
  if (t >= 0.65) return 'Alta';
  if (t >= 0.4) return 'Media';
  return 'Explorar';
}

// ----------------------------------------------------------- ranking

// Añade el modelo de preferencia aprendida al ctx (una sola vez por
// ranking) si hay swipes enviados y el llamador no aportó uno propio.
function conModelo(ctx, others) {
  const c = ctx || {};
  if (c.prefModel) return c;
  const sent = c.likes && c.likes.sent;
  if (!sent || !Object.keys(sent).length) return c;
  return { ...c, prefModel: buildPrefModel(others, sent, c) };
}

function rankWith(me, others, ctx, opts) {
  const received = (ctx && ctx.likes && ctx.likes.received) || {};
  const res = [];
  for (const other of others || []) {
    if (!hardPass(me, other, { relajarRelacion: !!opts.relajarRelacion })) continue;
    // Quien ya me dio like va en "Le gustas", no compite en el mazo.
    if (received[other.pubkey] && received[other.pubkey].tipo === '+') continue;
    if (ocultoPorVisto(me, other, ctx)) continue;
    const s = score(me, other, ctx, opts);
    if (s.gate <= 0) continue;
    res.push({ other, total: s.total, parts: s.parts, gate: s.gate, relajado: !!opts.relajado });
  }
  res.sort((a, b) => b.total - a.total);
  res.relajado = !!opts.relajado;
  res.nivel = opts.nivel || (opts.relajado ? 2 : 1);
  return res;
}

// Candidatos del mazo: filtros duros + factores blandos, ordenados
// por score descendente. Tres niveles (propiedad `nivel` del array):
//   1 normal      — pool ≥ POOL_MIN
//   2 relajado    — suelo 0.25, tolerancia de edad 10
//   3 mínimo      — pool < POOL_BAJO incluso relajado: suelo 0,
//                   tolerancia 15 y la relación solo penaliza
// Un nivel más laxo solo se adopta si realmente amplía el pool; entonces
// el resultado se marca `relajado` (propiedad del array y de cada candidato).
export function rankCandidates(me, others, ctx) {
  const c = conModelo(ctx, others);
  const normal = rankWith(me, others, c, { floor: GATE_FLOOR, tol: TOL_EDAD, relajado: false, nivel: 1 });
  if (normal.length >= POOL_MIN) return normal;
  const relajado = rankWith(me, others, c, { floor: GATE_FLOOR_RELAXED, tol: TOL_EDAD_RELAXED, relajado: true, nivel: 2 });
  const mejor = relajado.length > normal.length ? relajado : normal;
  if (mejor.length >= POOL_BAJO) return mejor;
  const minimo = rankWith(me, others, c, {
    floor: 0, tol: TOL_EDAD_MINIMA, relajado: true, relajarRelacion: true, nivel: 3,
  });
  return minimo.length > mejor.length ? minimo : mejor;
}

// Los n mejores del día (por defecto 10).
export function topDaily(me, others, ctx, n = 10) {
  return rankCandidates(me, others, ctx).slice(0, n);
}
