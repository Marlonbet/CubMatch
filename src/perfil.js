// CUBMATCH — modelo de perfil: listas de opciones cubanas, fábrica,
// score de completitud 0-100% y avatar SVG determinista.
// Puro (sin DOM): testeable en Node.

export const PROVINCIAS = [
  'Pinar del Río', 'Artemisa', 'La Habana', 'Mayabeque', 'Matanzas',
  'Cienfuegos', 'Villa Clara', 'Sancti Spíritus', 'Ciego de Ávila',
  'Camagüey', 'Las Tunas', 'Granma', 'Holguín', 'Santiago de Cuba',
  'Guantánamo', 'Isla de la Juventud',
];

// Provincias vecinas (para distancia "provincias vecinas").
export const VECINAS = {
  'Pinar del Río': ['Artemisa'],
  'Artemisa': ['Pinar del Río', 'La Habana', 'Mayabeque'],
  'La Habana': ['Artemisa', 'Mayabeque'],
  'Mayabeque': ['La Habana', 'Artemisa', 'Matanzas'],
  'Matanzas': ['Mayabeque', 'Cienfuegos', 'Villa Clara'],
  'Cienfuegos': ['Matanzas', 'Villa Clara', 'Sancti Spíritus'],
  'Villa Clara': ['Matanzas', 'Cienfuegos', 'Sancti Spíritus', 'Ciego de Ávila'],
  'Sancti Spíritus': ['Villa Clara', 'Cienfuegos', 'Ciego de Ávila'],
  'Ciego de Ávila': ['Sancti Spíritus', 'Villa Clara', 'Camagüey'],
  'Camagüey': ['Ciego de Ávila', 'Las Tunas'],
  'Las Tunas': ['Camagüey', 'Granma', 'Holguín'],
  'Granma': ['Las Tunas', 'Holguín', 'Santiago de Cuba'],
  'Holguín': ['Las Tunas', 'Granma', 'Santiago de Cuba', 'Guantánamo'],
  'Santiago de Cuba': ['Granma', 'Holguín', 'Guantánamo'],
  'Guantánamo': ['Holguín', 'Santiago de Cuba'],
  'Isla de la Juventud': [],
};

export const GENEROS = [
  { id: 'mujer', label: 'Mujer' },
  { id: 'hombre', label: 'Hombre' },
  { id: 'nobinario', label: 'No binario' },
];

export const ORIENTACIONES = [
  { id: 'hetero', label: 'Heterosexual' },
  { id: 'homo', label: 'Homosexual' },
  { id: 'bi', label: 'Bisexual' },
];

export const COMPLEXIONES = ['Delgada', 'Atlética', 'Promedio', 'Robusta'];
export const OJOS = ['Marrones', 'Negros', 'Verdes', 'Azules', 'Miel'];
export const PIEL = ['Clara', 'Trigueña', 'Morena', 'Negra'];
export const CABELLO = ['Negro', 'Castaño', 'Rubio', 'Pelirrojo', 'Canoso', 'Rapado'];
export const EDUCACION = ['Primaria', 'Secundaria', 'Preuniversitario', 'Técnico medio', 'Universitario', 'Posgrado'];
export const SECTORES = ['Salud', 'Educación', 'Turismo', 'Agricultura', 'Industria', 'Comercio', 'Transporte', 'Tecnología', 'Arte/Cultura', 'Deporte', 'Cuenta propia', 'Otro'];

export const VALORES = [
  'familia', 'ambición', 'humor', 'honestidad', 'lealtad', 'aventura',
  'tranquilidad', 'espiritualidad', 'respeto', 'sencillez', 'superación', 'solidaridad',
];

export const INTERESES = [
  'música', 'comida cubana', 'deporte', 'cine', 'lectura', 'baile',
  'playa', 'dominó', 'fútbol', 'béisbol', 'viajes', 'fotografía',
  'cocina', 'fiestas', 'naturaleza', 'videojuegos',
];

export const RASGOS = [
  { id: 'extroversion', label: 'Extroversión' },
  { id: 'amabilidad', label: 'Amabilidad' },
  { id: 'responsabilidad', label: 'Responsabilidad' },
  { id: 'apertura', label: 'Apertura' },
  { id: 'calma', label: 'Calma' },
];

export const RELACIONES = [
  { id: 'amistad', label: 'Amistad' },
  { id: 'romance', label: 'Romance' },
  { id: 'seria', label: 'Relación seria' },
];

export const DISTANCIAS = [
  { id: 'misma', label: 'Mi provincia' },
  { id: 'vecinas', label: 'Provincias vecinas' },
  { id: 'cuba', label: 'Toda Cuba' },
];

