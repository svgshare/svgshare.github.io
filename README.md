# SVGshare

Web mobile-first para compartir imágenes SVG **dentro de la propia URL**: subes un
archivo y obtienes un enlace autocontenido. No hay servidor, ni base de datos, ni
almacenamiento: la imagen viaja codificada en el fragmento (`#`) del enlace, que el
navegador nunca envía al servidor.

👉 https://svgshare.github.io/

## Cómo funciona

1. **Saneado** — se eliminan `<script>`, `<foreignObject>`, atributos `on*` y cualquier
   referencia externa (`href`/`src` que no sea `#id` o `data:image/`).
2. **Optimizado** (opcional, activado por defecto) — fuera comentarios, `<metadata>`,
   espacios de nombres de editores (Inkscape, Sodipodi, Illustrator) y el espaciado
   de indentación.
3. **Comprimido** con `CompressionStream('deflate-raw')` y codificado en **base64url**.
4. El resultado se guarda en el hash: `…/#z=<datos>` (comprimido) o `…/#b=<datos>`
   (sin comprimir, si el navegador no ofrece compresión o no ayuda), seguido del
   nombre del archivo: `…&n=mi%20logo.svg`.

El nombre se usa para el título de la pestaña del visor (`SVGshare - mi logo.svg`) y
como nombre al descargar. Llega desde la URL, así que se reduce a un único segmento de
ruta y se recorta a 80 caracteres antes de usarlo. Los enlaces sin `n=` siguen
funcionando.

Al abrir el enlace el proceso se invierte, y la imagen se pinta mediante un
`<img src="data:image/svg+xml;base64,…">`, contexto en el que el navegador no ejecuta
scripts ni permite peticiones de red desde el SVG.

Para navegadores sin `DecompressionStream` se incluye un decodificador DEFLATE en JS
(`assets/inflate.js`), así que los enlaces comprimidos siguen abriéndose.

## Carril de Google Drive (opcional)

Además del enlace autocontenido, la app puede guardar el SVG en el **Drive de quien
sube la imagen** y compartir un enlace corto. La cuota es del usuario; SVGshare no
almacena nada.

```
autocontenido   …/#z=<datos>&n=<nombre>      largo, eterno, sin cuentas
Drive           …/?d=<fileId>&n=<nombre>     ~70 caracteres, constante
```

El enlace de Drive mide lo mismo pese lo que pese el SVG, lo que además lo hace
apto para códigos QR. A cambio, el enlace es mortal: muere si el usuario borra el
fichero o le retira el permiso público.

El id va en la **query string** a propósito. Ya es la credencial —quien tiene el
enlace puede leer el fichero—, así que no gana nada escondiéndose en el fragmento,
y al ser visible para el servidor deja la puerta abierta a que en el futuro una
función edge genere tarjetas de previsualización por fichero. El carril
autocontenido, en cambio, *debe* seguir en el fragmento: ahí está su razón de ser.

### Configuración

Rellena `assets/config.js`; con los campos vacíos el carril no aparece y la app
funciona como siempre.

1. **Client ID** — Cloud console › Clients › OAuth 2.0, tipo *Web application*.
   Añade el origen autorizado de JavaScript (`https://<tu-dominio>` y
   `http://localhost:8080` para desarrollo). No hace falta redirect URI: Google
   Identity Services usa una ventana emergente.
2. **API key** — Credentials › API key, restringida por referrer HTTP al mismo
   origen y limitada a la Drive API. La usa el visor para leer ficheros ya
   públicos sin sesión.
3. Habilita la **Google Drive API** en el proyecto.

El único scope es `drive.file`, que da acceso solo a los ficheros que la propia app
crea. Es un scope **no sensible**: no requiere verificación de Google, no muestra el
aviso de «app no verificada» y no tiene tope de 100 usuarios. Publica la pantalla de
consentimiento en *In production* y listo. No se piden `email` ni `profile`
precisamente para no salir de esa categoría.

### Seguridad

- El token de acceso vive **solo en memoria**: nunca en `localStorage`, `sessionStorage`
  ni cookies. Recargar la pestaña vuelve a pedirlo a Google, en silencio si ya hay
  consentimiento.
