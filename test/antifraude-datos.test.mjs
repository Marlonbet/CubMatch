// Punto 5 (refuerzos contra perfiles falsos y estafas), primer paso,
// v1.12.17 (invitación a salir de la app), v1.12.18 (códigos),
// v1.12.19 (contraseñas), v1.12.20 (regalo/paquete con pago por
// adelantado) y v1.12.21 (inversión que promete multiplicar el
// dinero): fricción al compartir datos sensibles en
// el chat. detectarDatoSensible clasifica un mensaje saliente como
// 'telefono' | 'codigo' | 'clave' | 'regalo' | 'inversion' | 'dinero' | 'externo' | null; la
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

test('codigo: pedir o compartir un código de verificación', () => {
  assert.equal(detectarDatoSensible('te paso mi código de verificación'), 'codigo');
  assert.equal(detectarDatoSensible('mi código es 482913'), 'codigo');
  assert.equal(detectarDatoSensible('pásame el código que te llegó por SMS'), 'codigo');
  assert.equal(detectarDatoSensible('te mando el código por aquí'), 'codigo');
  assert.equal(detectarDatoSensible('el código de confirmación es 123456'), 'codigo');
  assert.equal(detectarDatoSensible('mándame tu código para entrar'), 'codigo');
});

test('codigo: descuentos, código postal y códigos de puerta NO disparan; el número sigue siendo telefono', () => {
  assert.equal(detectarDatoSensible('¿tienes código de descuento para el cine?'), null);
  assert.equal(detectarDatoSensible('mi código postal es 10100'), null);
  assert.equal(detectarDatoSensible('el código de la puerta es 1234'), null);
  assert.equal(detectarDatoSensible('hablamos del código del candado luego'), null);
  assert.equal(detectarDatoSensible('te paso mi código, es 51234567'), 'telefono');
});

test('clave: pedir o compartir una contraseña', () => {
  assert.equal(detectarDatoSensible('mi contraseña es Cubita123'), 'clave');
  assert.equal(detectarDatoSensible('mi clave es: 9876'), 'clave');
  assert.equal(detectarDatoSensible('pásame tu contraseña para ayudarte'), 'clave');
  assert.equal(detectarDatoSensible('¿cuál es tu contraseña?'), 'clave');
  assert.equal(detectarDatoSensible('te doy mi contraseña por aquí'), 'clave');
  assert.equal(detectarDatoSensible('dime tu clave y te lo arreglo'), 'clave');
});

test('clave: hablar de una contraseña sin compartirla ni pedirla NO dispara; el código sigue antes', () => {
  assert.equal(detectarDatoSensible('olvidé mi contraseña y no puedo entrar'), null);
  assert.equal(detectarDatoSensible('voy a cambiar mi contraseña esta noche'), null);
  assert.equal(detectarDatoSensible('la contraseña de mi wifi es larga'), null);
  assert.equal(detectarDatoSensible('mi código de verificación es 123456'), 'codigo');
  assert.equal(detectarDatoSensible('mi contraseña es 51234567'), 'telefono');
});

test('regalo: paquete o premio que hay que pagar para recibirlo', () => {
  assert.equal(detectarDatoSensible('te quiero mandar un regalo, solo tienes que pagar el envío'), 'regalo');
  assert.equal(detectarDatoSensible('el paquete está en aduana, hay que pagar para liberarlo'), 'regalo');
  assert.equal(detectarDatoSensible('ganaste un premio, paga los impuestos para recibirlo'), 'regalo');
  assert.equal(detectarDatoSensible('para recibir el paquete tienes que pagar'), 'regalo');
  assert.equal(detectarDatoSensible('te mando un obsequio, la tarifa de envío la pagas tú'), 'regalo');
});

