// Tests v1.3.0: campos faltantes del perfil (guía "Completa tu
// perfil"), enlaces de compartir y código QR estático de la app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProfile, completitud, camposFaltantes } from '../src/perfil.js';
import { APP_URL, SHARE_TEXT, shareLinks, QR_ROWS, qrSVG } from '../src/ux.js';

// Perfil con TODOS los campos que puntúan rellenos.
function perfilCompleto() {
  const p = newProfile();
  Object.assign(p, {
    apodo: 'Ana', edad: 26, genero: 'mujer', orientacion: 'hetero',
    provincia: 'La Habana', municipio: 'Playa',
    estatura: 168, complexion: 'Promedio', ojos: 'Marrones', piel: 'Trigueña', cabello: 'Negro',
    educacion: 'Universitario', profesion: 'Enfermera', sector: 'Salud',
    fumador: 'No', bebedor: 'Ocasionalmente', deporte: 'Sí', religion: 'Ninguna',
    hijosTiene: 'No tengo', hijosQuiere: 'Tal vez', mascotas: 'Sí',
    valores: ['familia', 'humor'], intereses: ['música', 'playa'], tags: ['café'],
    bio: 'Hola, soy Ana.', tresPalabras: 'alegre, sincera, cubana', fotoURL: 'https://x.test/f.jpg',
    prompts: [{ q: 'Un domingo perfecto para mí es…', a: 'playa y dominó' }],
  });
  p.rasgos.apertura = 5; // mover un slider basta para "rasgos llenos"
  p.prefs = { edadMin: 24, edadMax: 40, generos: ['hombre'], distancia: 'cuba', relacion: ['romance'] };
  return p;
}

// ---------- camposFaltantes ----------
test('camposFaltantes: perfil completo → nada falta y completitud 100', () => {
  const p = perfilCompleto();
  assert.equal(completitud(p), 100);
  assert.deepEqual(camposFaltantes(p), []);
});

test('camposFaltantes: perfil vacío → faltan los campos que puntúan, bio primero', () => {
  const f = camposFaltantes(newProfile());
  assert.ok(f.length >= 25, 'faltan casi todos los campos: ' + f.length);
  assert.equal(f[0].campo, 'bio', 'la bio (peso 8) va primero');
  assert.equal(f[0].paso, 7);
  const campos = f.map((x) => x.campo);
  for (const c of ['apodo', 'edad', 'genero', 'provincia', 'intereses', 'fotoURL', 'prefs', 'valores', 'rasgos', 'prompts']) {
    assert.ok(campos.includes(c), 'falta ' + c);
  }
  // orden descendente por peso
  for (let i = 1; i < f.length; i++) assert.ok(f[i - 1].peso >= f[i].peso, 'orden por peso');
});

test('camposFaltantes: pasos del editor correctos por campo', () => {
  const f = camposFaltantes(newProfile());
  const paso = Object.fromEntries(f.map((x) => [x.campo, x.paso]));
  assert.equal(paso.apodo, 1);
  assert.equal(paso.estatura, 2);
  assert.equal(paso.educacion, 3);
  assert.equal(paso.fumador, 4);
  assert.equal(paso.valores, 5);
  assert.equal(paso.intereses, 6);
  assert.equal(paso.bio, 7);
  assert.equal(paso.fotoURL, 7);
  assert.equal(paso.prefs, 8);
});

test('camposFaltantes: lo ya llenado no aparece', () => {
  const p = newProfile();
  p.bio = 'Ya tengo bio';
  p.fotoURL = 'https://x.test/yo.jpg';
  p.intereses = ['cine'];
  const campos = camposFaltantes(p).map((x) => x.campo);
  assert.ok(!campos.includes('bio'));
  assert.ok(!campos.includes('fotoURL'));
  assert.ok(!campos.includes('intereses'));
  assert.ok(campos.includes('tags'), 'los tags siguen faltando');
});

