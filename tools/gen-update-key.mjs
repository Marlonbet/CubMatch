// Genera el par de claves con el que se firman las versiones vivas.
//   node tools/gen-update-key.mjs
// · update-key.private.pem  → SECRETA. No se sube a git (está en .gitignore).
//   Guárdala en un gestor de contraseñas o un USB; si la pierdes, tendrás que
//   publicar un nuevo build completo (dist/cubmatch.html) con una clave nueva.
// · update-key.pub.json     → pública. SÍ se sube a git; build.mjs la mete en el loader.
import { writeFileSync, existsSync } from 'node:fs';
import { generarParDeClaves } from './firma.mjs';

if (existsSync('update-key.private.pem') || existsSync('update-key.pub.json')) {
  console.error('Ya existe una clave (update-key.*). Bórrala a mano si de verdad quieres rotarla.');
  process.exit(1);
}
const { privatePem, publicJwk } = generarParDeClaves();
writeFileSync('update-key.private.pem', privatePem, { mode: 0o600 });
writeFileSync('update-key.pub.json', JSON.stringify(publicJwk, null, 2) + '\n');
console.log('Listo:\n  update-key.private.pem  (secreta, NO la subas)\n  update-key.pub.json     (pública, súbela)');
console.log('\nPara compilar firmando:\n  UPDATE_SIGNING_KEY=update-key.private.pem npm run build');
