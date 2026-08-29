/*
 * Credenciales del carril de Google Drive. Ambas son públicas por diseño
 * (viajan en el navegador); su seguridad viene de restringirlas por origen:
 *
 *   googleClientId — Cloud console › Clients › OAuth 2.0, tipo "Web application".
 *                    Añade el origen autorizado de JavaScript, p. ej.
 *                    https://svgshare.github.io y http://localhost:8080 para
 *                    desarrollo. No hace falta redirect URI: el token client de
 *                    Google Identity Services usa una ventana emergente.
 *
 *   googleApiKey   — Cloud console › Credentials › API key, restringida por
 *                    referrer HTTP al mismo origen y limitada a la Drive API.
 *                    La usa el visor para leer ficheros ya públicos sin sesión.
 *
 * Con estos campos vacíos la app funciona igual: el carril de Drive
 * simplemente no aparece.
 */
window.SVGSHARE_CONFIG = {
  googleClientId: '',
  googleApiKey: ''
};
