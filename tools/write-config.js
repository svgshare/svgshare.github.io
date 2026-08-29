#!/usr/bin/env node
/*
 * Escribe assets/config.js en el despliegue, a partir del entorno.
 *
 * Las dos credenciales son públicas por diseño —viajan en el navegador— así que
 * no son secretos que proteger, sino valores que no queremos fijar en el
 * repositorio: cada despliegue (o cada fork) usa los suyos. Su seguridad viene
 * de estar restringidas por origen en la consola de Google.
 *
 * Los valores se serializan con JSON.stringify, de modo que un valor con
 * comillas o saltos de línea no puede escaparse del literal ni inyectar código.
 *
 *   GOOGLE_CLIENT_ID   habilita guardar en Drive (el creador)
 *   GOOGLE_API_KEY     habilita leer de Drive sin sesión (el visor)
 *
 * Sin ninguna de las dos el fichero queda como está en el repositorio: vacío, y
 * el carril de Drive simplemente no aparece.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2] || path.join(__dirname, '..', 'assets', 'config.js');

const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
const apiKey = (process.env.GOOGLE_API_KEY || '').trim();

const body = `/*
 * Generado en el despliegue por tools/write-config.js. No editar a mano:
 * los valores salen de las variables GOOGLE_CLIENT_ID y GOOGLE_API_KEY.
 */
window.SVGSHARE_CONFIG = {
  googleClientId: ${JSON.stringify(clientId)},
  googleApiKey: ${JSON.stringify(apiKey)}
};
`;

fs.writeFileSync(target, body, 'utf8');

/* ------------------------------------------------------- lo que queda activo */

const notes = [];
notes.push(`Guardar en Drive (creador): ${clientId ? 'activado' : 'desactivado'}`);
notes.push(`Leer de Drive (visor): ${apiKey ? 'activado' : 'desactivado'}`);

// Media configuración es peor que ninguna: el creador ofrecería enlaces cortos
// que este mismo sitio no sabe abrir.
const halfConfigured = Boolean(clientId) !== Boolean(apiKey);
if (halfConfigured) {
  notes.push(clientId
    ? '**Aviso**: hay client id pero no API key. El creador podría guardar en Drive, ' +
      'pero el visor no sabría leer esos enlaces. El carril se queda oculto hasta que ' +
      'exista GOOGLE_API_KEY.'
    : '**Aviso**: hay API key pero no client id. El visor podría abrir enlaces de Drive ' +
      'creados en otro sitio, pero aquí no se puede guardar nada.');
}

for (const note of notes) console.log(note.replace(/\*\*/g, ''));

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    ['### Credenciales de Google', '', ...notes.map((n) => `- ${n}`), ''].join('\n')
  );
}
