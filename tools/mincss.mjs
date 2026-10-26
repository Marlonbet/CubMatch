// Minificación conservadora de CSS para el build de CubMatch (v1.12.2).
//
// Por qué existe: dist/cubmatch.html es UN SOLO archivo que se comparte
// por WhatsApp/Bluetooth y se descarga con datos móviles caros en Cuba.
// El JS ya sale minificado por esbuild, pero el CSS se incrustaba tal
// cual (46 KB con comentarios y saltos de línea). Minificarlo recorta
// ~10 KB del archivo (~21 %) sin tocar ninguna regla.
//
// Reglas de seguridad (lo que NO hace, para no romper el CSS):
//   - Las cadenas entre comillas se copian tal cual: ni se colapsa el
//     espacio dentro de "Segoe UI", ni de las áreas de grid
//     ("brand logobig"), ni de content: "".
//   - Los comentarios /* ... */ se borran solo fuera de cadenas.
//   - Nunca se quita el espacio ANTES de ':' (un selector descendiente
//     como `.a :hover` cambiaría de significado); solo se quita el
//     espacio DESPUÉS de ':' (declaraciones y @media).
//   - Los espacios alrededor de '+' y '-' se conservan: calc() los exige
//     (calc(100vh - var(--nav-total)) seguiría siendo válido).
//   - Sin nesting ni funciones nuevas: solo comentarios, espacios y ';}'.
//
// Solo Node, sin dependencias. Se prueba en test/mincss.test.mjs.
export function minificarCss(css) {
  // 1) Recorre el texto separando cadenas (verbatim) de código.
  //    Los comentarios fuera de cadenas se descartan.
  const partes = []; // { tipo: 'codigo' | 'cadena', texto }
  let buf = '';
  let i = 0;
  const n = css.length;
  const vaciarCodigo = () => {
    if (buf) { partes.push({ tipo: 'codigo', texto: buf }); buf = ''; }
  };
  while (i < n) {
    const c = css[i];
    const sig = css[i + 1];
    if (c === '/' && sig === '*') {
      const fin = css.indexOf('*/', i + 2);
      i = fin === -1 ? n : fin + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      vaciarCodigo();
      let j = i + 1;
      let cadena = c;
      while (j < n) {
        cadena += css[j];
        if (css[j] === '\\') { cadena += css[j + 1] || ''; j += 2; continue; }
        if (css[j] === c) { j += 1; break; }
        j += 1;
      }
      partes.push({ tipo: 'cadena', texto: cadena });
      i = j;
      continue;
    }
    buf += c;
    i += 1;
  }
  vaciarCodigo();

  // 2) Minifica solo el código. Un segmento de solo espacios entre dos
  //    cadenas (p. ej. entre áreas de grid) queda como un solo espacio.
  return partes.map((p, idx) => {
    if (p.tipo === 'cadena') return p.texto;
    if (!/\S/.test(p.texto)) {
      return (idx > 0 && idx < partes.length - 1) ? ' ' : '';
    }
    return p.texto
      .replace(/\s+/g, ' ')
      .replace(/\s*([{};,])\s*/g, '$1')
      .replace(/:\s+/g, ':')
      .replace(/;}/g, '}')
      .trim();
  }).join('');
}
