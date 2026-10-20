// Tests del motor de matching v2 — node:test + node:assert/strict.
// Fixtures deterministas (sin red, sin tiempo real: NOW fijo).
//
// Modelo v2: filtros duros mínimos + factores blandos multiplicativos.
//   score = gate · (0.35·afinidad + 0.25·mutual + 0.15·geo
//                   + 0.10·actividad + 0.15·reciprocidad) + jitter

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProfile, completitud } from '../src/perfil.js';
import {
  WEIGHTS_V2, GATE_FLOOR, GATE_FLOOR_RELAXED, POOL_MIN, DIAS_REAPARICION,
  normTerm, hardPass, gateCompletitud, ageFit, distFit, fitAB, mutualFit,
  activityScore, reciprocity, jitterDiario, buildCorpus, idfSuavizado,
  affinity, ocultoPorVisto, likesYou, score, compatLabel,
  rankCandidates, topDaily,
} from '../src/matching.js';

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00Z fijo
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DIA = 86400;
const key = (c) => String(c).repeat(32);

// Perfil completo (completitud alta) reutilizable.
function perfilCompleto(o = {}) {
  const p = newProfile();
  Object.assign(p, {
    apodo: 'Ana', edad: 25, genero: 'mujer', orientacion: 'hetero',
    provincia: 'La Habana', municipio: 'Vedado',
    estatura: 165, complexion: 'Atlética', ojos: 'Marrones', piel: 'Trigueña', cabello: 'Negro',
    educacion: 'Universitario', profesion: 'Médica', sector: 'Salud',
    fumador: 'no', bebedor: 'ocasional', deporte: 'sí', religion: 'Católica',
    hijosTiene: 'no', hijosQuiere: 'tal vez', mascotas: 'sí',
    valores: ['familia', 'humor', 'honestidad'], intereses: ['música', 'playa', 'cine'], tags: ['salsa'],
    bio: 'Hola, soy Ana.', tresPalabras: 'alegre sincera familiar',
    prompts: [{ q: 'Un domingo perfecto…', a: 'Playa con amigos' }],
    fotoURL: '', mostrarEdad: true,
    prefs: { edadMin: 22, edadMax: 35, generos: ['hombre'], distancia: 'cuba', relacion: ['romance', 'seria'] },
  }, o);
  return p;
}

const PREFS_CARLOS = { edadMin: 20, edadMax: 32, generos: ['mujer'], distancia: 'cuba', relacion: ['romance'] };

const ana = perfilCompleto();
const carlos = perfilCompleto({
  apodo: 'Carlos', edad: 28, genero: 'hombre',
  provincia: 'Santiago de Cuba', municipio: 'Centro',
  estatura: 178, complexion: 'Promedio', ojos: 'Negros', piel: 'Morena', cabello: 'Castaño',
  educacion: 'Técnico medio', profesion: 'Mecánico', sector: 'Transporte',
  valores: ['familia', 'humor', 'honestidad'], intereses: ['música', 'playa', 'cine'], tags: ['salsa'],
  prefs: PREFS_CARLOS,
});

const ANA_KEY = key('a'), CARLOS_KEY = key('b');
const me = { pubkey: ANA_KEY, profile: ana, bloqueados: [], vistos: {} };
const mkOther = (pubkey, profile, created_at = NOW_SEC - DIA) =>
  ({ pubkey, profile, created_at });
const otherCarlos = mkOther(CARLOS_KEY, carlos);
const ctx = { corpus: buildCorpus([ana, carlos]), likes: { sent: {}, received: {} }, nowMs: NOW_MS };

// ------------------------------------------------------------ normTerm

test('normTerm: quita acentos y pasa a minúsculas ("Música" = "musica")', () => {
  assert.equal(normTerm('Música'), 'musica');
  assert.equal(normTerm('  MÚSICA '), 'musica');
  assert.equal(normTerm('Sí'), 'si');
  assert.equal(normTerm(''), '');
  assert.equal(normTerm(null), '');
});

// ------------------------------------------------------------ hardPass (duros reducidos)

test('hardPass: caso base true (Ana ↔ Carlos)', () => {
  assert.equal(hardPass(me, otherCarlos), true);
});

