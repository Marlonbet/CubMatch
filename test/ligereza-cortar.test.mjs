// Tests de ligereza (v1.12.9, punto 4: ligereza de datos).
// llamadas.js traía el par "avisar `end` + _terminar" copiado 15
// veces: timeouts de timbre/conexión, ICE muerto, restart de ICE,
// errores de medios, límite de relevo, colgar y liberar pegada.
// Ahora vive en una sola definición — _cortar — y cada sitio la
// llama con su resultado (y su mensaje, cuando lo hay): el aviso
// `end` es el mismo en todos. Si alguna copia vuelve, el bundle
// vuelve a crecer y estos tests lo cazan por el conteo en fuente,
// por el comportamiento y por el tamaño.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { buildSync } from 'esbuild';
import { CallSession } from '../src/llamadas.js';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function bundle() {
  const r = buildSync({
    entryPoints: [new URL('src/entry.js', ROOT).pathname],
    bundle: true,
    minify: true,
    charset: 'utf8',
    format: 'iife',
    target: ['es2020'],
    write: false,
    logLevel: 'silent',
  });
  let js = r.outputFiles[0].text;
  js = js.replace('__APP_VERSION__', '1.12.9');
  js = js.split('__TURNMD_APP__').join('').split('__TURNMD_APIKEY__').join('');
  return js;
}

test('_cortar: el payload `end` vive una sola vez y se usa en los 13 cierres', () => {
  const src = read('src/llamadas.js');
  assert.equal((src.match(/_cortar\(cur, resultado, mensaje\) \{/g) || []).length, 1,
    '_cortar debe definirse una sola vez');
  assert.equal((src.match(/op: 'end', media: cur\.media/g) || []).length, 1,
    'la construcción del payload `end` debe vivir solo en _cortar');
  assert.equal((src.match(/this\._cortar\(cur, /g) || []).length, 13,
    'los 13 cierres avisados deben pasar por _cortar');
  assert.ok(src.includes("this._cortar(cur, 'limite')"), 'el límite debe cortar por _cortar');
  assert.ok(src.includes("this._cortar(cur, 'error', mensajeErrorMedios(err, cur.media))"),
    'el error de medios debe cortar por _cortar con su mensaje');
  // _liberarPegada y colgar eligen el resultado y cortan una sola vez.
  assert.ok(src.includes("const resultado = (this.state === 'conectada' || this._connectedAt) ? 'completada'"),
    '_liberarPegada debe elegir el resultado y cortar una sola vez');
});

test('_cortar: avisa `end` antes de terminar, con el resultado y el mensaje dados', () => {
  const orden = [];
  const ses = new CallSession({
    createPC: () => { throw new Error('sin PC en este test'); },
    getLocalStream: async () => null,
    send: (peer, payload) => { orden.push(['end-enviado', peer, payload.op, payload.id, payload.media]); },
    onEvent: (e) => { orden.push([e.tipo, e.resultado, e.mensaje]); },
    nowFn: () => 1000000,
  });
  const cur = { id: 'call-0123456789abcdef', peer: 'peerPK', media: 'audio', dir: 'saliente' };
  ses.current = cur;
  ses._setState('conectada');
  ses._cortar(cur, 'error', 'micrófono denegado');
  assert.deepEqual(orden, [
    ['end-enviado', 'peerPK', 'end', 'call-0123456789abcdef', 'audio'],
    ['terminada', 'error', 'micrófono denegado'],
  ], 'primero el aviso `end` al par, luego la terminación local');
  assert.equal(ses.state, 'idle');
});

test('bundle: el vivo baja de peso con la deduplicación', () => {
  const js = bundle();
  const bytes = Buffer.byteLength(js);
  // v1.12.8 medido: 209.618 B. Con los 15 cierres unificados en
  // _cortar baja sin cambiar funciones; el tope caza si vuelve
  // alguna copia del par `end` + `_terminar`.
  assert.ok(bytes < 209618, `el bundle debe bajar de 209618 B, tiene ${bytes}`);
  assert.ok(js.includes('__cubmatchApp'), 'falta la app en el bundle');
  assert.ok(!js.includes('__APP_VERSION__'), 'sin placeholders sin reemplazar');
});