test('camposFaltantes: prefs a medias siguen faltando; rasgos neutros también', () => {
  const p = newProfile();
  p.prefs = { edadMin: 20, edadMax: 30, generos: [], distancia: 'cuba', relacion: [] };
  let campos = camposFaltantes(p).map((x) => x.campo);
  assert.ok(campos.includes('prefs'), 'sin géneros ni relación, prefs no cuenta');
  assert.ok(campos.includes('rasgos'), 'sliders todos en 3 = sin tocar');
  p.rasgos.calma = 4;
  campos = camposFaltantes(p).map((x) => x.campo);
  assert.ok(!campos.includes('rasgos'), 'un slider movido ya cuenta');
});

test('camposFaltantes: perfil nulo → lista vacía (sin romper)', () => {
  assert.deepEqual(camposFaltantes(null), []);
  assert.deepEqual(camposFaltantes(undefined), []);
});

test('camposFaltantes: etiquetas amables en español', () => {
  const f = camposFaltantes(newProfile());
  for (const x of f) {
    assert.ok(typeof x.label === 'string' && x.label.length > 2, 'etiqueta para ' + x.campo);
    assert.ok(x.paso >= 1 && x.paso <= 8, 'paso válido para ' + x.campo);
  }
  const foto = f.find((x) => x.campo === 'fotoURL');
  assert.equal(foto.label, 'Tu foto');
});

// ---------- compartir ----------
test('shareLinks: WhatsApp con el texto y la URL codificados', () => {
  const l = shareLinks();
  assert.equal(l.url, APP_URL);
  assert.ok(l.texto.includes(APP_URL), 'el texto incluye la URL');
  assert.ok(l.texto.includes('CubMatch'));
  assert.ok(l.whatsapp.startsWith('https://wa.me/?text='));
  const decodificado = decodeURIComponent(l.whatsapp.slice('https://wa.me/?text='.length));
  assert.equal(decodificado, l.texto, 'el parámetro de WhatsApp es el texto completo');
  assert.ok(!l.whatsapp.includes(' '), 'sin espacios sin codificar');
});

test('shareLinks: acepta otra URL (p. ej. un gateway alterno)', () => {
  const l = shareLinks('https://ejemplo.test/app');
  assert.equal(l.url, 'https://ejemplo.test/app');
  assert.ok(l.texto.endsWith('https://ejemplo.test/app'));
  assert.ok(decodeURIComponent(l.whatsapp.split('?text=')[1]).includes('ejemplo.test'));
});

test('APP_URL: la dirección pública fija de la app', () => {
  assert.match(APP_URL, /^https:\/\/.+\.nsite\.lol\/$/);
  assert.ok(SHARE_TEXT.length > 10);
});

// ---------- QR ----------
test('QR_ROWS: matriz cuadrada de 37×37 solo con 0/1', () => {
  assert.equal(QR_ROWS.length, 37);
  for (const row of QR_ROWS) {
    assert.equal(row.length, 37);
    assert.match(row, /^[01]+$/);
  }
});

test('QR_ROWS: patrones de posición (finder) en las tres esquinas', () => {
  // esquina superior izquierda
  assert.ok(QR_ROWS[0].startsWith('1111111'));
  assert.ok(QR_ROWS[1].startsWith('1000001'));
  // esquina superior derecha
  assert.ok(QR_ROWS[0].endsWith('1111111'));
  assert.ok(QR_ROWS[1].endsWith('1000001'));
  // esquina inferior izquierda
  assert.ok(QR_ROWS[36].startsWith('1111111'));
  assert.ok(QR_ROWS[30].startsWith('1111111'));
  assert.ok(QR_ROWS[35].startsWith('1000001'));
});

test('qrSVG: SVG determinista con fondo blanco y path de módulos', () => {
  const a = qrSVG(190);
  const b = qrSVG(190);
  assert.equal(a, b, 'determinista');
  assert.ok(a.startsWith('<svg'));
  assert.ok(a.includes('width="190"'));
  assert.ok(a.includes('fill="#ffffff"'), 'fondo blanco (con zona de silencio)');
  assert.ok(a.includes('<path d="M'), 'módulos como path');
  assert.ok(a.includes('viewBox="0 0 45 45"'), '37 módulos + 8 de silencio');
});