test('hardPass: la edad FUERA de rango ya no excluye (es factor blando)', () => {
  const o = mkOther(key('c'), perfilCompleto({ apodo: 'Mayor', edad: 40, genero: 'hombre', prefs: PREFS_CARLOS }));
  assert.equal(hardPass(me, o), true); // Ana busca hasta 35, pero 40 pasa el duro
});

test('hardPass: la distancia ya no excluye aunque me exija "misma"', () => {
  const meMisma = { ...me, profile: perfilCompleto({ prefs: { ...ana.prefs, distancia: 'misma' } }) };
  assert.equal(hardPass(meMisma, otherCarlos), true); // La Habana vs Santiago
});

test('hardPass: la completitud baja ya no excluye (la castiga el gate)', () => {
  const casiVacio = newProfile();
  Object.assign(casiVacio, {
    apodo: 'Min', edad: 26, genero: 'hombre',
    prefs: { edadMin: 20, edadMax: 40, generos: ['mujer'], distancia: 'cuba', relacion: ['romance'] },
  });
  assert.ok(completitud(casiVacio) < 40);
  assert.equal(hardPass(me, mkOther(key('d'), casiVacio)), true);
});

test('hardPass: el "ya visto" ya no excluye', () => {
  assert.equal(hardPass({ ...me, vistos: { [CARLOS_KEY]: NOW_SEC } }, otherCarlos), true);
});

test('hardPass: false si alguno es menor de 18', () => {
  const menor = mkOther(key('e'), perfilCompleto({ apodo: 'Menor', edad: 17, genero: 'hombre', prefs: PREFS_CARLOS }));
  assert.equal(hardPass(me, menor), false);
  const meMenor = { ...me, profile: perfilCompleto({ edad: 16 }) };
  assert.equal(hardPass(meMenor, otherCarlos), false);
});

test('hardPass: false si el género no es mutuo', () => {
  const meSoloMujeres = { ...me, profile: perfilCompleto({ prefs: { ...ana.prefs, generos: ['mujer'] } }) };
  assert.equal(hardPass(meSoloMujeres, otherCarlos), false);
  const elNoMeBusca = mkOther(key('f'), perfilCompleto({
    apodo: 'X', edad: 28, genero: 'hombre',
    prefs: { ...PREFS_CARLOS, generos: ['hombre'] },
  }));
  assert.equal(hardPass(me, elNoMeBusca), false);
});

test('hardPass: false sin tipo de relación en común', () => {
  const p = perfilCompleto({ apodo: 'Amigo', edad: 28, genero: 'hombre', prefs: { ...PREFS_CARLOS, relacion: ['amistad'] } });
  assert.equal(hardPass(me, mkOther(key('g'), p)), false);
});

test('hardPass: false si está bloqueado o soy yo', () => {
  assert.equal(hardPass({ ...me, bloqueados: [CARLOS_KEY] }, otherCarlos), false);
  assert.equal(hardPass(me, mkOther(ANA_KEY, carlos)), false);
});

// ------------------------------------------------------------ gate

test('gateCompletitud: min de ambos; <0.40 → 0; 1.0 → 1.0', () => {
  assert.equal(gateCompletitud(100, 100), 1);
  assert.equal(gateCompletitud(90, 50), 0.5 + 0.5 * 0.5); // manda el menor (50)
  assert.equal(gateCompletitud(39, 100), 0);
  assert.equal(gateCompletitud(40, 100), 0.5 + 0.5 * 0.4);
  assert.equal(gateCompletitud(24, 100, GATE_FLOOR_RELAXED), 0);
  assert.equal(gateCompletitud(25, 100, GATE_FLOOR_RELAXED), 0.5 + 0.5 * 0.25);
});

// ------------------------------------------------------------ ageFit / distFit / mutual

