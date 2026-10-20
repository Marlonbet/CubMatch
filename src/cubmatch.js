// CUBMATCH — capa de citas sobre Nostr (sin servidor).
//
// - Perfil: evento parameterized replaceable kind 30079, tags
//   [["d","cubmatch-v1"],["t","cubmatch"]], contenido = JSON del perfil.
//   Descubrimiento = query a relays por #t=cubmatch + kinds [30079].
// - Likes: reacciones NIP-25 kind 7, contenido "+" (o "-" = dislike),
//   tag "a" → coordenadas del perfil (30079:<pubkey>:cubmatch-v1).
//   Match mutuo = ambos se dieron "+" (detectado en cliente).
// - Chat: solo tras match mutuo, DMs kind 4 (ver red.js), enrutados al
//   inbox del destinatario (kind 10050, NIP-17) con fallback a messaging.
// - Identidad en red: kind 10002 (NIP-65, lista de relays) + kind 10050
//   (NIP-17, inbox de DMs). Se publican al crear cuenta y al publicar perfil.
// - Reportes: NIP-56, eventos kind 1984.
// - Bloqueos: lista local en localStorage (la maneja la UI).
//
// SEGURIDAD (C1): todo evento recibido se verifica con eventoValido()
// ANTES de parsearlo. Sin firma válida no existe el perfil/like.
//
// ARQUITECTURA v1.1: los fetches reciben el RelayPool y consultan el scope
// `discovery` (+ fallback a `messaging` si discovery está degradado y no
// hubo resultados). Las publicaciones infrecuentes van a los 4 relays.

import { eventoValido } from './red.js';

export const KIND_PERFIL = 30079;
export const KIND_LIKE = 7;        // NIP-25: "+" like, "-" dislike
export const KIND_REPORTE = 1984;  // NIP-56
export const KIND_RELAY_LIST = 10002; // NIP-65: lista de relays del usuario
export const KIND_DM_INBOX = 10050;   // NIP-17: relays donde recibo DMs
export const TAG_D = 'cubmatch-v1';
export const TAG_T = 'cubmatch';
export const INBOX_TTL_MS = 24 * 3600 * 1000; // caché del inbox ajeno

export const profileAddr = (pubkey) => `${KIND_PERFIL}:${pubkey}:${TAG_D}`;

export function pubkeyFromAddr(addr) {
  const m = /^30079:([0-9a-f]{64}):cubmatch-v1$/.exec(addr || '');
  return m ? m[1] : null;
}

export function buildPerfilEvent(profile) {
  const body = { ...profile, v: 1, actualizado: Date.now() };
  return {
    kind: KIND_PERFIL,
    tags: [['d', TAG_D], ['t', TAG_T]],
    content: JSON.stringify(body),
  };
}

export function parsePerfilEvent(ev) {
  if (!ev || ev.kind !== KIND_PERFIL) return null;
  const d = (ev.tags.find((t) => t[0] === 'd') || [])[1] || '';
  if (d !== TAG_D) return null;
  let body;
  try { body = JSON.parse(ev.content); } catch { return null; }
  if (!body || body.v !== 1 || !body.apodo) return null;
  return {
    profile: body,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    id: ev.id,
    addr: profileAddr(ev.pubkey),
  };
}

export function publishPerfil(pool, profile) {
  return pool.publishAll(buildPerfilEvent(profile));
}

