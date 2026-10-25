import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PIELES, PELOS, PEINADOS, FONDOS, normalizarSpec, randomSpec, avatarSVG, avatarDataURI, esAvatarElegido,
} from '../src/avatares.js';

const balanceado = (svg) => {
  const abre = (svg.match(/<(?!\/)(?!\?)[a-zA-Z]+/g) || []).length;
  const autocierra = (svg.match(/\/>/g) || []).length;
  const cierra = (svg.match(/<\/[a-zA-Z]+>/g) || []).length;
  return abre === autocierra + cierra;
};

test('todas las combinaciones de peinado × fondo × extras dan un SVG bien formado y ligero', () => {
  for (let peinado = 0; peinado < PEINADOS.length; peinado++) {
    for (let fondo = 0; fondo < FONDOS.length; fondo++) {
      for (const extra of [0, 1]) {
        const svg = avatarSVG({ piel: 2, pelo: 1, peinado, fondo, barba: extra, gafas: extra });
        assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
        assert.ok(balanceado(svg), `peinado ${peinado} fondo ${fondo}`);
        assert.ok(avatarDataURI({ peinado, fondo }).length < 4000, 'cabe de sobra en un perfil');
      }
    }
  }
});

test('es determinista y cada opción cambia el dibujo', () => {
  const base = { piel: 1, pelo: 1, peinado: 0, fondo: 0, barba: 0, gafas: 0 };
  assert.equal(avatarSVG(base), avatarSVG({ ...base }));
  const variantes = [{ piel: 4 }, { pelo: 3 }, { peinado: 1 }, { fondo: 2 }, { barba: 1 }, { gafas: 1 }];
  for (const v of variantes) assert.notEqual(avatarSVG({ ...base, ...v }), avatarSVG(base), JSON.stringify(v));
  assert.equal(new Set(PEINADOS.map((_, i) => avatarSVG({ ...base, peinado: i }))).size, PEINADOS.length);
});

test('normalizarSpec: índices fuera de rango o basura no rompen nada', () => {
  const n = normalizarSpec({ piel: 99, pelo: -4, peinado: 'x', fondo: NaN, barba: 'sí', gafas: 0 });
  assert.deepEqual(n, { piel: PIELES.length - 1, peinado: 0, pelo: 0, fondo: 0, barba: 1, gafas: 0 });
  assert.ok(avatarSVG(null).startsWith('<svg'));
  assert.ok(PELOS.length === 5);
});

test('randomSpec respeta rangos y es reproducible con un rng fijo', () => {
  let i = 0; const rng = () => [0.1, 0.9, 0.5, 0.3, 0.2, 0.8][i++ % 6];
  const a = randomSpec(rng); i = 0;
  assert.deepEqual(a, randomSpec(rng));
  for (let k = 0; k < 200; k++) {
    const s = randomSpec();
    assert.deepEqual(s, normalizarSpec(s));
  }
});

test('avatarDataURI se decodifica a un SVG válido y se reconoce como elegido', () => {
  const url = avatarDataURI({ peinado: 3 });
  assert.ok(esAvatarElegido(url));
  assert.ok(!esAvatarElegido('https://x.test/f.jpg') && !esAvatarElegido('') && !esAvatarElegido(null));
  const svg = Buffer.from(url.split(',')[1], 'base64').toString('utf8');
  assert.equal(svg, avatarSVG({ peinado: 3 }));
  assert.ok(!/["'<>#\s]/.test(url), 'sin caracteres problemáticos en un atributo');
});