test('ageFit: 1 dentro del rango; decae a 0 en tol años fuera', () => {
  assert.equal(ageFit(25, [22, 35]), 1);
  assert.equal(ageFit(22, [22, 35]), 1);
  assert.equal(ageFit(35, [22, 35]), 1);
  assert.equal(ageFit(40, [22, 35], 5), 0);            // 5 por encima → 0
  assert.ok(Math.abs(ageFit(37, [22, 35], 5) - 0.6) < 1e-9); // 2 por encima → 1−2/5
  assert.ok(Math.abs(ageFit(20, [22, 35], 5) - 0.6) < 1e-9); // 2 por debajo
  assert.ok(Math.abs(ageFit(40, [22, 35], 10) - 0.5) < 1e-9); // con tol 10 decae más lento
  assert.equal(ageFit('no-es-numero', [22, 35]), 0);
});

test('distFit: 1.0 municipio, 0.7 provincia, 0.5 vecina, 0.3 resto', () => {
  const a = { provincia: 'La Habana', municipio: 'Vedado' };
  assert.equal(distFit(a, { provincia: 'La Habana', municipio: 'vedado' }), 1.0); // case-insensitive
  assert.equal(distFit(a, { provincia: 'La Habana', municipio: 'Centro Habana' }), 0.7);
  assert.equal(distFit(a, { provincia: 'Artemisa', municipio: 'Artemisa' }), 0.5); // vecina de La Habana
  assert.equal(distFit(a, { provincia: 'Santiago de Cuba', municipio: 'Centro' }), 0.3);
});

test('mutualFit: media geométrica — un sentido en 0 tumba el total', () => {
  // Ana (25) encaja en el rango de Carlos (20-32) y Carlos (28) en el de Ana (22-35).
  const ambos = mutualFit(ana, carlos);
  assert.ok(ambos > 0);
  // Él tiene 40: para Ana (max 35, tol 5) ageFit=0 → mutual 0 aunque él la acepte.
  const viejo = perfilCompleto({ edad: 40, genero: 'hombre', prefs: PREFS_CARLOS });
  assert.equal(fitAB(ana, viejo), 0);
  assert.ok(fitAB(viejo, ana) > 0);
  assert.equal(mutualFit(ana, viejo), 0);
});

// ------------------------------------------------------------ actividad

test('activityScore: 1 recién creado; decae con los días', () => {
  assert.equal(activityScore(NOW_SEC, NOW_SEC), 1);
  const v30 = activityScore(NOW_SEC - 30 * DIA, NOW_SEC);
  assert.ok(v30 < 1 && v30 > 0.4, `v30=${v30}`); // exp(-30/45) ≈ 0.51
});

test('activityScore: fecha futura falsa se capa a ahora (nunca > 1)', () => {
  assert.equal(activityScore(NOW_SEC + 10 * DIA, NOW_SEC), 1);
  assert.ok(activityScore(NOW_SEC + DIA, NOW_SEC) <= 1);
});

// ------------------------------------------------------------ reciprocity

test('reciprocity: 1.0 si recibió "+", 0.3 si solo envió, 0.0 sin nada', () => {
  assert.equal(reciprocity('x', { sent: {}, received: { x: { tipo: '+' } } }), 1.0);
  assert.equal(reciprocity('x', { sent: { x: { tipo: '+' } }, received: {} }), 0.3);
  assert.equal(reciprocity('x', { sent: {}, received: {} }), 0.0);
});

// ------------------------------------------------------------ afinidad

test('affinity: perfiles idénticos → 1', () => {
  const corpus = buildCorpus([ana, carlos]);
  assert.ok(Math.abs(affinity(ana, perfilCompleto(), corpus) - 1) < 1e-9);
});

test('affinity: "Música" y "musica" cruzan (acentos normalizados)', () => {
  const a = perfilCompleto({ intereses: ['Música'], valores: [], tags: [] });
  const b = perfilCompleto({
    genero: 'hombre', intereses: ['musica'], valores: [], tags: [],
    fumador: '', bebedor: '', deporte: '', religion: '', hijosTiene: '', hijosQuiere: '', mascotas: '',
    rasgos: { extroversion: 3, amabilidad: 3, responsabilidad: 3, apertura: 3, calma: 3 },
  });
  // Solo el texto es comparable en b → la afinidad es la similitud de texto = 1.
  const corpus = buildCorpus([a, b]);
  assert.ok(Math.abs(affinity(a, b, corpus) - 1) < 1e-9);
});

