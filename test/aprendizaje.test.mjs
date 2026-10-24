// Tests del motor de matching v2.1: stemming, fix de reciprocidad,
// preferencia aprendida de los swipes, modo mínimo para pools diminutos
// y actividad opcional. Sin red ni tiempo real (NOW fijo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newProfile } from '../src/perfil.js';
import {
  MIN_SWIPES, REL_PENALIZACION, POOL_BAJO,
  stemTerm, reciprocity, hardPass, score, buildCorpus,
  buildPrefModel, prefScore, interestSignal, rankCandidates,
} from '../src/matching.js';

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DIA = 86400;

function perfil(o = {}) {
  const p = newProfile();
  Object.assign(p, {
    apodo: 'X', edad: 26, genero: 'hombre', orientacion: 'hetero',
    provincia: 'La Habana', municipio: 'Vedado',
    estatura: 170, complexion: 'Promedio', ojos: 'Negros', piel: 'Morena', cabello: 'Negro',
    educacion: 'Universitario', profesion: 'Ingeniero', sector: 'Tecnología',
    fumador: 'no', bebedor: 'ocasional', deporte: 'sí', religion: 'Católica',
    hijosTiene: 'no', hijosQuiere: 'tal vez', mascotas: 'sí',
    valores: ['familia'], intereses: ['música'], tags: [],
    bio: 'Hola', tresPalabras: 'a b c',
    prompts: [{ q: 'q', a: 'a' }], fotoURL: 'x', mostrarEdad: true,
    prefs: { edadMin: 20, edadMax: 35, generos: ['mujer'], distancia: 'cuba', relacion: ['romance'] },
  }, o);
  return p;
}

const meProfile = perfil({
  apodo: 'Ana', genero: 'mujer', edad: 25,
  prefs: { edadMin: 22, edadMax: 35, generos: ['hombre'], distancia: 'cuba', relacion: ['romance', 'seria'] },
});
const me = { pubkey: 'a'.repeat(64), profile: meProfile, bloqueados: [], vistos: {} };
const mk = (pk, profile, created_at = NOW_SEC - DIA) => ({ pubkey: pk, profile, created_at });
const base = { corpus: buildCorpus([]), likes: { sent: {}, received: {} }, nowMs: NOW_MS };

// ------------------------------------------------------------ stemming

test('stemTerm: bailar/baile/bailes/bailando comparten raíz', () => {
  const r = stemTerm('bailar');
  assert.equal(r, 'bail');
  for (const w of ['baile', 'Bailes', 'bailando']) assert.equal(stemTerm(w), r, w);
});

test('stemTerm: plurales, acentos y palabras cortas', () => {
  assert.equal(stemTerm('Música'), stemTerm('musicas'));
  assert.equal(stemTerm('playa'), stemTerm('playas'));
  assert.equal(stemTerm('viajar'), stemTerm('viajes'));
  assert.equal(stemTerm('cine'), 'cine'); // ≤4 letras: intacta
  assert.equal(stemTerm('cines'), 'cine');
  assert.equal(stemTerm(''), '');
  assert.equal(stemTerm(null), '');
});

test('stemTerm: multipalabra se stemmea palabra por palabra', () => {
  assert.equal(stemTerm('comida cubana'), stemTerm('Comida Cubana'));
});

// -------------------------------------------------------- reciprocity fix

test('reciprocity: un dislike enviado YA NO cuenta como interés', () => {
  assert.equal(reciprocity('x', { sent: { x: { tipo: '-', ts: 1 } }, received: {} }), 0);
  assert.equal(reciprocity('x', { sent: { x: { tipo: '+', ts: 1 } }, received: {} }), 0.3);
  // Si me dio like, cuenta 1.0 aunque yo le haya dado dislike.
  assert.equal(reciprocity('x', { sent: { x: { tipo: '-', ts: 1 } }, received: { x: { tipo: '+' } } }), 1.0);
});

test('rankCandidates: el dislike que reaparece (>21 días) NO recibe bonus', () => {
  const likes = { sent: { c1: { tipo: '-', ts: NOW_SEC - 30 * DIA } }, received: {} };
  const r = rankCandidates(me, [mk('c1', perfil())], { ...base, likes });
  assert.equal(r.length, 1);
  assert.equal(r[0].parts.rec, 0);
});

