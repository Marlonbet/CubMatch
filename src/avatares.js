// CUBMATCH — avatares combinables (SVG, sin descargas, sin servidor).
// Un avatar es una especificación pequeña {piel, peinado, pelo, fondo, barba,
// gafas} (índices) que se dibuja como SVG y viaja como data: URI en el campo
// `fotoURL` del perfil: los demás clientes lo muestran sin ningún código extra.
// 6 pieles × 8 peinados × 5 colores de pelo × 6 vitrales × barba × gafas.
// Puro (sin DOM): testeable en Node.

export const PIELES = ['#f3d3b5', '#e0aa7d', '#c68a5c', '#a4693f', '#7a4a2b', '#4f2f1c'];
export const PELOS = ['#16110d', '#3b2415', '#7a4a21', '#b58a3c', '#8a8f98'];
export const PEINADOS = ['corto', 'afro', 'rizos', 'largo', 'mono', 'gorra', 'trenzas', 'calvo'];
export const NOMBRES_PEINADO = ['Corto', 'Afro', 'Rizos', 'Largo', 'Moño', 'Gorra', 'Trenzas', 'Rapado'];
// Cada fondo son 5 vidrios del abanico (de izquierda a derecha).
export const FONDOS = [
  ['#2457c5', '#f2a516', '#d9423a', '#1f9a78', '#2457c5'], // vitral
  ['#1d6fa5', '#4fb3bf', '#a8dadc', '#2a9d8f', '#1d6fa5'], // mar
  ['#d9423a', '#f2a516', '#f28c6b', '#8e3b6b', '#d9423a'], // atardecer
  ['#1f9a78', '#8cc084', '#f2e394', '#2e6f57', '#1f9a78'], // monte
  ['#2b3a67', '#5b4b8a', '#2457c5', '#9a6fb0', '#2b3a67'], // noche
  ['#f2a516', '#f28c6b', '#fcd5a5', '#d9423a', '#f2a516'], // mamey
];
export const NOMBRES_FONDO = ['Vitral', 'Mar', 'Atardecer', 'Monte', 'Noche', 'Mamey'];

const TINTA = '#12304a';
const OJO = '#1a1210';
const clamp = (v, n) => { const i = Math.trunc(Number(v)); return Number.isFinite(i) ? Math.min(n - 1, Math.max(0, i)) : 0; };

export function normalizarSpec(s) {
  const x = s || {};
  return {
    piel: clamp(x.piel, PIELES.length), peinado: clamp(x.peinado, PEINADOS.length),
    pelo: clamp(x.pelo, PELOS.length), fondo: clamp(x.fondo, FONDOS.length),
    barba: x.barba ? 1 : 0, gafas: x.gafas ? 1 : 0,
  };
}

// rng: función () => [0,1). Por defecto Math.random.
export function randomSpec(rng = Math.random) {
  const r = (n) => Math.floor(rng() * n);
  return normalizarSpec({
    piel: r(PIELES.length), peinado: r(PEINADOS.length), pelo: r(PELOS.length), fondo: r(FONDOS.length),
    barba: rng() < 0.25, gafas: rng() < 0.25,
  });
}

function abanico(colores) {
  const R = 260;
  return colores.map((c, k) => {
    const p = (a) => (100 + R * Math.cos(a * Math.PI / 180)).toFixed(1) + ' ' + (200 - R * Math.sin(a * Math.PI / 180)).toFixed(1);
    return '<path d="M100 200L' + p(180 - 36 * k) + 'L' + p(144 - 36 * k) + 'Z" fill="' + c + '"/>';
  }).join('');
}

// Pelo detrás de la cabeza y pelo por delante, según el peinado.
function cabello(id, c, gorraColor) {
  const fleco = '<path d="M64 86C64 54 136 54 136 86C124 68 76 68 64 86Z" fill="' + c + '"/>';
  switch (id) {
    case 'afro': return ['<circle cx="100" cy="78" r="54" fill="' + c + '"/>', ''];
    case 'rizos': return [[[66, 86, 17], [76, 60, 18], [100, 50, 19], [124, 60, 18], [134, 86, 17]]
      .map(([x, y, r]) => '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + c + '"/>').join(''), ''];
    case 'largo': return ['<path d="M62 92C58 40 142 40 138 92L148 172H52Z" fill="' + c + '"/>', fleco];
    case 'mono': return ['<circle cx="100" cy="38" r="15" fill="' + c + '"/>', fleco];
    case 'gorra': return ['', '<path d="M64 84C64 48 136 48 136 84Z" fill="' + gorraColor + '"/><rect x="58" y="82" width="92" height="9" rx="4.5" fill="' + gorraColor + '"/>'];
    case 'trenzas': return ['<path d="M64 92C56 120 58 150 66 172M136 92C144 120 142 150 134 172" stroke="' + c + '" stroke-width="13" fill="none" stroke-linecap="round"/>', fleco];
    case 'calvo': return ['', ''];
    default: return ['', fleco]; // corto
  }
}

export function avatarSVG(spec) {
  const s = normalizarSpec(spec);
  const piel = PIELES[s.piel], pelo = PELOS[s.pelo], fondo = FONDOS[s.fondo];
  const [atras, delante] = cabello(PEINADOS[s.peinado], pelo, fondo[1]);
  const barba = s.barba ? '<path d="M70 100C72 138 128 138 130 100C120 120 80 120 70 100Z" fill="' + pelo + '"/>' : '';
  const gafas = s.gafas
    ? '<g fill="none" stroke="' + TINTA + '" stroke-width="3"><circle cx="85" cy="92" r="11"/><circle cx="115" cy="92" r="11"/><path d="M96 92H104"/></g>' : '';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">' + abanico(fondo)
    + '<path d="M28 200C28 158 66 142 100 142C134 142 172 158 172 200Z" fill="' + TINTA + '"/>'
    + atras
    + '<rect x="88" y="116" width="24" height="34" fill="' + piel + '"/>'
    + '<ellipse cx="100" cy="92" rx="34" ry="40" fill="' + piel + '"/>'
    + '<circle cx="66" cy="94" r="6" fill="' + piel + '"/><circle cx="134" cy="94" r="6" fill="' + piel + '"/>'
    + barba + delante
    + '<circle cx="87" cy="94" r="3.2" fill="' + OJO + '"/><circle cx="113" cy="94" r="3.2" fill="' + OJO + '"/>'
    + '<path d="M89 109Q100 119 111 109" stroke="' + OJO + '" stroke-width="3" fill="none" stroke-linecap="round"/>'
    + gafas + '</svg>';
}

// data: URI en base64 (sin caracteres que haya que escapar en un atributo).
export function avatarDataURI(spec) {
  const svg = avatarSVG(spec);
  const b64 = typeof btoa === 'function' ? btoa(svg) : Buffer.from(svg, 'utf8').toString('base64');
  return 'data:image/svg+xml;base64,' + b64;
}

export const esAvatarElegido = (url) => typeof url === 'string' && url.startsWith('data:image/svg+xml;base64,');