test('affinity: el vacío es NEUTRO — no penaliza ni premia', () => {
  // b solo llena intereses (iguales a los de a) y deja todo lo demás vacío.
  const b = newProfile();
  Object.assign(b, { intereses: [...ana.intereses], valores: [...ana.valores], tags: [...ana.tags] });
  const corpus = buildCorpus([ana, b]);
  assert.ok(Math.abs(affinity(ana, b, corpus) - 1) < 1e-9,
    'si el vacío penalizara, la afinidad sería < 1');
  // Y sin NINGÚN campo comparable → 0.5 neutro.
  assert.equal(affinity(newProfile(), newProfile(), buildCorpus([])), 0.5);
});

test('affinity: categóricos — intermedio vale 0.5, distinto 0', () => {
  const base = { fumador: '', bebedor: '', deporte: '', religion: '', hijosTiene: '', hijosQuiere: '', mascotas: '', valores: [], intereses: [], tags: [], rasgos: { extroversion: 3, amabilidad: 3, responsabilidad: 3, apertura: 3, calma: 3 } };
  const fuma = { ...newProfile(), ...base, fumador: 'sí' };
  const ocasional = { ...newProfile(), ...base, fumador: 'ocasional' };
  const noFuma = { ...newProfile(), ...base, fumador: 'no' };
  const corpus = buildCorpus([]);
  assert.equal(affinity(fuma, ocasional, corpus), 0.5); // alguno intermedio
  assert.equal(affinity(fuma, noFuma, corpus), 0);      // difieren
  assert.equal(affinity(fuma, { ...fuma }, corpus), 1); // coinciden
});

test('affinity: religión distinta ya no colisiona por hash — vale 0', () => {
  const base = { fumador: '', bebedor: '', deporte: '', hijosTiene: '', hijosQuiere: '', mascotas: '', valores: [], intereses: [], tags: [], rasgos: { extroversion: 3, amabilidad: 3, responsabilidad: 3, apertura: 3, calma: 3 } };
  const cat = { ...newProfile(), ...base, religion: 'Católica' };
  const yor = { ...newProfile(), ...base, religion: 'Yoruba' };
  const corpus = buildCorpus([]);
  assert.equal(affinity(cat, yor, corpus), 0);
  assert.equal(affinity(cat, { ...cat, religion: 'catolica' }, corpus), 1);
});

test('affinity: rasgos — distancia media absoluta /4', () => {
  const base = { fumador: '', bebedor: '', deporte: '', religion: '', hijosTiene: '', hijosQuiere: '', mascotas: '', valores: [], intereses: [], tags: [] };
  const r1 = { ...newProfile(), ...base, rasgos: { extroversion: 5, amabilidad: 5, responsabilidad: 5, apertura: 5, calma: 5 } };
  const r2 = { ...newProfile(), ...base, rasgos: { extroversion: 1, amabilidad: 1, responsabilidad: 1, apertura: 1, calma: 1 } };
  assert.equal(affinity(r1, r2, buildCorpus([])), 0); // distancia 4 en todos → 1−4/4
  assert.equal(affinity(r1, { ...r1, rasgos: { ...r1.rasgos } }, buildCorpus([])), 1);
  // Rasgos sin tocar (todo 3) = no llenos → neutro (sin campos → 0.5)
  const r3 = { ...newProfile(), ...base };
  assert.equal(affinity(r1, r3, buildCorpus([])), 0.5);
});

test('idfSuavizado: con n pequeño un tag único no domina (vs idf clásico)', () => {
  const suav = idfSuavizado(1, 4);   // 1 de 4 perfiles
  const comun = idfSuavizado(4, 4); // todos
  assert.ok(Math.abs(suav - (Math.log(24 / 21) + 1)) < 1e-12);
  assert.ok(suav / comun < 1.2, `ratio=${suav / comun}`); // pesos parecidos
  assert.ok(Math.abs(idfSuavizado(0, 0) - 1) < 1e-12);
});

// ------------------------------------------------------------ jitter