export const PROMPTS = [
  'Un domingo perfecto para mí es…',
  'Lo que más me gusta de Cuba es…',
  'Nadie me cree cuando digo que…',
  'Mi comida cubana favorita es… porque…',
  'En una primera cita prefiero…',
  'Algo que quiero aprender este año…',
];

export const MAX_BIO = 600;
export const MAX_TAGS = 12;
export const MIN_COMPLETITUD = 70;

// Perfil nuevo, con valores por defecto.
export function newProfile() {
  return {
    v: 1,
    apodo: '', edad: '', genero: '', orientacion: '',
    provincia: '', municipio: '',
    estatura: '', complexion: '', ojos: '', piel: '', cabello: '',
    educacion: '', profesion: '', sector: '',
    fumador: '', bebedor: '', deporte: '', religion: '',
    hijosTiene: '', hijosQuiere: '', mascotas: '',
    valores: [], rasgos: { extroversion: 3, amabilidad: 3, responsabilidad: 3, apertura: 3, calma: 3 },
    intereses: [], tags: [],
    bio: '', prompts: [], tresPalabras: '', fotoURL: '', mostrarEdad: true,
    prefs: { edadMin: 18, edadMax: 99, generos: [], distancia: 'cuba', relacion: [] },
    // Videollamadas (v1.7.0): opt-in del receptor, por defecto NO.
    // Viaja en el perfil publicado (kind 30079) para que quien llama
    // pueda comprobarlo antes de marcar.
    videoOk: false,
    oculto: false,
    actualizado: Date.now(),
  };
}

const lleno = (v) => v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);

// Pesos del score de completitud (suman 100).
const PESOS = [
  ['apodo', 6], ['edad', 6], ['genero', 6], ['orientacion', 4], ['provincia', 5], ['municipio', 3],
  ['estatura', 3], ['complexion', 2], ['ojos', 2], ['piel', 1], ['cabello', 2],
  ['educacion', 4], ['profesion', 3], ['sector', 3],
  ['fumador', 2], ['bebedor', 2], ['deporte', 2], ['religion', 2], ['hijosTiene', 1], ['hijosQuiere', 1], ['mascotas', 1],
  ['valores', 5], ['rasgos', 5],
  ['intereses', 6], ['tags', 4],
  ['bio', 8], ['prompts', 5], ['tresPalabras', 2], ['fotoURL', 2],
  ['prefs', 6],
];

function prefsLleno(prefs) {
  if (!prefs) return false;
  return prefs.edadMin && prefs.edadMax && prefs.generos.length > 0 && prefs.relacion.length > 0;
}

function rasgosLlenos(rasgos) {
  // Se consideran "llenos" si el usuario movió al menos un slider del valor neutro.
  return rasgos && Object.values(rasgos).some((v) => v !== 3);
}

// Score de completitud 0-100. Solo perfiles >= MIN_COMPLETITUD (70) entran al matching.
export function completitud(p) {
  let pts = 0;
  for (const [campo, peso] of PESOS) {
    if (campo === 'prefs') { if (prefsLleno(p.prefs)) pts += peso; }
    else if (campo === 'rasgos') { if (rasgosLlenos(p.rasgos)) pts += peso; }
    else if (campo === 'prompts') { if (p.prompts && p.prompts.some((x) => x.q && x.a)) pts += peso; }
    else if (lleno(p[campo])) pts += peso;
  }
  return Math.min(100, Math.round(pts));
}

export function entraEnMatching(p) {
  return completitud(p) >= MIN_COMPLETITUD;
}

// ¿Aporta puntos este campo? Mismos criterios que completitud().
function campoLleno(p, campo) {
  if (!p) return false;
  if (campo === 'prefs') return prefsLleno(p.prefs);
  if (campo === 'rasgos') return rasgosLlenos(p.rasgos);
  if (campo === 'prompts') return !!(p.prompts && p.prompts.some((x) => x.q && x.a));
  return lleno(p[campo]);
}

// Catálogo de campos para la guía "Completa tu perfil":
// [campo, etiqueta amable, paso del editor de perfil (1-8)].
const FALTANTES_META = [
  ['apodo', 'Tu apodo', 1], ['edad', 'Tu edad', 1], ['genero', 'Tu género', 1],
  ['orientacion', 'Tu orientación', 1], ['provincia', 'Tu provincia', 1], ['municipio', 'Tu municipio', 1],
  ['estatura', 'Tu estatura', 2], ['complexion', 'Tu complexión', 2], ['ojos', 'Tu color de ojos', 2],
  ['piel', 'Tu piel', 2], ['cabello', 'Tu cabello', 2],
  ['educacion', 'Tu educación', 3], ['profesion', 'Tu profesión u oficio', 3], ['sector', 'Tu sector de trabajo', 3],
  ['fumador', 'Si fumas', 4], ['bebedor', 'Si bebes', 4], ['deporte', 'Si haces deporte', 4],
  ['religion', 'Tu religión o creencia', 4], ['hijosTiene', 'Si tienes hijos', 4],
  ['hijosQuiere', 'Si quieres hijos', 4], ['mascotas', 'Si tienes mascotas', 4],
  ['valores', 'Tus valores', 5], ['rasgos', 'Tus rasgos de personalidad', 5],
  ['intereses', 'Tus intereses', 6], ['tags', 'Tus tags libres', 6],
  ['bio', 'Tu bio', 7], ['prompts', 'Un prompt respondido', 7],
  ['tresPalabras', 'Tu descripción en 3 palabras', 7], ['fotoURL', 'Tu foto', 7],
  ['prefs', 'Tus preferencias de pareja', 8],
];

