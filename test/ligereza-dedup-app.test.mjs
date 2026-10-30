// Tests de ligereza (v1.12.8, punto 4: ligereza de datos).
// app.js traía tres bloques copiados: (1) aplicar el perfil propio al
// entrar y al restaurar sesión (enterApp / restoreSession), (2) el
// registro de fin de llamada repetido 7 veces en el switch de
// 'terminada', y (3) el mismo toast de falta de conexión en 10 catch.
// Ahora cada uno vive en una sola definición — aplicarMiPerfil,
// registrarFinLlamada y avisoSinConexion — sin cambiar el
// comportamiento: el mapa de registrarFinLlamada conserva que
// 'limite' se registra como 'completada' y 'ocupado' como
// 'rechazada', y que 'error' no se registra. Si alguna copia vuelve,
// el bundle vuelve a crecer y estos tests lo cazan por el conteo en
// fuente y por el tamaño.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { buildSync } from 'esbuild';

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
  js = js.replace('__APP_VERSION__', '1.12.8');
  js = js.split('__TURNMD_APP__').join('').split('__TURNMD_APIKEY__').join('');
  return js;
}

test('aplicarMiPerfil: una sola definición usada por enterApp y restoreSession', () => {
  const app = read('src/app.js');
  assert.equal((app.match(/function aplicarMiPerfil\(mine\)/g) || []).length, 1,
    'aplicarMiPerfil debe definirse una sola vez');
  assert.equal((app.match(/aplicarMiPerfil\(mine\);/g) || []).length, 2,
    'enterApp y restoreSession deben llamar a aplicarMiPerfil');
  assert.equal((app.match(/^    S\.borrador = LS\.get\('perfil', null\) \|\| newProfile\(\);$/gm) || []).length, 1,
    'la rama sin perfil publicado debe vivir solo en aplicarMiPerfil');
  assert.ok(app.includes("LS.set('perfil', fusionarBorrador(mine.profile, LS.get('perfil', null)))"),
    'aplicarMiPerfil debe fusionar el borrador con lo publicado');
});

test('avisoSinConexion: el toast vive una sola vez y se usa en los 10 catch', () => {
  const app = read('src/app.js');
  assert.equal((app.match(/function avisoSinConexion\(\)/g) || []).length, 1,
    'avisoSinConexion debe definirse una sola vez');
  assert.equal((app.match(/avisoSinConexion\(\);/g) || []).length, 10,
    'los 10 catch deben avisar por avisoSinConexion');
  assert.equal(app.split('Sin conexión a los relays. Intenta de nuevo.').length - 1, 1,
    'el texto del aviso debe aparecer una sola vez en la fuente');
});

test('registrarFinLlamada: una sola definición con el mapa exacto de resultados', () => {
  const app = read('src/app.js');
  assert.equal((app.match(/function registrarFinLlamada\(e\)/g) || []).length, 1,
    'registrarFinLlamada debe definirse una sola vez');
  assert.equal((app.match(/registrarFinLlamada\(e\);/g) || []).length, 7,
    'los 7 casos del switch deben registrar por registrarFinLlamada');
  assert.equal((app.match(/textoRegistroLlamada\(\{ media: e\.media/g) || []).length, 1,
    'la llamada a textoRegistroLlamada debe vivir solo en registrarFinLlamada');
  assert.ok(app.includes("limite: 'completada'"), "'limite' debe registrarse como 'completada'");
  assert.ok(app.includes("ocupado: 'rechazada'"), "'ocupado' debe registrarse como 'rechazada'");
  assert.ok(!app.includes("error: "), 'registrarFinLlamada no debe registrar el resultado error');
});

test('bundle: el aviso queda una sola vez y el vivo baja de peso', () => {
  const js = bundle();
  const n = js.split('Sin conexión a los relays. Intenta de nuevo.').length - 1;
  assert.equal(n, 1, `esperaba 1 aparición del aviso, hay ${n}`);
  const bytes = Buffer.byteLength(js);
  // v1.12.7 medido: 210.298 B. Con las tres deduplicaciones baja a
  // 209.618 B sin cambiar funciones; el tope caza si alguna copia vuelve.
  assert.ok(bytes < 213000, `el bundle debe bajar de 210000 B (tope v1.12.16: 213000 B), tiene ${bytes}`);
  assert.ok(js.includes('__cubmatchApp'), 'falta la app en el bundle');
  assert.ok(!js.includes('__APP_VERSION__'), 'sin placeholders sin reemplazar');
});