test('jitterDiario: determinista, en ±0.05, cambia con el día y con el par', () => {
  const j1 = jitterDiario(ANA_KEY, CARLOS_KEY, '2026-01-15');
  assert.equal(j1, jitterDiario(ANA_KEY, CARLOS_KEY, '2026-01-15'));
  assert.ok(j1 >= -0.05 && j1 < 0.05, `j=${j1}`);
  // Algún otro día o algún otro par da un jitter distinto (no constante).
  const otros = [
    jitterDiario(ANA_KEY, CARLOS_KEY, '2026-01-16'),
    jitterDiario(CARLOS_KEY, ANA_KEY, '2026-01-15'),
    jitterDiario(ANA_KEY, key('z'), '2026-01-15'),
  ];
  assert.ok(otros.some((j) => j !== j1));
});

// ------------------------------------------------------------ vistos / reaparición

test('ocultoPorVisto: el like enviado NUNCA reaparece', () => {
  const likes = { sent: { [CARLOS_KEY]: { tipo: '+', ts: NOW_SEC - 60 * DIA } }, received: {} };
  assert.equal(ocultoPorVisto(me, otherCarlos, { ...ctx, likes }), true);
});

test('ocultoPorVisto: el dislike reaparece tras 21 días', () => {
  const reciente = { sent: { [CARLOS_KEY]: { tipo: '-', ts: NOW_SEC - 20 * DIA } }, received: {} };
  const viejo = { sent: { [CARLOS_KEY]: { tipo: '-', ts: NOW_SEC - (DIAS_REAPARICION + 1) * DIA } }, received: {} };
  assert.equal(ocultoPorVisto(me, otherCarlos, { ...ctx, likes: reciente }), true);
  assert.equal(ocultoPorVisto(me, otherCarlos, { ...ctx, likes: viejo }), false);
});

test('ocultoPorVisto: respaldo en el mapa local de vistos', () => {
  const meVisto = { ...me, vistos: { [CARLOS_KEY]: NOW_SEC - DIA } };
  assert.equal(ocultoPorVisto(meVisto, otherCarlos, ctx), true);
  const meVistoViejo = { ...me, vistos: { [CARLOS_KEY]: NOW_SEC - 30 * DIA } };
  assert.equal(ocultoPorVisto(meVistoViejo, otherCarlos, ctx), false);
  assert.equal(ocultoPorVisto(me, otherCarlos, ctx), false);
});

// ------------------------------------------------------------ likesYou

test('likesYou: devuelve quien me dio "+" pasando duros, reciente primero', () => {
  const otro = mkOther(key('h'), perfilCompleto({ apodo: 'Hugo', edad: 30, genero: 'hombre', prefs: PREFS_CARLOS }));
  const likes = {
    sent: {},
    received: {
      [CARLOS_KEY]: { tipo: '+', ts: NOW_SEC - 100 },
      [key('h')]: { tipo: '+', ts: NOW_SEC - 50 },
    },
  };
  const res = likesYou(me, [otherCarlos, otro], { ...ctx, likes });
  assert.equal(res.length, 2);
  assert.equal(res[0].other.pubkey, key('h')); // ts más reciente primero
  assert.equal(res[1].other.pubkey, CARLOS_KEY);
});

test('likesYou: se salta los blandos (completitud baja entra igual)', () => {
  const minimo = newProfile();
  Object.assign(minimo, {
    apodo: 'Min', edad: 26, genero: 'hombre', provincia: 'La Habana', municipio: 'Vedado',
    prefs: { edadMin: 20, edadMax: 40, generos: ['mujer'], distancia: 'cuba', relacion: ['romance'] },
  });
  assert.ok(completitud(minimo) < 40);
  const likes = { sent: {}, received: { [key('i')]: { tipo: '+', ts: NOW_SEC } } };
  const res = likesYou(me, [mkOther(key('i'), minimo)], { ...ctx, likes });
  assert.equal(res.length, 1);
});

