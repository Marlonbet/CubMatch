// Tests del motor de matching — node:test + node:assert/strict.
// Fixtures deterministas (sin red, sin tiempo real: NOW fijo).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProfile, completitud, PROVINCIAS } from '../src/perfil.js';
import {
  WEIGHTS_DEFAULT, hardPass, cosine, buildCorpus, vectorize, desiredVector,
  geoScore, activityBonus, reciprocity, score, rankCandidates, topDaily,
} from '../src/matching.js';

const NOW = Date.now();
const SEC = 86400;
const key = (c) => String(c).repeat(32);

// Receta de perfil con completitud >= 70 (verificado en el primer test).
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
const me = { pubkey: ANA_KEY, profile: ana, bloqueados: [], vistos: [] };
const mkOther = (pubkey, profile, created_at = Math.floor(NOW / 1000) - SEC) =>
  ({ pubkey, profile, created_at });
const otherCarlos = mkOther(CARLOS_KEY, carlos);
const ctx = { corpus: buildCorpus([ana, carlos]), likes: { sent: {}, received: {} }, nowMs: NOW };

// ------------------------------------------------------------ fixtures

test('fixtures: completitud >= 70 en ambos perfiles', () => {
  assert.ok(completitud(ana) >= 70, `Ana: ${completitud(ana)}`);
  assert.ok(completitud(carlos) >= 70, `Carlos: ${completitud(carlos)}`);
});

// ------------------------------------------------------------ hardPass

test('hardPass: caso base true (Ana ↔ Carlos, mutuamente compatibles)', () => {
  assert.equal(hardPass(me, otherCarlos), true);
});

test('hardPass: false si other está fuera del rango de edad de me', () => {
  const o = mkOther(key('c'), perfilCompleto({ apodo: 'Mayor', edad: 40, genero: 'hombre', prefs: PREFS_CARLOS }));
  assert.equal(hardPass(me, o), false); // Ana busca hasta 35
});

test('hardPass: false si me está fuera del rango de edad de other', () => {
  const p = perfilCompleto({ apodo: 'Joven', edad: 28, genero: 'hombre', prefs: { ...PREFS_CARLOS, edadMax: 24 } });
  assert.equal(hardPass(me, mkOther(key('d'), p)), false); // Ana tiene 25
});

test('hardPass: false si el género de other no es buscado por me', () => {
  const meSoloMujeres = { ...me, profile: perfilCompleto({ prefs: { ...ana.prefs, generos: ['mujer'] } }) };
  assert.equal(hardPass(meSoloMujeres, otherCarlos), false); // Carlos es hombre
});

test('hardPass: false por distancia cuando me exige "misma" y son de distinta provincia', () => {
  const meMisma = { ...me, profile: perfilCompleto({ prefs: { ...ana.prefs, distancia: 'misma' } }) };
  assert.equal(hardPass(meMisma, otherCarlos), false); // La Habana vs Santiago de Cuba
});

test('hardPass: false por relación sin overlap', () => {
  const p = perfilCompleto({ apodo: 'Amigo', edad: 28, genero: 'hombre', prefs: { ...PREFS_CARLOS, relacion: ['amistad'] } });
  assert.equal(hardPass(me, mkOther(key('e'), p)), false); // Ana: romance/seria
});

test('hardPass: false si other está bloqueado', () => {
  assert.equal(hardPass({ ...me, bloqueados: [CARLOS_KEY] }, otherCarlos), false);
});

test('hardPass: false si other ya fue visto', () => {
  assert.equal(hardPass({ ...me, vistos: [CARLOS_KEY] }, otherCarlos), false);
});

test('hardPass: false si other tiene completitud < 70', () => {
  const o = mkOther(key('f'), newProfile()); // perfil casi vacío
  assert.ok(completitud(o.profile) < 70);
  assert.equal(hardPass(me, o), false);
});

test('hardPass: false consigo mismo', () => {
  assert.equal(hardPass(me, mkOther(ANA_KEY, carlos)), false);
});

// ------------------------------------------------------------ cosine

test('cosine: 1 con vectores iguales', () => {
  assert.equal(cosine([1, 2, 3], [1, 2, 3]), 1);
});

