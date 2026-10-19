// Tests del modelo de perfil: completitud, validación, avatar, distancias.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newProfile, completitud, entraEnMatching, validateProfile,
  avatarSVG, avatarDataURI, nivelDistancia, NIVEL_DISTANCIA_MAX,
  PROVINCIAS, VALORES, INTERESES, MIN_COMPLETITUD,
} from '../src/perfil.js';

test('Cuba tiene 16 provincias', () => {
  assert.equal(PROVINCIAS.length, 16);
  assert.ok(PROVINCIAS.includes('Santiago de Cuba'));
  assert.ok(PROVINCIAS.includes('La Habana'));
});

test('perfil vacío tiene completitud baja y no entra en matching', () => {
  const p = newProfile();
  assert.ok(completitud(p) < MIN_COMPLETITUD);
  assert.ok(!entraEnMatching(p));
});

test('perfil completo supera el 70%', () => {
  const p = newProfile();
  Object.assign(p, {
    apodo: 'Ana', edad: 25, genero: 'mujer', orientacion: 'hetero',
    provincia: 'La Habana', municipio: 'Vedado',
    estatura: 165, complexion: 'Atlética', ojos: 'Marrones', piel: 'Trigueña', cabello: 'Negro',
    educacion: 'Universitario', profesion: 'Médica', sector: 'Salud',
    fumador: 'no', bebedor: 'ocasional', deporte: 'sí', religion: 'Católica',
    hijosTiene: 'no', hijosQuiere: 'tal vez', mascotas: 'sí',
    valores: ['familia', 'humor'], intereses: ['música', 'playa'], tags: ['salsa'],
    bio: 'Hola.', tresPalabras: 'alegre sincera fiel',
    prompts: [{ q: 'Un domingo perfecto…', a: 'Playa' }],
    prefs: { edadMin: 22, edadMax: 35, generos: ['hombre'], distancia: 'cuba', relacion: ['romance'] },
  });
  p.rasgos.extroversion = 5;
  const c = completitud(p);
  assert.ok(c >= MIN_COMPLETITUD, 'completitud=' + c);
  assert.ok(entraEnMatching(p));
});

test('completitud es monótona: más campos → más puntos', () => {
  const a = newProfile(); a.apodo = 'X';
  const b = newProfile(); Object.assign(b, { apodo: 'X', edad: 30, genero: 'hombre', provincia: 'Granma', municipio: 'Bayamo' });
  assert.ok(completitud(b) > completitud(a));
});

test('validateProfile detecta errores', () => {
  const p = newProfile();
  const errs = validateProfile(p);
  assert.ok(errs.length >= 5, errs.join('|'));
  p.apodo = 'A'; p.edad = 15;
  assert.ok(validateProfile(p).some((e) => e.includes('18 y 99')));
  p.edad = 25; p.genero = 'mujer'; p.orientacion = 'hetero';
  p.provincia = 'Holguín'; p.municipio = 'Moa';
  p.prefs = { edadMin: 20, edadMax: 40, generos: ['hombre'], distancia: 'cuba', relacion: ['amistad'] };
  assert.deepEqual(validateProfile(p), []);
  p.bio = 'x'.repeat(601);
  assert.ok(validateProfile(p).some((e) => e.includes('600')));
  p.bio = '';
  p.tags = Array.from({ length: 13 }, (_, i) => 't' + i);
  assert.ok(validateProfile(p).some((e) => e.includes('12')));
});

test('avatarSVG es determinista y distinto por seed', () => {
  const a1 = avatarSVG('seed1', 'Ana');
  const a2 = avatarSVG('seed1', 'Ana');
  const b = avatarSVG('seed2', 'Ana');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.ok(a1.includes('<svg'));
});

test('avatarDataURI es un data URI válido', () => {
  const uri = avatarDataURI('abc', 'Luis');
  assert.ok(uri.startsWith('data:image/svg+xml,'));
  assert.ok(uri.length > 500);
});

test('nivelDistancia: misma / vecinas / resto', () => {
  assert.equal(nivelDistancia('La Habana', 'La Habana'), 0);
  assert.equal(nivelDistancia('La Habana', 'Mayabeque'), 1);
  assert.equal(nivelDistancia('La Habana', 'Guantánamo'), 2);
  assert.equal(NIVEL_DISTANCIA_MAX.misma, 0);
  assert.equal(NIVEL_DISTANCIA_MAX.vecinas, 1);
  assert.equal(NIVEL_DISTANCIA_MAX.cuba, 2);
});

test('listas de valores e intereses no vacías', () => {
  assert.ok(VALORES.length >= 8);
  assert.ok(INTERESES.length >= 8);
  assert.ok(INTERESES.includes('música'));
});