test('likesYou: excluye bloqueados, incompatibles y ya respondidos', () => {
  const likes = { sent: {}, received: { [CARLOS_KEY]: { tipo: '+', ts: NOW_SEC } } };
  assert.equal(likesYou({ ...me, bloqueados: [CARLOS_KEY] }, [otherCarlos], { ...ctx, likes }).length, 0);
  // Ya le di like → es match, no fila.
  const conSent = { sent: { [CARLOS_KEY]: { tipo: '+', ts: NOW_SEC } }, received: likes.received };
  assert.equal(likesYou(me, [otherCarlos], { ...ctx, likes: conSent }).length, 0);
  // Dislike reciente → respondido.
  const conDislike = { sent: { [CARLOS_KEY]: { tipo: '-', ts: NOW_SEC - DIA } }, received: likes.received };
  assert.equal(likesYou(me, [otherCarlos], { ...ctx, likes: conDislike }).length, 0);
});

// ------------------------------------------------------------ score

test('score: fórmula v2 — gate multiplica y parts trae los 5 factores', () => {
  const { total, gate, parts } = score(me, otherCarlos, ctx);
  assert.deepEqual(Object.keys(parts).sort(), ['act', 'affinity', 'geo', 'mutual', 'rec']);
  const esperado = gate * (0.35 * parts.affinity + 0.25 * parts.mutual + 0.15 * parts.geo
    + 0.10 * parts.act + 0.15 * parts.rec);
  assert.ok(Math.abs(total - esperado) <= 0.05 + 1e-9, 'total = gate·base + jitter (±0.05)');
  assert.ok(total >= -0.05 && total <= 1.05, `total=${total}`);
  assert.equal(gate, gateCompletitud(completitud(ana), completitud(carlos)));
});

test('score: reciprocidad — quien me dio like suma 1.0 en su factor', () => {
  const likes = { sent: {}, received: { [CARLOS_KEY]: { tipo: '+', ts: NOW_SEC } } };
  const { parts } = score(me, otherCarlos, { ...ctx, likes });
  assert.equal(parts.rec, 1.0);
});

test('score: la completitud baja castiga vía gate (no excluye del cálculo)', () => {
  const flojo = perfilCompleto({ bio: '', valores: [], intereses: [], tags: [], prompts: [], tresPalabras: '', educacion: '', profesion: '', sector: '', estatura: '', complexion: '', ojos: '', piel: '', cabello: '' });
  const c = completitud(flojo);
  const { gate } = score(me, mkOther(key('j'), flojo), ctx);
  if (c < 40) assert.equal(gate, 0);
  else assert.equal(gate, 0.5 + 0.5 * (Math.min(completitud(ana), c) / 100));
});

// ------------------------------------------------------------ compatLabel

test('compatLabel: Alta ≥0.65, Media 0.4–0.65, Explorar <0.4 o relajado', () => {
  assert.equal(compatLabel(0.9), 'Alta');
  assert.equal(compatLabel(0.65), 'Alta');
  assert.equal(compatLabel(0.5), 'Media');
  assert.equal(compatLabel(0.4), 'Media');
  assert.equal(compatLabel(0.39), 'Explorar');
  assert.equal(compatLabel(0.95, true), 'Explorar'); // pool relajado → siempre Explorar
});

// ------------------------------------------------------------ rankCandidates

function candidato(i, o = {}) {
  return mkOther('cand' + i, perfilCompleto({
    apodo: 'C' + i, edad: 24 + (i % 8), genero: 'hombre', prefs: PREFS_CARLOS, ...o,
  }));
}

test('rankCandidates: orden descendente; bloqueados y menores fuera', () => {
  const alto = candidato(1);
  const bloqueado = candidato(2);
  const menor = mkOther('candMenor', perfilCompleto({ apodo: 'Menor', edad: 17, genero: 'hombre', prefs: PREFS_CARLOS }));
  const ranked = rankCandidates({ ...me, bloqueados: ['cand2'] }, [bloqueado, menor, alto], ctx);
  assert.deepEqual(ranked.map((r) => r.other.pubkey), ['cand1']);
  assert.ok('total' in ranked[0] && 'parts' in ranked[0] && 'gate' in ranked[0]);
});