test('cosine: 0 con vectores ortogonales', () => {
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('cosine: 0 si algún vector tiene norma 0', () => {
  assert.equal(cosine([0, 0, 0], [1, 2, 3]), 0);
  assert.equal(cosine([1, 2, 3], [0, 0, 0]), 0);
});

// ------------------------------------------------------------ geoScore

test('geoScore: 1.0 mismo municipio (case-insensitive)', () => {
  assert.equal(
    geoScore({ provincia: 'La Habana', municipio: 'Vedado' }, { provincia: 'La Habana', municipio: 'vedado' }),
    1.0,
  );
});

test('geoScore: 0.7 misma provincia, distinto municipio', () => {
  assert.equal(
    geoScore({ provincia: 'La Habana', municipio: 'Vedado' }, { provincia: 'La Habana', municipio: 'Centro Habana' }),
    0.7,
  );
});

test('geoScore: 0.3 distinta provincia', () => {
  assert.equal(
    geoScore({ provincia: 'La Habana', municipio: 'Vedado' }, { provincia: 'Matanzas', municipio: 'Varadero' }),
    0.3,
  );
});

// ------------------------------------------------------------ activityBonus

test('activityBonus: >0.9 recién creado', () => {
  assert.ok(activityBonus(NOW / 1000 - 60, NOW) > 0.9);
});

test('activityBonus: a 30 días es menor que recién creado', () => {
  const recien = activityBonus(NOW / 1000 - 60, NOW);
  const v30 = activityBonus(NOW / 1000 - 30 * SEC, NOW);
  assert.ok(v30 < recien);
});

test('activityBonus: siempre en [0,1] (antiguo no baja de 0, futuro se clampa a 1)', () => {
  assert.ok(activityBonus(NOW / 1000 - 400 * SEC, NOW) >= 0);
  assert.ok(activityBonus(NOW / 1000 + SEC, NOW) <= 1);
});

// ------------------------------------------------------------ reciprocity

test("reciprocity: 1.0 si recibió '+'", () => {
  assert.equal(reciprocity('x', { sent: {}, received: { x: { tipo: '+' } } }), 1.0);
});

test('reciprocity: 0.3 si solo envió', () => {
  assert.equal(reciprocity('x', { sent: { x: { tipo: '+' } }, received: {} }), 0.3);
});

test('reciprocity: 0.0 sin nada', () => {
  assert.equal(reciprocity('x', { sent: {}, received: {} }), 0.0);
});

// ------------------------------------------------------------ vectorize / desiredVector

test('vectorize y desiredVector: misma longitud (71 + vocabulario TF-IDF)', () => {
  const v1 = vectorize(ana, ctx.corpus);
  const v2 = vectorize(carlos, ctx.corpus);
  const d = desiredVector(ana, ctx.corpus);
  assert.equal(v1.length, v2.length);
  assert.equal(d.length, v1.length);
  assert.ok(v1.length > 71, `longitud=${v1.length}`);
});

test('vectorize: one-hots y normalizaciones en los índices exactos', () => {
  const v = vectorize(ana, ctx.corpus);
  assert.deepEqual(v.slice(0, 3), [1, 0, 0]); // género mujer
  assert.deepEqual(v.slice(3, 6), [1, 0, 0]); // orientación hetero
  assert.equal(v[6], 0.25); // edad 25/100
  assert.equal(v[9], 1); // La Habana = índice 2 de PROVINCIAS → dim 7+2
  assert.ok(Math.abs(v[48] - 25 / 70) < 1e-12); // estatura (165-140)/70
  assert.deepEqual(v.slice(49, 51), [0, 1]); // fumador 'no'
  assert.deepEqual(v.slice(51, 53), [0.5, 0.5]); // bebedor 'ocasional'
  assert.deepEqual(v.slice(53, 55), [1, 0]); // deporte 'sí'
  assert.equal(v.slice(55, 59).reduce((a, b) => a + b, 0), 1); // religión: un bucket activo
  assert.deepEqual(v.slice(61, 64), [0, 0, 1]); // hijosQuiere 'tal vez'
  assert.deepEqual(v.slice(66, 71), [0.6, 0.6, 0.6, 0.6, 0.6]); // rasgos 3/5
});

test('vectorize: valores desconocidos/vacíos → ceros en sus dims', () => {
  const v = vectorize(newProfile(), ctx.corpus);
  assert.ok(v.slice(0, 6).every((x) => x === 0)); // género y orientación vacíos
  assert.ok(v.slice(7, 48).every((x) => x === 0)); // provincia, físico, educación
  assert.equal(v[48], 0); // estatura vacía
  assert.ok(v.slice(49, 66).every((x) => x === 0)); // hábitos y familia vacíos
});

test('desiredVector: multi-hot de géneros, edad media y distancia "cuba" uniforme', () => {
  const d = desiredVector(ana, ctx.corpus);
  assert.deepEqual(d.slice(0, 3), [0, 1, 0]); // Ana busca hombre
  assert.equal(d[6], (22 + 35) / 2 / 100); // punto medio del rango
  const prov = d.slice(7, 23);
  assert.ok(prov.every((x) => Math.abs(x - 1 / 16) < 1e-12)); // 'cuba' → uniforme
  assert.ok(d.slice(3, 6).every((x) => x === 0)); // orientación: cero
  assert.ok(d.slice(23, 71).every((x) => x === 0)); // resto fijo: cero
  assert.ok(d.slice(71).every((x) => x === 0)); // TF-IDF: cero
});

test('desiredVector: géneros vacíos → uniforme 1/3; distancia "misma" → one-hot', () => {
  const p = perfilCompleto({ prefs: { edadMin: 20, edadMax: 40, generos: [], distancia: 'misma', relacion: ['amistad'] } });
  const d = desiredVector(p);
  assert.ok(d.slice(0, 3).every((x) => Math.abs(x - 1 / 3) < 1e-12));
  assert.equal(d[9], 1); // La Habana → dim 7+2
  assert.equal(d.slice(7, 23).reduce((a, b) => a + b, 0), 1);
});

test('desiredVector: distancia "vecinas" → multi-hot normalizado de provincia + vecinas', () => {
  const p = perfilCompleto({ prefs: { ...ana.prefs, distancia: 'vecinas' } });
  const d = desiredVector(p);
  // La Habana (dim 9) + Artemisa (dim 8) + Mayabeque (dim 10)
  for (const dim of [8, 9, 10]) assert.ok(Math.abs(d[dim] - 1 / 3) < 1e-12, `dim ${dim}`);
  assert.ok(Math.abs(d.slice(7, 23).reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

// ------------------------------------------------------------ score

test('score: total en [0, ~1.2] y parts con las 6 claves', () => {
  const { total, parts } = score(me, otherCarlos, ctx);
  assert.ok(total >= 0 && total <= 1.2, `total=${total}`);
  assert.deepEqual(Object.keys(parts).sort(), ['act', 'geo', 'rec', 'simPP', 'simPPref', 'simPrefP']);
});

test('score: con pesos custom el total cambia (w1=1 → total === simPP)', () => {
  const base = score(me, otherCarlos, ctx);
  const custom = score(me, otherCarlos, ctx, { w1: 1, w2: 0, w3: 0, w4: 0, w5: 0, w6: 0 });
  assert.equal(custom.total, custom.parts.simPP);
  assert.notEqual(custom.total, base.total);
});

// ------------------------------------------------------------ rankCandidates / topDaily

test('rankCandidates: orden descendente y excluye a quien no pasa hardPass', () => {
  const alto = mkOther(key('1'), perfilCompleto({ apodo: 'Alto', edad: 27, genero: 'hombre', prefs: PREFS_CARLOS }));
  const bajo = mkOther(key('2'), perfilCompleto({
    apodo: 'Bajo', edad: 29, genero: 'hombre',
    valores: ['ambición', 'aventura', 'sencillez'], intereses: ['videojuegos', 'fotografía', 'viajes'], tags: ['rock'],
    prefs: PREFS_CARLOS,
  }));
  const fuera = mkOther(key('3'), perfilCompleto({ apodo: 'Fuera', edad: 50, genero: 'hombre', prefs: PREFS_CARLOS }));
  const bloqueado = mkOther(key('4'), perfilCompleto({ apodo: 'Bloq', edad: 26, genero: 'hombre', prefs: PREFS_CARLOS }));
  const others = [bajo, bloqueado, fuera, alto];
  const corpus = buildCorpus([ana, alto.profile, bajo.profile, fuera.profile, bloqueado.profile]);
  const meB = { ...me, bloqueados: [key('4')] };
  const ranked = rankCandidates(meB, others, { ...ctx, corpus }, WEIGHTS_DEFAULT);
  assert.equal(ranked.length, 2); // fuera (edad) y bloqueado quedan fuera
  assert.equal(ranked[0].other.pubkey, key('1')); // más intereses en común → primero
  assert.ok(ranked[0].total >= ranked[1].total);
  assert.ok('other' in ranked[0] && 'total' in ranked[0] && 'parts' in ranked[0]);
});

test('topDaily: devuelve máximo 10, ordenados', () => {
  const profiles = [];
  const others = [];
  for (let i = 0; i < 12; i++) {
    const p = perfilCompleto({
      apodo: 'C' + i, edad: 22 + (i % 10), genero: 'hombre',
      provincia: PROVINCIAS[i % 16], municipio: 'Muni' + i,
      tags: ['tag' + i],
      prefs: { edadMin: 20, edadMax: 35, generos: ['mujer'], distancia: 'cuba', relacion: ['romance'] },
    });
    profiles.push(p);
    others.push(mkOther('top' + i, p));
  }
  const corpus = buildCorpus([ana, ...profiles]);
  const top = topDaily(me, others, { ...ctx, corpus }, WEIGHTS_DEFAULT);
  assert.equal(top.length, 10);
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].total >= top[i].total);
});