// Descubre perfiles: 1 por autor (se queda el más reciente), sin ocultos,
// sin el propio. `since` (segundos) limita a eventos nuevos para sync
// incremental. Devuelve [{profile, pubkey, created_at, id, addr}].
async function fetchPerfilesFrom(client, { limit = 300, since = 0, includeHidden = false, excludeSelf = null } = {}) {
  const porAutor = new Map();
  const vistos = new Set(); // ids ya verificados en esta suscripción (un evento llega por cada relay)
  const filter = { kinds: [KIND_PERFIL], '#t': [TAG_T], limit };
  if (since > 0) filter.since = since;
  const sub = client.subscribe(
    [filter],
    (ev) => {
      if (!ev || typeof ev.id !== 'string' || vistos.has(ev.id)) return;
      vistos.add(ev.id);
      if (!eventoValido(ev)) { console.warn('[cubmatch] perfil con firma inválida, descartado:', ev.id); return; }
      const p = parsePerfilEvent(ev);
      if (!p) return;
      if (excludeSelf && p.pubkey === excludeSelf) return;
      if (!includeHidden && p.profile.oculto) return;
      const prev = porAutor.get(p.pubkey);
      if (!prev || p.created_at > prev.created_at) porAutor.set(p.pubkey, p);
    }
  );
  await sub.eose();
  sub.unsub();
  return [...porAutor.values()];
}

export async function fetchPerfiles(pool, opts = {}) {
  const res = await fetchPerfilesFrom(pool.discovery(), opts);
  if (res.length === 0 && pool.scopeDegraded('discovery')) {
    return fetchPerfilesFrom(pool.messaging(), opts);
  }
  return res;
}

// Fusión incremental (caché + red): dedup por id de evento; en el
// reemplazable 30079 gana el created_at más nuevo por autor.
export function mergePerfiles(cached, fresh) {
  const porAutor = new Map();
  const vistos = new Set();
  for (const p of cached || []) {
    if (!p || typeof p.id !== 'string' || vistos.has(p.id)) continue;
    vistos.add(p.id);
    porAutor.set(p.pubkey, p);
  }
  for (const p of fresh || []) {
    if (!p || typeof p.id !== 'string' || vistos.has(p.id)) continue;
    vistos.add(p.id);
    const prev = porAutor.get(p.pubkey);
    if (!prev || p.created_at > prev.created_at) porAutor.set(p.pubkey, p);
  }
  return [...porAutor.values()];
}

// ---- Likes (NIP-25) ----
export function buildLikeEvent(targetPubkey, { superlike = false } = {}) {
  const tags = [['a', profileAddr(targetPubkey)], ['p', targetPubkey], ['t', TAG_T]];
  if (superlike) tags.push(['superlike', '1']);
  return { kind: KIND_LIKE, tags, content: '+' };
}

export function buildDislikeEvent(targetPubkey) {
  return {
    kind: KIND_LIKE,
    tags: [['a', profileAddr(targetPubkey)], ['p', targetPubkey], ['t', TAG_T]],
    content: '-',
  };
}

export function sendLike(pool, targetPubkey, opts) {
  return pool.publishAll(buildLikeEvent(targetPubkey, opts));
}

export function sendDislike(pool, targetPubkey) {
  return pool.publishAll(buildDislikeEvent(targetPubkey));
}

export function parseLikeEvent(ev, myPubkey) {
  if (!ev || ev.kind !== KIND_LIKE) return null;
  if (ev.content !== '+' && ev.content !== '-') return null;
  const a = (ev.tags.find((t) => t[0] === 'a') || [])[1] || '';
  const target = pubkeyFromAddr(a);
  if (!target) return null;
  const superlike = ev.tags.some((t) => t[0] === 'superlike');
  const sent = ev.pubkey === myPubkey;
  return {
    tipo: ev.content, // '+' | '-'
    superlike,
    from: ev.pubkey,
    to: sent ? target : myPubkey,
    peer: sent ? target : ev.pubkey, // la otra parte en ambos casos
    created_at: ev.created_at,
    id: ev.id,
  };
}