// -------------------------------------------------- preferencia aprendida

// Historial: 6 likes a perfiles con tag "bachata" y 3 dislikes a "ajedrez".
function historial() {
  const peers = [];
  const sent = {};
  for (let i = 0; i < 6; i++) {
    peers.push(mk('L' + i, perfil({ tags: ['bachata'] })));
    sent['L' + i] = { tipo: '+', ts: NOW_SEC - DIA };
  }
  for (let i = 0; i < 3; i++) {
    peers.push(mk('D' + i, perfil({ tags: ['ajedrez'], fumador: 'sí' })));
    sent['D' + i] = { tipo: '-', ts: NOW_SEC - DIA };
  }
  return { peers, sent };
}

test('buildPrefModel: cuenta swipes con perfil conocido e ignora el resto', () => {
  const { peers, sent } = historial();
  sent.fantasma = { tipo: '+', ts: NOW_SEC }; // sin perfil descargado
  const m = buildPrefModel(peers, sent, base);
  assert.equal(m.n, 9);
  assert.ok(m.avg[stemTerm('bachata')] > 0, 'lo que me gustó suma');
  assert.ok(m.avg[stemTerm('ajedrez')] < 0, 'lo que descarté resta');
  for (const v of Object.values(m.avg)) assert.ok(v >= -1 && v <= 1);
});

test('prefScore: parecido a mis likes > neutro > parecido a mis dislikes', () => {
  const { peers, sent } = historial();
  const m = buildPrefModel(peers, sent, base);
  const gusta = prefScore(m, perfil({ tags: ['bachata'] }));
  const noGusta = prefScore(m, perfil({ tags: ['ajedrez'], fumador: 'sí' }));
  assert.ok(gusta > noGusta, `${gusta} vs ${noGusta}`);
  assert.ok(gusta >= 0 && gusta <= 1 && noGusta >= 0 && noGusta <= 1);
  // Sin ningún rasgo en común con el historial → null (no se opina).
  const raro = perfil({
    valores: [], intereses: ['astronomía'], tags: [],
    fumador: '', bebedor: '', deporte: '', religion: '', hijosQuiere: '', mascotas: '',
  });
  assert.equal(prefScore(m, raro), null);
  assert.equal(prefScore(null, raro), null);
});

test('interestSignal: 0 sin swipes suficientes; crece con el historial', () => {
  const o = mk('c9', perfil({ tags: ['bachata'] }));
  assert.equal(interestSignal(o, base), 0);
  const { peers, sent } = historial();
  const poco = buildPrefModel(peers.slice(0, 2), { L0: sent.L0, L1: sent.L1 }, base);
  assert.ok(poco.n < MIN_SWIPES);
  assert.equal(interestSignal(o, { ...base, prefModel: poco }), 0);
  const modelo = buildPrefModel(peers, sent, base);
  const s = interestSignal(o, { ...base, prefModel: modelo });
  assert.ok(s > 0 && s <= 1, `s=${s}`);
  // La reciprocidad explícita manda sobre el modelo.
  const likes = { sent: {}, received: { c9: { tipo: '+', ts: NOW_SEC } } };
  assert.equal(interestSignal(o, { ...base, prefModel: modelo, likes }), 1.0);
});

test('rankCandidates: aprende de mis swipes (rec mayor para el parecido a mis likes)', () => {
  const { peers, sent } = historial();
  const gusta = mk('cGusta', perfil({ tags: ['bachata'] }));
  const noGusta = mk('cNo', perfil({ tags: ['ajedrez'], fumador: 'sí' }));
  const ranked = rankCandidates(me, [...peers, gusta, noGusta], { ...base, likes: { sent, received: {} } });
  const r = (pk) => ranked.find((x) => x.other.pubkey === pk);
  assert.ok(r('cGusta') && r('cNo'));
  assert.ok(r('cGusta').parts.rec > r('cNo').parts.rec);
  // Los likes enviados siguen sin reaparecer.
  assert.ok(!ranked.some((x) => x.other.pubkey.startsWith('L')));
});