test('rankCandidates: quien me dio like NO está en el mazo (va a Le gustas)', () => {
  const likes = { sent: {}, received: { [CARLOS_KEY]: { tipo: '+', ts: NOW_SEC } } };
  const ranked = rankCandidates(me, [otherCarlos, candidato(3)], { ...ctx, likes });
  assert.ok(!ranked.some((r) => r.other.pubkey === CARLOS_KEY));
  assert.ok(ranked.some((r) => r.other.pubkey === 'cand3'));
});

test('rankCandidates: mi like enviado no reaparece; mi dislike viejo sí', () => {
  const likes = {
    sent: {
      cand4: { tipo: '+', ts: NOW_SEC - 90 * DIA },
      cand5: { tipo: '-', ts: NOW_SEC - 30 * DIA },
      cand6: { tipo: '-', ts: NOW_SEC - 2 * DIA },
    },
    received: {},
  };
  const ranked = rankCandidates(me, [candidato(4), candidato(5), candidato(6)], { ...ctx, likes });
  const pks = ranked.map((r) => r.other.pubkey);
  assert.ok(!pks.includes('cand4'), 'like enviado: nunca');
  assert.ok(pks.includes('cand5'), 'dislike de hace 30 días: reaparece');
  assert.ok(!pks.includes('cand6'), 'dislike de hace 2 días: oculto');
});

test('rankCandidates: gate 0 (completitud < 40) no aparece en modo normal', () => {
  const minimo = newProfile();
  Object.assign(minimo, {
    apodo: 'Min', edad: 26, genero: 'hombre',
    prefs: { edadMin: 20, edadMax: 40, generos: ['mujer'], distancia: 'cuba', relacion: ['romance'] },
  });
  // Pool grande (≥30 buenos) → sin relajación, el mínimo queda fuera.
  const muchos = Array.from({ length: POOL_MIN + 2 }, (_, i) => candidato(100 + i));
  const ranked = rankCandidates(me, [...muchos, mkOther('candMin', minimo)], ctx);
  assert.ok(!ranked.some((r) => r.other.pubkey === 'candMin'));
  assert.equal(ranked.relajado, false);
});

test('rankCandidates: pool pequeño → relajación (suelo 0.25, tol 10) marcada', () => {
  // Candidato con completitud entre 25 y 40: fuera en normal, dentro en relajado.
  const medio = newProfile();
  Object.assign(medio, {
    apodo: 'Medio', edad: 26, genero: 'hombre', orientacion: 'hetero',
    provincia: 'La Habana', municipio: 'Vedado',
    prefs: { edadMin: 20, edadMax: 40, generos: ['mujer'], distancia: 'cuba', relacion: ['romance'] },
  });
  const c = completitud(medio);
  assert.ok(c >= 25 && c < 40, `completitud intermedia: ${c}`);
  const pocos = [candidato(7), mkOther('candMedio', medio)];
  const ranked = rankCandidates(me, pocos, ctx);
  assert.ok(ranked.some((r) => r.other.pubkey === 'candMedio'), 'con relajación entra');
  assert.equal(ranked.relajado, true);
  assert.ok(ranked.every((r) => r.relajado === true));
});

test('rankCandidates: pool grande → sin relajación aunque haya candidatos flojos', () => {
  const muchos = Array.from({ length: POOL_MIN }, (_, i) => candidato(200 + i));
  const ranked = rankCandidates(me, muchos, ctx);
  assert.equal(ranked.length, POOL_MIN);
  assert.equal(ranked.relajado, false);
  assert.ok(ranked.every((r) => r.relajado === false));
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].total >= ranked[i].total);
});

test('topDaily: devuelve máximo 10 ordenados (firma nueva, sin pesos)', () => {
  const others = Array.from({ length: 12 }, (_, i) => candidato(300 + i));
  const top = topDaily(me, others, ctx);
  assert.equal(top.length, 10);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].total >= top[i].total);
});

// ------------------------------------------------------------ pesos

test('WEIGHTS_V2: suman 1.0', () => {
  const s = Object.values(WEIGHTS_V2).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(s - 1) < 1e-9);
  assert.equal(GATE_FLOOR, 0.4);
  assert.equal(GATE_FLOOR_RELAXED, 0.25);
});
