// Punto 5 (refuerzos contra perfiles falsos y estafas), primer paso y
// v1.12.17 (invitación a salir de la app):
// fricción al compartir datos sensibles en el chat. detectarDatoSensible
// clasifica un mensaje saliente como 'telefono' | 'dinero' | 'externo' | null; la
// app pide confirmación antes de enviar, sin bloquear nunca el envío.
// El aviso no acusa a la otra persona: solo recuerda el riesgo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectarDatoSensible } from '../src/seguridad.js';

test('telefono: +53, 8 dígitos seguidos y 4+4 con espacio o guion', () => {
  assert.equal(detectarDatoSensible('mi número es +5351234567'), 'telefono');
  assert.equal(detectarDatoSensible('llámame al 51234567'), 'telefono');
  assert.equal(detectarDatoSensible('mi whatsapp es 5123 4567'), 'telefono');
  assert.equal(detectarDatoSensible('mi whatsapp es 5123-4567'), 'telefono');
  assert.equal(detectarDatoSensible('53 51234567, ese es mi número'), 'telefono');
});

test('telefono: fechas, años y charla normal NO disparan', () => {
  assert.equal(detectarDatoSensible('nos vemos el 12-10-2026'), null);
  assert.equal(detectarDatoSensible('nací en 1998, ¿y tú?'), null);
  assert.equal(detectarDatoSensible('tengo 2026 razones para reírme'), null);
  assert.equal(detectarDatoSensible('hola, ¿cómo estás? ¿de dónde eres?'), null);
  assert.equal(detectarDatoSensible(''), null);
  assert.equal(detectarDatoSensible(null), null);
});

test('dinero: recargas, transferencias y peticiones directas', () => {
  assert.equal(detectarDatoSensible('hazme una recarga por favor'), 'dinero');
  assert.equal(detectarDatoSensible('te transfiero mañana temprano'), 'dinero');
  assert.equal(detectarDatoSensible('mándame saldo que me quedé sin datos'), 'dinero');
  assert.equal(detectarDatoSensible('envíame dinero por transferencia'), 'dinero');
  assert.equal(detectarDatoSensible('pásame tu número de tarjeta'), 'dinero');
});

test('dinero: hablar de dinero en general NO dispara', () => {
  assert.equal(detectarDatoSensible('no tengo dinero esta semana'), null);
  assert.equal(detectarDatoSensible('el dinero no compra la felicidad'), null);
  assert.equal(detectarDatoSensible('¿cuánto cuesta el pasaje?'), null);
});

test('externo: invitación explícita a seguir fuera de la app', () => {
  assert.equal(detectarDatoSensible('hablemos por WhatsApp mejor'), 'externo');
  assert.equal(detectarDatoSensible('pasemos a Telegram, aquí es lento'), 'externo');
  assert.equal(detectarDatoSensible('búscame en Instagram, soy la misma'), 'externo');
  assert.equal(detectarDatoSensible('escríbeme por Signal cuando puedas'), 'externo');
  assert.equal(detectarDatoSensible('te paso mi WhatsApp en un rato'), 'externo');
  assert.equal(detectarDatoSensible('mi Telegram es @juan_cuba'), 'externo');
  assert.equal(detectarDatoSensible('mi usuario es @maria_habana'), 'externo');
});

test('externo: preguntar por la red NO dispara, y el número sigue siendo telefono', () => {
  assert.equal(detectarDatoSensible('¿tienes WhatsApp?'), null);
  assert.equal(detectarDatoSensible('¿usas Telegram o solo aquí?'), null);
  assert.equal(detectarDatoSensible('hablemos por aquí mejor'), null);
  assert.equal(detectarDatoSensible('mi Instagram es bonito, ¿viste mis fotos?'), null);
  assert.equal(detectarDatoSensible('hablemos por WhatsApp, mi número es 51234567'), 'telefono');
});

test('cableado: app.js pide confirmación antes de enviar un dato sensible', () => {
  const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.ok(src.includes("from './seguridad.js'"), 'app.js debe importar detectarDatoSensible');
  assert.ok(src.includes('detectarDatoSensible(text)'), 'submitChat debe clasificar el texto');
  assert.ok(src.includes("data-act=\"chat-dato-si\""), 'debe existir el botón de enviar de todos modos');
  assert.ok(src.includes("data-act=\"chat-dato-no\""), 'debe existir el botón de revisar');
  assert.ok(src.includes("'chat-dato-si'"), 'onAppClick debe atender chat-dato-si');
  assert.ok(src.includes("'chat-dato-no'"), 'onAppClick debe atender chat-dato-no');
});