test('regalo: un regalo sin pago, o un envío que ya llegó, NO disparan; el dinero sigue después', () => {
  assert.equal(detectarDatoSensible('te compré un regalo de cumpleaños'), null);
  assert.equal(detectarDatoSensible('el envío del paquete llegó bien, gracias'), null);
  assert.equal(detectarDatoSensible('me llegó un paquete de mi familia'), null);
  assert.equal(detectarDatoSensible('voy a pagar el pasaje mañana'), null);
  // Aquí el aviso sale como 'dinero' (el patrón de regalo pide la
  // palabra de pago DESPUÉS del regalo, o aduana/impuesto/pago
  // antes; "envío" antes del regalo no basta, para no marcar un
  // envío que ya llegó). Cuando ambos patrones casan, regalo va
  // antes que dinero en el código:
  assert.equal(detectarDatoSensible('mándame dinero para el envío del regalo'), 'dinero');
  assert.equal(detectarDatoSensible('te mando un regalo, mándame dinero para el envío'), 'regalo');
});

test('inversion: promesa de multiplicar el dinero o ganancias garantizadas', () => {
  assert.equal(detectarDatoSensible('invierte 100 y te devuelvo el doble'), 'inversion');
  assert.equal(detectarDatoSensible('te duplico tu dinero en una semana'), 'inversion');
  assert.equal(detectarDatoSensible('invierte en criptomonedas y gana mucho'), 'inversion');
  assert.equal(detectarDatoSensible('ganancias seguras con trading, invierte ya'), 'inversion');
  assert.equal(detectarDatoSensible('inversión garantizada, sin riesgo'), 'inversion');
  assert.equal(detectarDatoSensible('te doy el triple en 24 horas'), 'inversion');
  assert.equal(detectarDatoSensible('invierte en bitcoin y duplica tu dinero'), 'inversion');
  assert.equal(detectarDatoSensible('con bitcoin duplicas tu dinero'), 'inversion');
  assert.equal(detectarDatoSensible('retorno garantizado si inviertes hoy'), 'inversion');
});

test('inversion: hablar de inversiones sin promesa NO dispara; el número sigue siendo telefono', () => {
  assert.equal(detectarDatoSensible('invertí en mi negocio el año pasado'), null);
  assert.equal(detectarDatoSensible('¿invertiste en criptomonedas?'), null);
  assert.equal(detectarDatoSensible('trabajo en trading desde hace años'), null);
  assert.equal(detectarDatoSensible('el bitcoin subió mucho esta semana'), null);
  assert.equal(detectarDatoSensible('¿qué opinas de las criptomonedas?'), null);
  assert.equal(detectarDatoSensible('te doy el doble de amor'), null);
  assert.equal(detectarDatoSensible('te devuelvo el libro mañana'), null);
  assert.equal(detectarDatoSensible('invierte y te devuelvo el doble, mi número es 51234567'), 'telefono');
  assert.equal(detectarDatoSensible('te paso mi código, invierte y gana el doble'), 'codigo');
  assert.equal(detectarDatoSensible('hazme una recarga para invertir'), 'dinero');
});

test('cableado: app.js pide confirmación antes de enviar un dato sensible', () => {
  const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.ok(src.includes("from './seguridad.js'"), 'app.js debe importar detectarDatoSensible');
  assert.ok(src.includes('detectarDatoSensible(text)'), 'submitChat debe clasificar el texto');
  assert.ok(src.includes("data-act=\"chat-dato-si\""), 'debe existir el botón de enviar de todos modos');
  assert.ok(src.includes("data-act=\"chat-dato-no\""), 'debe existir el botón de revisar');
  assert.ok(src.includes("'chat-dato-si'"), 'onAppClick debe atender chat-dato-si');
  assert.ok(src.includes("'chat-dato-no'"), 'onAppClick debe atender chat-dato-no');
  assert.ok(src.includes('¿Compartir un código?'), 'showDatoConfirm debe tener título para codigo');
  assert.ok(src.includes('¿Compartir una contraseña?'), 'showDatoConfirm debe tener título para clave');
  assert.ok(src.includes('¿Pagar por un regalo?'), 'showDatoConfirm debe tener título para regalo');
  assert.ok(src.includes('¿Invertir y ganar el doble?'), 'showDatoConfirm debe tener título para inversion');
});
