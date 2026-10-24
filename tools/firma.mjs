// Firma y verificación de las versiones "vivas" (auto-actualización).
//
// Esquema: ECDSA P-256 + SHA-256. Se firma el mensaje
//     "<versión>\n" + <bytes exactos de cubmatch-live.js>
// y la firma viaja en app/live/cubmatch-live.sig.json como
//     {"v":"<versión>","sig":"<base64, formato IEEE P1363 (r||s)>"}
// P-256 + WebCrypto funciona hasta en WebViews antiguos (Ed25519 no).
// Solo Node (node:crypto): sin dependencias.
import {
  generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey,
} from 'node:crypto';

export function generarParDeClaves() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicJwk: limpiarJwk(publicKey.export({ format: 'jwk' })),
  };
}

// JWK mínimo y estable: lo que importKey('jwk') necesita para verificar.
export function limpiarJwk(jwk) {
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

export function publicJwkDePem(privatePem) {
  const pub = createPublicKey(createPrivateKey(privatePem));
  return limpiarJwk(pub.export({ format: 'jwk' }));
}

export function mensajeFirmado(version, bytes) {
  return Buffer.concat([Buffer.from(String(version) + '\n', 'utf8'), Buffer.from(bytes)]);
}

// jsOBytes: string (se codifica en UTF-8, igual que writeFileSync) o bytes.
export function firmarLive(version, jsOBytes, privatePem) {
  const bytes = typeof jsOBytes === 'string' ? Buffer.from(jsOBytes, 'utf8') : Buffer.from(jsOBytes);
  const sig = sign('sha256', mensajeFirmado(version, bytes), {
    key: createPrivateKey(privatePem), dsaEncoding: 'ieee-p1363',
  });
  return { v: String(version), sig: sig.toString('base64') };
}

export function verificarLive(meta, jsOBytes, publicJwk) {
  try {
    if (!meta || typeof meta.v !== 'string' || typeof meta.sig !== 'string') return false;
    const bytes = typeof jsOBytes === 'string' ? Buffer.from(jsOBytes, 'utf8') : Buffer.from(jsOBytes);
    return verify('sha256', mensajeFirmado(meta.v, bytes), {
      key: createPublicKey({ key: limpiarJwk(publicJwk), format: 'jwk' }), dsaEncoding: 'ieee-p1363',
    }, Buffer.from(meta.sig, 'base64'));
  } catch { return false; }
}
