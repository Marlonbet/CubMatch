// CUBMATCH — motor de matching 100% en cliente.
// Puro (sin DOM): testeable en Node. ES module.
//
// Modelo: filtros duros (hardPass) + score ponderado de 6 componentes:
//   simPP    — similitud coseno entre los vectores "yo" de ambos
//   simPPref — cuánto se parece "yo" a lo que el otro busca
//   simPrefP — cuánto se parece el otro a lo que "yo" busco
//   geo      — cercanía geográfica (municipio > provincia > resto)
//   act      — frescura de la cuenta (decaimiento exponencial)
//   rec      — reciprocidad de likes

import {
  nivelDistancia, NIVEL_DISTANCIA_MAX, MIN_COMPLETITUD, completitud,
  PROVINCIAS, VECINAS, EDUCACION,
} from './perfil.js';

// Pesos por defecto del score. Suman 1.0.
export const WEIGHTS_DEFAULT = { w1: 0.3, w2: 0.2, w3: 0.2, w4: 0.15, w5: 0.05, w6: 0.1 };

// Dimensiones fijas de vectorize (índices 0..70); el TF-IDF empieza en 71.
const DIM_FIJA = 71;

// ---------------------------------------------------------------- filtros duros

// Pasa SOLO si ambos perfiles son mutuamente compatibles en los criterios
// no negociables: identidad, bloqueo/visto, completitud, edad, género,
// distancia y tipo de relación.
export function hardPass(me, other) {
  if (!me || !other || !me.profile || !other.profile) return false;
  if (other.pubkey === me.pubkey) return false;
  if ((me.bloqueados || []).includes(other.pubkey)) return false;
  if ((me.vistos || []).includes(other.pubkey)) return false;
  if (completitud(me.profile) < MIN_COMPLETITUD) return false;
  if (completitud(other.profile) < MIN_COMPLETITUD) return false;

  const mp = me.profile, op = other.profile;
  const prefsMe = mp.prefs || {}, prefsOther = op.prefs || {};

  // Edad mutua (comparada como números).
  const edadMe = Number(mp.edad), edadOther = Number(op.edad);
  if (!(edadOther >= Number(prefsMe.edadMin) && edadOther <= Number(prefsMe.edadMax))) return false;
  if (!(edadMe >= Number(prefsOther.edadMin) && edadMe <= Number(prefsOther.edadMax))) return false;

  // Género mutuo.
  if (!(prefsMe.generos || []).includes(op.genero)) return false;
  if (!(prefsOther.generos || []).includes(mp.genero)) return false;

  // Distancia mutua: cada uno con su propio nivel máximo.
  const maxMe = NIVEL_DISTANCIA_MAX[prefsMe.distancia];
  const maxOther = NIVEL_DISTANCIA_MAX[prefsOther.distancia];
  if (maxMe === undefined || nivelDistancia(mp.provincia, op.provincia) > maxMe) return false;
  if (maxOther === undefined || nivelDistancia(op.provincia, mp.provincia) > maxOther) return false;

  // Relación: intersección no vacía.
  const relMe = prefsMe.relacion || [], relOther = prefsOther.relacion || [];
  if (!relMe.some((r) => relOther.includes(r))) return false;

  return true;
}

// ---------------------------------------------------------------- vectores

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

// Términos de un perfil: valores + intereses + tags, en minúsculas y trim,
// sin duplicados dentro del perfil.
function termsOf(profile) {
  const set = new Set();
  for (const arr of [profile.valores, profile.intereses, profile.tags]) {
    for (const t of (arr || [])) {
      const s = String(t).trim().toLowerCase();
      if (s) set.add(s);
    }
  }
  return [...set];
}

// Construye el corpus TF-IDF: df = nº de perfiles que contienen cada término.
export function buildCorpus(profiles) {
  const df = {};
  const list = profiles || [];
  for (const p of list) {
    for (const t of termsOf(p || {})) df[t] = (df[t] || 0) + 1;
  }
  return { df, n: list.length };
}

// Vocabulario del corpus: unión de términos ordenada alfabéticamente.
function vocabOf(corpus) {
  return corpus && corpus.df ? Object.keys(corpus.df).sort() : [];
}

function oneHot(idx, len) {
  const v = new Array(len).fill(0);
  if (idx >= 0 && idx < len) v[idx] = 1;
  return v;
}

// One-hot case-insensitive; valores desconocidos/vacíos → todo ceros.
function oneHotOf(value, options) {
  const norm = String(value ?? '').trim().toLowerCase();
  const idx = options.findIndex((o) => String(o).toLowerCase() === norm);
  return oneHot(idx, options.length);
}

// Par [sí, no]: 'ocasional'/'a veces' → [0.5, 0.5], vacío/desconocido → [0, 0].
function parSiNo(value, intermedio) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'sí' || v === 'si') return [1, 0];
  if (v === 'no') return [0, 1];
  if (intermedio && v === intermedio) return [0.5, 0.5];
  return [0, 0];
}