- El SVG que llega de Drive es tan poco fiable como el que llega de la URL, y pasa
  por el mismo saneador antes de pintarse.
- El id de fichero de la URL se valida contra `/^[A-Za-z0-9_-]{10,200}$/` antes de
  construir ninguna petición.

### Pendiente de verificar

La lectura anónima —`files.get?alt=media` con API key sobre un fichero público,
desde otro origen— está implementada y probada contra endpoints simulados, pero
**no contra Google**. Es la primera pieza que hay que confirmar con credenciales
reales; si Google no responde con cabeceras CORS ahí, el visor necesitaría otra vía.

## Previsualización al compartir

Las tarjetas de Telegram, WhatsApp o Slack son **fijas** y no pueden mostrar el nombre
del archivo compartido. El motivo es el mismo que hace que la app no necesite servidor:
el fragmento `#` no se envía en la petición HTTP, así que el rastreador solo recibe
`https://svgshare.github.io/` — sin imagen y sin `n=` —, y tampoco ejecuta el
JavaScript que pone el título en el visor.

Por eso hay etiquetas Open Graph estáticas y una imagen de tarjeta (`og.jpg`, 1200×630):
al menos la previsualización es deliberada en vez de accidental. Un título por archivo
exigiría mover los datos a la query string y servirlos desde un host dinámico (una
función edge en Cloudflare, Netlify o Vercel), lo que enviaría cada imagen al servidor y
recortaría bastante la longitud útil del enlace.

Se omite `og:url` a propósito: algunos clientes lo usan como destino de la tarjeta, y eso
abriría la portada en lugar del enlace compartido.

## Longitud del enlace

La app muestra en todo momento cuántos caracteres ocupa el enlace:

| Longitud | Qué esperar |
| --- | --- |
| ≤ 8.000 | Se comparte bien en cualquier sitio |
| ≤ 32.000 | Funciona en navegadores modernos; algunas apps de chat pueden cortarlo |
| > 32.000 | Demasiado largo para muchos destinos: conviene simplificar el SVG |

## Estructura

```
index.html          # creador + visor (una sola página)
assets/style.css    # estilos, mobile-first, con modo oscuro
assets/app.js       # saneado, optimización, codificación y UI
assets/inflate.js   # DEFLATE en JS como respaldo de DecompressionStream
assets/drive.js     # carril de Google Drive (OAuth, subida, lectura pública)
assets/config.js    # credenciales de Google; vacío = carril desactivado
og.jpg              # imagen de la tarjeta de previsualización
test/               # suites de Playwright
.github/workflows/  # deploy a Pages y ejecución de los tests
```

## Desarrollo

La web no tiene build ni dependencias; es HTML, CSS y JS estáticos:

```bash
python3 -m http.server 8080
# http://localhost:8080
```

## Tests

77 comprobaciones con Playwright sobre Chromium a 390 px. `package.json` existe
solo para esto: la web sigue sirviéndose tal cual.

```bash
npm install
npx playwright install chromium
npm test
```

| Suite | Qué cubre |
| --- | --- |
| `test/creator.spec.js` | carga, saneado, optimización, medidor de longitud |
| `test/viewer.spec.js` | decodificación `z=`/`b=`, respaldo DEFLATE en JS, errores |
| `test/name.spec.js` | `n=` en el enlace, título, descarga, nombres hostiles |
| `test/drive.spec.js` | el carril de Drive completo, contra endpoints simulados |
| `test/inflate.spec.js` | `assets/inflate.js` contra `zlib.deflateRawSync`, con fuzzing |

El servidor estático lo levanta la propia configuración de Playwright. Las
pruebas de Drive simulan Google entero —incluido `assets/config.js`—, así que no
hacen falta credenciales; a cambio, no demuestran que Google responda como se
supone. Eso sigue pendiente de comprobar contra el servicio real.

## Despliegue

GitHub Actions publica la web en GitHub Pages con cada push a `main`
(`.github/workflows/deploy.yml`). Requiere activar **Settings → Pages → Build and
deployment → Source: GitHub Actions** una sola vez en el repositorio.