// Likes enviados y recibidos respecto a mi perfil.
// Devuelve { sent: {peerPubkey: {tipo, superlike, ts}}, received: {...} }
// (se queda el más reciente por contraparte).
async function fetchLikesFrom(client, myPubkey, { since = 0 } = {}) {
  const myAddr = profileAddr(myPubkey);
  const sent = {}, received = {};
  const vistos = new Set(); // ids ya verificados en esta suscripción
  const put = (map, like) => {
    const prev = map[like.peer];
    if (!prev || like.created_at > prev.ts) {
      map[like.peer] = { tipo: like.tipo, superlike: like.superlike, ts: like.created_at };
    }
  };
  const f = (base) => (since > 0 ? { ...base, since } : base);
  const sub = client.subscribe(
    [
      f({ kinds: [KIND_LIKE], authors: [myPubkey], '#t': [TAG_T], limit: 500 }),
      f({ kinds: [KIND_LIKE], '#a': [myAddr], limit: 500 }),
    ],
    (ev) => {
      if (!ev || typeof ev.id !== 'string' || vistos.has(ev.id)) return;
      vistos.add(ev.id);
      if (!eventoValido(ev)) { console.warn('[cubmatch] like con firma inválida, descartado:', ev.id); return; }
      const like = parseLikeEvent(ev, myPubkey);
      if (!like) return;
      if (like.from === myPubkey) put(sent, like);
      else put(received, like);
    }
  );
  await sub.eose();
  sub.unsub();
  return { sent, received };
}

export async function fetchLikes(pool, myPubkey, opts = {}) {
  const res = await fetchLikesFrom(pool.discovery(), myPubkey, opts);
  const empty = Object.keys(res.sent).length === 0 && Object.keys(res.received).length === 0;
  if (empty && pool.scopeDegraded('discovery')) {
    return fetchLikesFrom(pool.messaging(), myPubkey, opts);
  }
  return res;
}

// Fusión incremental de likes: por contraparte gana el ts más nuevo.
export function mergeLikes(cached, fresh) {
  const out = {
    sent: { ...((cached || {}).sent || {}) },
    received: { ...((cached || {}).received || {}) },
  };
  for (const lado of ['sent', 'received']) {
    for (const [peer, cur] of Object.entries(((fresh || {})[lado]) || {})) {
      const prev = out[lado][peer];
      if (!prev || (cur.ts || 0) > (prev.ts || 0)) out[lado][peer] = cur;
    }
  }
  return out;
}

// Match mutuo = ambos se dieron "+". Devuelve [pubkey...].
export function mutualMatches(sent, received) {
  return Object.keys(sent).filter(
    (peer) => sent[peer].tipo === '+' && received[peer] && received[peer].tipo === '+'
  );
}

// ---- Listas de relays (NIP-65) e inbox de DMs (NIP-17) ----
function cleanRelayList(relays) {
  return [...new Set((relays || []).filter(
    (u) => typeof u === 'string' && (u.startsWith('wss://') || u.startsWith('ws://'))
  ))];
}

export function buildRelayListEvent(relays) {
  return { kind: KIND_RELAY_LIST, tags: cleanRelayList(relays).map((u) => ['r', u]), content: '' };
}

export function parseRelayListEvent(ev) {
  if (!ev || ev.kind !== KIND_RELAY_LIST) return null;
  return {
    relays: cleanRelayList(ev.tags.filter((t) => t[0] === 'r').map((t) => t[1])),
    pubkey: ev.pubkey, created_at: ev.created_at, id: ev.id,
  };
}

export function buildDMInboxEvent(relays) {
  return { kind: KIND_DM_INBOX, tags: cleanRelayList(relays).map((u) => ['r', u]), content: '' };
}

export function parseDMInboxEvent(ev) {
  if (!ev || ev.kind !== KIND_DM_INBOX) return null;
  return {
    relays: cleanRelayList(ev.tags.filter((t) => t[0] === 'r').map((t) => t[1])),
    pubkey: ev.pubkey, created_at: ev.created_at, id: ev.id,
  };
}

// Publica los documentos de identidad: dónde encontrarme (10002, NIP-65)
// y dónde recibo DMs (10050, NIP-17). Best-effort: si falla, los fallbacks
// de lectura lo cubren (descubrimiento en discovery+messaging, DMs a messaging).
export function publishIdentityDocs(pool) {
  const all = [...pool.roles.discovery, ...pool.roles.messaging];
  return Promise.all([
    pool.publishAll(buildRelayListEvent(all)),
    pool.publishAll(buildDMInboxEvent(pool.roles.messaging)),
  ]);
}