// Hash determinista FNV-1a (32 bits) para el bucket de religión.
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Religión → one-hot de 4 buckets por hash del texto en minúsculas; vacío → ceros.
function religionBucket(religion) {
  const t = String(religion ?? '').trim().toLowerCase();
  const v = [0, 0, 0, 0];
  if (t) v[hash32(t) % 4] = 1;
  return v;
}

// Vector "yo soy" de un perfil. Dimensión fija 71 + vocabulario TF-IDF del corpus.
// Orden exacto:
//   0-2   género [mujer, hombre, nobinario]
//   3-5   orientación [hetero, homo, bi]
//   6     edad/100
//   7-22  provincia one-hot (orden de PROVINCIAS)
//   23-26 complexión [Delgada, Atlética, Promedio, Robusta]
//   27-31 ojos [Marrones, Negros, Verdes, Azules, Miel]
//   32-35 piel [Clara, Trigueña, Morena, Negra]
//   36-41 cabello [Negro, Castaño, Rubio, Pelirrojo, Canoso, Rapado]
//   42-47 educación (orden de EDUCACION)
//   48    estatura (cm-140)/70 con clamp 0..1; 0 si vacía
//   49-50 fumador [sí, no] ('ocasional' → [0.5, 0.5])
//   51-52 bebedor [sí, no] (igual)
//   53-54 deporte [sí, no] ('a veces' → [0.5, 0.5])
//   55-58 religión → bucket por hash (4 one-hot); vacío → ceros
//   59-60 hijosTiene [sí, no]
//   61-63 hijosQuiere [sí, no, tal vez]
//   64-65 mascotas [sí, no]
//   66-70 rasgos/5 [extroversion, amabilidad, responsabilidad, apertura, calma]
//   71..  TF-IDF: tf (0/1) * idf, idf = ln((1+n)/(1+df)) + 1
export function vectorize(profile, corpus) {
  const p = profile || {};
  const v = [];
  v.push(...oneHotOf(p.genero, ['mujer', 'hombre', 'nobinario']));       // 0-2
  v.push(...oneHotOf(p.orientacion, ['hetero', 'homo', 'bi']));          // 3-5
  const edad = Number(p.edad);
  v.push(edad > 0 ? edad / 100 : 0);                                     // 6
  v.push(...oneHotOf(p.provincia, PROVINCIAS));                          // 7-22
  v.push(...oneHotOf(p.complexion, ['Delgada', 'Atlética', 'Promedio', 'Robusta'])); // 23-26
  v.push(...oneHotOf(p.ojos, ['Marrones', 'Negros', 'Verdes', 'Azules', 'Miel']));   // 27-31
  v.push(...oneHotOf(p.piel, ['Clara', 'Trigueña', 'Morena', 'Negra'])); // 32-35
  v.push(...oneHotOf(p.cabello, ['Negro', 'Castaño', 'Rubio', 'Pelirrojo', 'Canoso', 'Rapado'])); // 36-41
  v.push(...oneHotOf(p.educacion, EDUCACION));                            // 42-47
  const est = Number(p.estatura);
  v.push(est > 0 ? Math.min(1, Math.max(0, (est - 140) / 70)) : 0);       // 48
  v.push(...parSiNo(p.fumador, 'ocasional'));                            // 49-50
  v.push(...parSiNo(p.bebedor, 'ocasional'));                            // 51-52
  v.push(...parSiNo(p.deporte, 'a veces'));                              // 53-54
  v.push(...religionBucket(p.religion));                                 // 55-58
  v.push(...parSiNo(p.hijosTiene, null));                                // 59-60
  v.push(...oneHotOf(p.hijosQuiere, ['sí', 'no', 'tal vez']));            // 61-63
  v.push(...parSiNo(p.mascotas, null));                                  // 64-65
  const rasgos = p.rasgos || {};
  for (const id of ['extroversion', 'amabilidad', 'responsabilidad', 'apertura', 'calma']) {
    const r = Number(rasgos[id]);
    v.push(r > 0 ? r / 5 : 0);                                           // 66-70
  }
  const vocab = vocabOf(corpus);
  const terms = new Set(termsOf(p));
  const n = corpus && typeof corpus.n === 'number' ? corpus.n : 0;
  const df = (corpus && corpus.df) || {};
  for (const t of vocab) {                                               // 71..
    const idf = Math.log((1 + n) / (1 + (df[t] || 0))) + 1;
    v.push(terms.has(t) ? idf : 0);
  }
  return v;
}