test('rankCandidates: sin historial el 5º factor vale 0 (comportamiento v2 intacto)', () => {
  const r = rankCandidates(me, [mk('c1', perfil())], base);
  assert.equal(r[0].parts.rec, 0);
});

// ------------------------------------------------------ modo mínimo (<15)

test('hardPass: relajarRelacion deja pasar a quien solo busca otra relación', () => {
  const amigo = mk('am', perfil({ prefs: { edadMin: 20, edadMax: 35, generos: ['mujer'], distancia: 'cuba', relacion: ['amistad'] } }));
  assert.equal(hardPass(me, amigo), false);
  assert.equal(hardPass(me, amigo, { relajarRelacion: true }), true);
  // El género mutuo sigue siendo duro incluso relajado.
  const noMeBusca = mk('nb', perfil({ prefs: { edadMin: 20, edadMax: 35, generos: ['hombre'], distancia: 'cuba', relacion: ['romance'] } }));
  assert.equal(hardPass(me, noMeBusca, { relajarRelacion: true }), false);
});

test('score: sin relación en común se penaliza ×REL_PENALIZACION', () => {
  const ok = mk('ok', perfil());
  const sin = mk('sin', perfil({ prefs: { edadMin: 20, edadMax: 35, generos: ['mujer'], distancia: 'cuba', relacion: ['amistad'] } }));
  const a = score(me, ok, base);
  const b = score(me, sin, base);
  assert.ok(Math.abs(b.base / a.base - REL_PENALIZACION) < 1e-9, `${b.base / a.base}`);
});

test('rankCandidates: pool diminuto → nivel 3 incluye relación distinta y completitud baja', () => {
  const amigo = mk('am', perfil({ prefs: { edadMin: 20, edadMax: 35, generos: ['mujer'], distancia: 'cuba', relacion: ['amistad'] } }));
  const flojo = newProfile();
  Object.assign(flojo, {
    apodo: 'Flojo', edad: 27, genero: 'hombre',
    prefs: { edadMin: 20, edadMax: 35, generos: ['mujer'], distancia: 'cuba', relacion: ['romance'] },
  });
  const bueno = mk('bu', perfil());
  const r = rankCandidates(me, [bueno, amigo, mk('fl', flojo)], base);
  const pks = r.map((x) => x.other.pubkey).sort();
  assert.deepEqual(pks, ['am', 'bu', 'fl']);
  assert.equal(r.nivel, 3);
  assert.equal(r.relajado, true);
  assert.ok(r.every((x) => x.relajado === true && x.gate > 0));
});

test('rankCandidates: con ≥POOL_BAJO candidatos válidos no se activa el nivel 3', () => {
  const muchos = Array.from({ length: POOL_BAJO }, (_, i) => mk('m' + i, perfil({ apodo: 'M' + i })));
  const amigo = mk('am', perfil({ prefs: { edadMin: 20, edadMax: 35, generos: ['mujer'], distancia: 'cuba', relacion: ['amistad'] } }));
  const r = rankCandidates(me, [...muchos, amigo], base);
  assert.ok(r.nivel < 3);
  assert.ok(!r.some((x) => x.other.pubkey === 'am'));
});

// -------------------------------------------------------------- actividad

test('score: ctx.ultimaActividad sustituye al created_at viejo del perfil', () => {
  const viejo = mk('v1', perfil(), NOW_SEC - 120 * DIA);
  const sinDato = score(me, viejo, base).parts.act;
  const conDato = score(me, viejo, { ...base, ultimaActividad: { v1: NOW_SEC - 60 } }).parts.act;
  assert.ok(sinDato < 0.1, `sinDato=${sinDato}`);
  assert.ok(conDato > 0.99, `conDato=${conDato}`);
  // Una actividad futura falsa no da más de 1.0, y una más vieja no empeora el created_at.
  const futura = score(me, viejo, { ...base, ultimaActividad: { v1: NOW_SEC + 30 * DIA } }).parts.act;
  assert.ok(futura <= 1);
  const masVieja = score(me, mk('v2', perfil(), NOW_SEC - DIA), { ...base, ultimaActividad: { v2: NOW_SEC - 200 * DIA } }).parts.act;
  assert.equal(masVieja, score(me, mk('v2', perfil(), NOW_SEC - DIA), base).parts.act);
});
