// Borrado para ambos (v1.12.16), regla JUSTA: solo el autor puede
// borrar su propio mensaje, y el borrado deja huella visible en
// ambos lados (nunca silencioso). El borrado viaja como DM cifrado
// (payload {t:'borrar', id}), no como evento público kind 5.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBorrarPayload, parseChatPayload } from '../src/chatx.js';
import { aplicarBorrado } from '../src/mensajes.js';

const ID = 'a'.repeat(64);
const ID2 = 'b'.repeat(64);

test('payload borrar: ida y vuelta, y rechazo de ids hostiles', () => {
  const p = parseChatPayload(buildBorrarPayload(ID));
  assert.deepEqual(p, { tipo: 'borrar', id: ID });
  assert.equal(parseChatPayload(JSON.stringify({ t: 'borrar' })), null);
  assert.equal(parseChatPayload(JSON.stringify({ t: 'borrar', id: 'tmp:123' })), null);
  assert.equal(parseChatPayload(JSON.stringify({ t: 'borrar', id: 'xyz' })), null);
  assert.throws(() => buildBorrarPayload('tmp:123'), /id de mensaje inválido/);
  assert.throws(() => buildBorrarPayload(ID.slice(0, 63)), /id de mensaje inválido/);
});

test('regla justa: solo el autor borra lo suyo', () => {
  const lista = [
    { id: ID, from: 'me', ts: 1, text: 'hola' },
    { id: ID2, from: 'peer', ts: 2, text: 'hola a ti' },
  ];
  // Yo borro mi mensaje: aplica, contenido fuera, huella queda.
  assert.equal(aplicarBorrado(lista, ID, true), true);
  assert.equal(lista[0].text, '');
  assert.equal(lista[0].eliminado, true);
  assert.equal(lista[0].id, ID); // id, autor y hora quedan: huella visible
  // Yo NO puedo borrar el mensaje del otro para ambos.
  assert.equal(aplicarBorrado(lista, ID2, true), false);
  assert.equal(lista[1].text, 'hola a ti');
  // El otro sí puede borrar el suyo (esMio=false = lo manda el peer).
  assert.equal(aplicarBorrado(lista, ID2, false), true);
  assert.equal(lista[1].eliminado, true);
  // El otro NO puede borrar lo mío.
  const lista2 = [{ id: ID, from: 'me', ts: 1, text: 'hola' }];
  assert.equal(aplicarBorrado(lista2, ID, false), false);
  assert.equal(lista2[0].text, 'hola');
});

test('borrado: idempotente y no toca registros de llamada', () => {
  const lista = [
    { id: ID, from: 'me', ts: 1, text: 'hola' },
    { id: ID2, tipo: 'call', text: '📞 Llamada' },
  ];
  assert.equal(aplicarBorrado(lista, ID, true), true);
  assert.equal(aplicarBorrado(lista, ID, true), false); // segundo borrado: nada
  assert.equal(aplicarBorrado(lista, ID2, true), false); // llamada: intacta
  assert.equal(lista[1].text, '📞 Llamada');
});

test('cableado: el borrado se aplica en sync, en vivo y en global, y nunca se pinta ni se notifica', () => {
  const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.ok(src.includes('if (r.borrar)'), 'los tres caminos deben ramificar r.borrar');
  assert.ok(src.includes('aplicarBorrarEnChat(r.peer, r.borrar, r.fromMe)'), 'debe aplicar el borrado con su autor');
  assert.ok(src.includes('chats_borrados'), 'debe guardar lápidas para el borrado-antes-que-el-mensaje');
  assert.ok(src.includes('x.por === ev.pubkey'), 'la lápida solo descarta DMs del autor del borrado');
  assert.ok(src.includes('data-borrar-mid'), 'los mensajes propios deben llevar marca para tocar');
  assert.ok(src.includes('Mensaje eliminado'), 'la huella visible debe existir');
  assert.ok(src.includes("'chat-borrar-si'"), 'debe existir la acción de confirmar borrado');
  assert.ok(src.includes("'chat-borrar-no'"), 'debe existir la acción de cancelar borrado');
  assert.ok(src.includes('!m.eliminado'), 'noLeidos no debe contar eliminados');
});
