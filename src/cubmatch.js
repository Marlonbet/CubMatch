// CUBMATCH — capa de citas sobre Nostr (sin servidor).
//
// - Perfil: evento parameterized replaceable kind 30079, tags
//   [["d","cubmatch-v1"],["t","cubmatch"]], contenido = JSON del perfil.
//   Descubrimiento = query a relays por #t=cubmatch + kinds [30079].
// - Likes: reacciones NIP-25 kind 7, contenido "+" (o "-" = dislike),
//   tag "a" → coordenadas del perfil (30079:<pubkey>:cubmatch-v1).
//   Match mutuo = ambos se dieron "+" (detectado en cliente).
// - Chat: solo tras match mutuo, DMs kind 4 (ver red.js).
// - Reportes: NIP-56, eventos kind 1984.
// - Bloqueos: lista local en localStorage (la maneja la UI).
//
// SEGURIDAD (C1): todo evento recibido se verifica con eventoValido()
// ANTES de parsearlo. Sin firma válida no existe el perfil/like.

import { eventoValido } from './red.js';

export const KIND_PERFIL = 30079;
export const KIND_LIKE = 7;        // NIP-25: "+" like, "-" dislike
export const KIND_REPORTE = 1984;  // NIP-56
export const TAG_D = 'cubmatch-v1';
export const TAG_T = 'cubmatch';

// Relays verificados funcionando desde Cuba sin VPN (2026-10-19).
export const RELAYS_DEFAULT = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr-pub.wellorder.net',
];

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

export function publishPerfil(client, profile) {
  return client.publish(buildPerfilEvent(profile));
}

// Descubre perfiles: 1 por autor (se queda el más reciente), sin ocultos,
// sin el propio. Devuelve [{profile, pubkey, created_at, id, addr}].
export async function fetchPerfiles(client, { limit = 300, includeHidden = false, excludeSelf = null } = {}) {
  const porAutor = new Map();
  const vistos = new Set(); // ids ya verificados en esta suscripción (un evento llega por cada relay)
  const sub = client.subscribe(
    [{ kinds: [KIND_PERFIL], '#t': [TAG_T], limit }],
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

export function sendLike(client, targetPubkey, opts) {
  return client.publish(buildLikeEvent(targetPubkey, opts));
}

export function sendDislike(client, targetPubkey) {
  return client.publish(buildDislikeEvent(targetPubkey));
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
export async function fetchLikes(client, myPubkey) {
  const myAddr = profileAddr(myPubkey);
  const sent = {}, received = {};
  const vistos = new Set(); // ids ya verificados en esta suscripción
  const put = (map, like) => {
    const prev = map[like.peer];
    if (!prev || like.created_at > prev.ts) {
      map[like.peer] = { tipo: like.tipo, superlike: like.superlike, ts: like.created_at };
    }
  };
  const sub = client.subscribe(
    [
      { kinds: [KIND_LIKE], authors: [myPubkey], '#t': [TAG_T], limit: 500 },
      { kinds: [KIND_LIKE], '#a': [myAddr], limit: 500 },
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

// Match mutuo = ambos se dieron "+". Devuelve [pubkey...].
export function mutualMatches(sent, received) {
  return Object.keys(sent).filter(
    (peer) => sent[peer].tipo === '+' && received[peer] && received[peer].tipo === '+'
  );
}

// ---- Reportes (NIP-56) ----
export function buildReporteEvent(targetPubkey, motivo) {
  return {
    kind: KIND_REPORTE,
    tags: [['p', targetPubkey], ['t', TAG_T]],
    content: JSON.stringify({ v: 1, motivo: String(motivo || '').slice(0, 280), ts: Date.now() }),
  };
}

export function sendReporte(client, targetPubkey, motivo) {
  return client.publish(buildReporteEvent(targetPubkey, motivo));
}

export function parseReporteEvent(ev) {
  if (!ev || ev.kind !== KIND_REPORTE) return null;
  const p = (ev.tags.find((t) => t[0] === 'p') || [])[1] || '';
  if (!/^[0-9a-f]{64}$/.test(p)) return null;
  let body;
  try { body = JSON.parse(ev.content); } catch { return null; }
  return { target: p, motivo: body.motivo || '', reporter: ev.pubkey, created_at: ev.created_at, id: ev.id };
}