const PESO_DE = Object.fromEntries(PESOS);

// Campos que faltan por completar: [{campo, label, paso, peso}],
// ordenados por peso descendente (lo que más suma va primero).
export function camposFaltantes(p) {
  if (!p) return [];
  return FALTANTES_META
    .filter(([campo]) => !campoLleno(p, campo))
    .map(([campo, label, paso]) => ({ campo, label, paso, peso: PESO_DE[campo] || 0 }))
    .sort((a, b) => b.peso - a.peso);
}

// Validación de campos obligatorios para publicar.
export function validateProfile(p) {
  const errores = [];
  if (!lleno(p.apodo)) errores.push('Pon tu apodo.');
  const edad = Number(p.edad);
  if (!edad || edad < 18 || edad > 99) errores.push('La edad debe estar entre 18 y 99.');
  if (!lleno(p.genero)) errores.push('Elige tu género.');
  if (!lleno(p.orientacion)) errores.push('Elige tu orientación.');
  if (!lleno(p.provincia)) errores.push('Elige tu provincia.');
  if (!lleno(p.municipio)) errores.push('Escribe tu municipio.');
  if (!prefsLleno(p.prefs)) errores.push('Completa tus preferencias de pareja (edad, género, relación).');
  if (String(p.bio || '').length > MAX_BIO) errores.push(`La bio no puede pasar de ${MAX_BIO} caracteres.`);
  if ((p.tags || []).length > MAX_TAGS) errores.push(`Máximo ${MAX_TAGS} tags libres.`);
  return errores;
}

// ---- Avatar SVG determinista ----
// Sin subida de fotos (no hay servidor): avatar generado del apodo/pubkey
// + campo opcional fotoURL. Determinista: mismo seed → mismo avatar.
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function avatarSVG(seedStr, apodo) {
  const h = hashStr(String(seedStr || apodo || 'cubmatch'));
  const hue = h % 360;
  const hue2 = (hue + 40 + (h >> 8) % 60) % 360;
  const inicial = (String(apodo || '?').trim()[0] || '?').toUpperCase();
  const forma = (h >> 16) % 3; // 0: círculos, 1: ondas, 2: triángulos
  let deco = '';
  if (forma === 0) {
    deco = `<circle cx="150" cy="40" r="26" fill="hsl(${hue2},70%,60%)" opacity="0.55"/><circle cx="28" cy="150" r="18" fill="hsl(${hue2},70%,65%)" opacity="0.45"/>`;
  } else if (forma === 1) {
    deco = `<path d="M-10 140 Q 45 110 90 140 T 190 140" stroke="hsl(${hue2},70%,60%)" stroke-width="10" fill="none" opacity="0.5"/><circle cx="140" cy="45" r="14" fill="hsl(${hue2},70%,65%)" opacity="0.5"/>`;
  } else {
    deco = `<polygon points="150,20 172,58 128,58" fill="hsl(${hue2},70%,60%)" opacity="0.55"/><circle cx="35" cy="140" r="16" fill="hsl(${hue2},70%,65%)" opacity="0.45"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},72%,52%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},72%,44%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="180" height="180" fill="url(#g)"/>${deco}` +
    `<text x="90" y="118" font-family="system-ui,sans-serif" font-size="72" font-weight="700" fill="rgba(255,255,255,0.92)" text-anchor="middle">${inicial.replace(/[<>&]/g, '')}</text>` +
    `</svg>`;
  return svg;
}

export function avatarDataURI(seedStr, apodo) {
  return 'data:image/svg+xml,' + encodeURIComponent(avatarSVG(seedStr, apodo));
}

// Nivel de distancia entre dos provincias: 0 misma, 1 vecinas, 2 resto.
export function nivelDistancia(provA, provB) {
  if (!provA || !provB) return 2;
  if (provA === provB) return 0;
  if ((VECINAS[provA] || []).includes(provB)) return 1;
  return 2;
}

export const NIVEL_DISTANCIA_MAX = { misma: 0, vecinas: 1, cuba: 2 };