// ---- Inbox ajeno (para enrutar DMs) ----
// Caché con TTL 24h. La app conecta este store a localStorage en el boot;
// en tests usa el mapa en memoria.
const _memInbox = new Map();
let _inboxStore = {
  get: (k) => (_memInbox.has(k) ? _memInbox.get(k) : null),
  set: (k, v) => { _memInbox.set(k, v); },
};
export function setInboxStore(store) { _inboxStore = store; }

async function fetchOneReplaceable(pool, filters) {
  let best = null;
  const vistos = new Set();
  const run = (client) => new Promise((resolve) => {
    const sub = client.subscribe(filters, (ev) => {
      if (!ev || typeof ev.id !== 'string' || vistos.has(ev.id)) return;
      vistos.add(ev.id);
      if (!eventoValido(ev)) { console.warn('[cubmatch] evento con firma inválida, descartado:', ev.id); return; }
      if (!best || ev.created_at > best.created_at) best = ev;
    });
    sub.eose().then(() => { sub.unsub(); resolve(); });
  });
  await run(pool.discovery());
  if (!best && pool.scopeDegraded('discovery')) await run(pool.messaging());
  return best;
}

// Inbox (kind 10050) del peer, o null si no publica (versión vieja).
export async function fetchDMInbox(pool, peerPubkey) {
  const key = 'inbox:' + peerPubkey;
  try {
    const cached = _inboxStore.get(key);
    if (cached && Array.isArray(cached.relays) && Date.now() - cached.ts < INBOX_TTL_MS) {
      return cached.relays;
    }
  } catch { /* sigue a la red */ }
  const ev = await fetchOneReplaceable(pool, [{ kinds: [KIND_DM_INBOX], authors: [peerPubkey], limit: 5 }]);
  const parsed = ev ? parseDMInboxEvent(ev) : null;
  const relays = parsed && parsed.relays.length ? parsed.relays : null;
  if (relays) {
    try { _inboxStore.set(key, { relays, ts: Date.now() }); } catch { /* caché opcional */ }
  }
  return relays;
}

// Relays donde enviarle DM al peer: intersección de su inbox con el
// scope messaging de MI pool; si no publica inbox (versión vieja) o no hay
// intersección, todo mi messaging.
export async function resolveDMTargets(pool, peerPubkey) {
  const mine = pool.roles.messaging;
  let inbox = null;
  try { inbox = await fetchDMInbox(pool, peerPubkey); } catch { inbox = null; }
  if (inbox && inbox.length) {
    const inter = inbox.filter((u) => mine.includes(u));
    if (inter.length) return inter;
  }
  return mine.slice();
}

export async function sendDMRouted(pool, peerPubkey, text) {
  const targets = await resolveDMTargets(pool, peerPubkey);
  return pool.publishDM(peerPubkey, text, targets);
}

// ---- Reportes (NIP-56) ----
export function buildReporteEvent(targetPubkey, motivo) {
  return {
    kind: KIND_REPORTE,
    tags: [['p', targetPubkey], ['t', TAG_T]],
    content: JSON.stringify({ v: 1, motivo: String(motivo || '').slice(0, 280), ts: Date.now() }),
  };
}

export function sendReporte(pool, targetPubkey, motivo) {
  return pool.publishAll(buildReporteEvent(targetPubkey, motivo));
}

export function parseReporteEvent(ev) {
  if (!ev || ev.kind !== KIND_REPORTE) return null;
  const p = (ev.tags.find((t) => t[0] === 'p') || [])[1] || '';
  if (!/^[0-9a-f]{64}$/.test(p)) return null;
  let body;
  try { body = JSON.parse(ev.content); } catch { return null; }
  return { target: p, motivo: body.motivo || '', reporter: ev.pubkey, created_at: ev.created_at, id: ev.id };
}