// Vector "lo que busco" de un perfil. Misma dimensión que vectorize:
// todo ceros excepto 0-2 (géneros buscados), 6 (edad media del rango)
// y 7-22 (provincias según prefs.distancia).
// `corpus` es opcional y solo sirve para igualar la dimensión del tramo
// TF-IDF (rellenado con ceros); score() siempre lo pasa para que el coseno
// compare vectores de igual longitud.
export function desiredVector(profile, corpus) {
  const p = profile || {};
  const v = new Array(DIM_FIJA).fill(0);
  const prefs = p.prefs || {};

  // 0-2: multi-hot de prefs.generos (1/k cada uno); vacío → uniforme 1/3.
  const gs = prefs.generos || [];
  const GEN = ['mujer', 'hombre', 'nobinario'];
  if (gs.length) {
    for (const g of gs) {
      const i = GEN.indexOf(String(g).trim().toLowerCase());
      if (i >= 0) v[i] += 1 / gs.length;
    }
  } else {
    v[0] = v[1] = v[2] = 1 / 3;
  }

  // 6: punto medio del rango de edad / 100.
  const eMin = Number(prefs.edadMin), eMax = Number(prefs.edadMax);
  if (eMin > 0 && eMax > 0) v[6] = ((eMin + eMax) / 2) / 100;

  // 7-22: provincias según prefs.distancia.
  const dist = prefs.distancia;
  if (dist === 'misma') {
    const i = PROVINCIAS.indexOf(p.provincia);
    if (i >= 0) v[7 + i] = 1;
  } else if (dist === 'vecinas') {
    const idxs = [p.provincia, ...(VECINAS[p.provincia] || [])]
      .map((x) => PROVINCIAS.indexOf(x))
      .filter((i) => i >= 0);
    if (idxs.length) for (const i of idxs) v[7 + i] = 1 / idxs.length;
  } else if (dist === 'cuba') {
    for (let i = 0; i < PROVINCIAS.length; i++) v[7 + i] = 1 / PROVINCIAS.length;
  }

  // Tramo TF-IDF: ceros, misma dimensión que vectorize.
  for (let i = 0; i < vocabOf(corpus).length; i++) v.push(0);
  return v;
}

// ---------------------------------------------------------------- componentes

// 1.0 mismo municipio (igual case-insensitive, no vacío);
// 0.7 misma provincia; 0.3 resto.
// Mejora futura: matriz de distancias reales entre provincias/municipios
// (p. ej. nivelDistancia como peso continuo en vez de estos 3 escalones).
export function geoScore(a, b) {
  const munA = String(a.municipio || '').trim().toLowerCase();
  const munB = String(b.municipio || '').trim().toLowerCase();
  if (munA && munB && munA === munB) return 1.0;
  if (a.provincia && b.provincia && a.provincia === b.provincia) return 0.7;
  return 0.3;
}

// Bonus por frescura de la cuenta: exp(-días/45), clamp 0..1.
// created_at en segundos (estilo Nostr), nowMs en milisegundos.
export function activityBonus(created_at, nowMs) {
  const dias = (nowMs - Number(created_at) * 1000) / 86400000;
  return Math.min(1, Math.max(0, Math.exp(-dias / 45)));
}

// Reciprocidad de likes: 1.0 si el otro ya me dio '+'; 0.3 si yo le di like;
// 0.0 si no hay nada.
export function reciprocity(peerPubkey, likes) {
  const l = likes || { sent: {}, received: {} };
  const rec = l.received && l.received[peerPubkey];
  if (rec && rec.tipo === '+') return 1.0;
  if (l.sent && l.sent[peerPubkey]) return 0.3;
  return 0.0;
}

// ---------------------------------------------------------------- score

// Score ponderado entre me y other.
// ctx = { corpus, likes: { sent, received }, nowMs }
export function score(me, other, ctx, weights = WEIGHTS_DEFAULT) {
  const w = weights || WEIGHTS_DEFAULT;
  const selfVec = (p) => vectorize(p, ctx.corpus);
  const desiredVec = (p) => desiredVector(p, ctx.corpus);
  const simPP = cosine(selfVec(me.profile), selfVec(other.profile));
  const simPPref = cosine(selfVec(me.profile), desiredVec(other.profile));
  const simPrefP = cosine(selfVec(other.profile), desiredVec(me.profile));
  const geo = geoScore(me.profile, other.profile);
  const act = activityBonus(other.created_at, ctx.nowMs);
  const rec = reciprocity(other.pubkey, ctx.likes);
  const parts = { simPP, simPPref, simPrefP, geo, act, rec };
  const total = w.w1 * simPP + w.w2 * simPPref + w.w3 * simPrefP
    + w.w4 * geo + w.w5 * act + w.w6 * rec;
  return { total, parts };
}

// Candidatos que pasan hardPass, con su score, ordenados por total descendente.
export function rankCandidates(me, others, ctx, weights) {
  const res = [];
  for (const other of others || []) {
    if (!hardPass(me, other)) continue;
    const { total, parts } = score(me, other, ctx, weights);
    res.push({ other, total, parts });
  }
  res.sort((a, b) => b.total - a.total);
  return res;
}

// Los n mejores del día (por defecto 10).
export function topDaily(me, others, ctx, weights, n = 10) {
  return rankCandidates(me, others, ctx, weights).slice(0, n);
}
