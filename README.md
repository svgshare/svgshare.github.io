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

## Mi carpeta (`/account/`, opcional)

Además del enlace autocontenido, SVGshare ofrece una **vista de carpeta** contra
el Drive de quien la usa: una carpeta `SVGshare` en su cuenta, con los SVG que
guarde ahí. La cuota es suya; SVGshare no almacena nada.

Desde esa vista se puede subir SVG, previsualizarlos, **crear subcarpetas** y
navegar por ellas, **compartir una imagen o una carpeta entera** con un enlace,
dejar de compartirlos, borrarlos, y ver cuánto espacio ocupan en la cuenta.

Las carpetas se listan arriba en filas con icono —no hay nada que previsualizar
en una carpeta— y las imágenes debajo, en una rejilla de miniaturas. Toda esa
zona acepta que le suelten archivos, y el hueco de «añadir» ocupa el ancho
mientras no haya imágenes y el sitio de una más cuando ya las hay.

Borrar la carpeta en la que estás vive en una **zona de riesgo plegada** al pie,
porque no se puede deshacer.

La navegación va en la URL (`/account/?id=<folderId>`), así que recargar y el
botón «atrás» del navegador funcionan como se espera. Compartir estando dentro de
una subcarpeta comparte **esa**, no la raíz.

```
autocontenido   …/#z=<datos>&n=<nombre>      largo, eterno, sin cuentas
imagen          …/?d=<fileId>&n=<nombre>     ~70 caracteres, constante
carpeta         …/account/?f=<folderId>      la carpeta, en solo lectura
```

El enlace de Drive mide lo mismo pese lo que pese el SVG, lo que además lo hace
apto para códigos QR. A cambio, el enlace es mortal: muere si el usuario borra el
fichero o le retira el permiso público.

La portada no guarda nada en Drive: solo enlaza a `/account/`, con un enlace en
la cabecera que está siempre —no hace falta haber cargado un SVG— y una tarjeta
en el resultado que además avisa cuando el enlace autocontenido se pone largo. Ahí, sin sesión, lo
primero es un botón de **entrar con Google**. El token se queda en la pestaña
(`sessionStorage`), así que recargar no obliga a pulsar el botón otra vez;
cerrarla lo tira, y una pestaña nueva vuelve a empezar por el botón.

Pedírselo a Google «en silencio» al cargar (`prompt: 'none'`) **no** es una
alternativa: el token client de Google Identity Services solo hace el refresco
silencioso por iframe si se le pasa `enable_token_refresh` y su experimento
está activo; en cualquier otro caso abre una ventana emergente, y sin un clic
detrás el navegador la bloquea y saca su aviso.

Compartir la carpeta la hace pública y da un enlace a `/account/?f=…`, que
cualquiera puede abrir sin cuenta: se ven las miniaturas y se puede entrar en cada
imagen, pero no añadir ni borrar nada.

El id va en la **query string** a propósito. Ya es la credencial —quien tiene el
enlace puede leer el fichero—, así que no gana nada escondiéndose en el fragmento,
y al ser visible para el servidor deja la puerta abierta a que en el futuro una
función edge genere tarjetas de previsualización por fichero. El carril
autocontenido, en cambio, *debe* seguir en el fragmento: ahí está su razón de ser.

### Configuración

Hacen falta **las dos** credenciales:

1. **Client ID** — Cloud console › Clients › OAuth 2.0, tipo *Web application*.
   Añade el origen autorizado de JavaScript (`https://svgshare.github.io` y
   `http://localhost:8080` para desarrollo). No hace falta redirect URI: Google
   Identity Services usa una ventana emergente. Habilita **guardar**.
2. **API key** — Credentials › API key, restringida por referrer HTTP al mismo
   origen y limitada a la Drive API. Habilita **leer**: es la que usa el visor
   para abrir ficheros ya públicos sin sesión.
3. Habilita la **Google Drive API** en el proyecto.

Con solo una de las dos el carril **no aparece**, a propósito: un enlace corto
que este mismo sitio no sabe abrir es peor que no ofrecerlo.

En el despliegue los valores salen de las variables `GOOGLE_CLIENT_ID` y
`GOOGLE_API_KEY` del repositorio (valen tanto variables como secretos), y
`tools/write-config.js` escribe `assets/config.js` antes de publicar. Ambas son
públicas por diseño —viajan en el navegador—, así que no son secretos que
proteger: su seguridad viene de estar restringidas por origen. Están fuera del
repositorio para que cada despliegue o fork use las suyas.

Para desarrollo local, rellena `assets/config.js` a mano o genera el fichero:

```bash
GOOGLE_CLIENT_ID=… GOOGLE_API_KEY=… node tools/write-config.js
```

El único scope es `drive.file`, que da acceso solo a los ficheros que la propia app
crea. Es un scope **no sensible**: no requiere verificación de Google, no muestra el
aviso de «app no verificada» y no tiene tope de 100 usuarios. Publica la pantalla de
consentimiento en *In production* y listo. No se piden `email` ni `profile`
precisamente para no salir de esa categoría.

### Seguridad

- El token de acceso vive en memoria y en el `sessionStorage` de la pestaña, nunca
  en `localStorage` ni en cookies: no sobrevive al cierre de la pestaña, no se
  comparte con otras y no viaja en ninguna petición que no sea a Google. Se tira en
  cuanto caduca, o en cuanto Drive contesta 401. Sin `sessionStorage` disponible
  todo funciona igual, solo que recargar vuelve a pedir el botón.
- El SVG que llega de Drive es tan poco fiable como el que llega de la URL, y pasa
  por el mismo saneador antes de pintarse.
- El id de fichero de la URL se valida contra `/^[A-Za-z0-9_-]{10,200}$/` antes de
  construir ninguna petición.

### Acceso anónimo

El visor lee el fichero sin sesión, solo con la API key. Eso depende de que la
Drive API responda con cabeceras CORS desde otro origen, y **está confirmado
contra Google**:

```
GET /drive/v3/files/<id>?alt=media&key=<API key>
    Origin: https://svgshare.github.io
→ 200 · access-control-allow-origin: https://svgshare.github.io
```

Queda sin probar la pieza equivalente para carpetas: `files.list` sobre una
carpeta pública y sin sesión, que es lo que sostiene `/account/?f=`. Es un
endpoint distinto y no se ha ejecutado todavía contra Google.

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

## Tema

Claro y oscuro, con un selector en el pie de todas las vistas: **automático**
(sigue al sistema), claro u oscuro. La elección se guarda por navegador y se
aplica antes del primer pintado, así que una recarga en oscuro no da un destello
blanco. Sin `localStorage` disponible —ventana privada, almacenamiento
bloqueado— se cae en automático sin romper nada.

El área de la imagen es aparte: siempre clara, para que un SVG de tinta oscura se
vea igual en los dos temas. En el visor hay un selector de fondo propio para
cuando la imagen es de tinta clara.

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
account/index.html  # vista de carpeta contra Google Drive
assets/style.css    # estilos, mobile-first, con modo claro y oscuro
assets/theme.js     # selector de tema (auto/claro/oscuro), sin destello
assets/svg.js       # saneado, optimización y codificación; compartido
assets/app.js       # creador y visor
assets/account.js   # vista de carpeta
assets/inflate.js   # DEFLATE en JS como respaldo de DecompressionStream
assets/drive.js     # Google Drive (OAuth, carpeta, subida, permisos, cuota)
assets/config.js    # credenciales de Google; vacío = Drive desactivado
og.jpg              # imagen de la tarjeta de previsualización
test/               # suites de Playwright
tools/write-config.js  # genera config.js en el despliegue
.github/workflows/  # deploy a Pages y ejecución de los tests
```

## Desarrollo

La web no tiene build ni dependencias; es HTML, CSS y JS estáticos:

```bash
python3 -m http.server 8080
# http://localhost:8080
```

## Tests

148 comprobaciones con Playwright sobre Chromium a 390 px. `package.json` existe
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
| `test/drive.spec.js` | el atajo de la portada y el visor de enlaces de Drive |
| `test/account.spec.js` | la vista de carpeta entera, contra un Drive simulado con estado |
| `test/theme.spec.js` | el selector de tema y el `<img>` sin `src` |
| `test/inflate.spec.js` | `assets/inflate.js` contra `zlib.deflateRawSync`, con fuzzing |
| `test/config.spec.js` | `tools/write-config.js`: escapado, avisos, recorte |

El servidor estático lo levanta la propia configuración de Playwright. Las
pruebas de Drive simulan Google entero —incluido `assets/config.js`— con un Drive
de mentira con estado (`test/google-mock.js`), así que no hacen falta
credenciales; a cambio, no demuestran que Google responda como se supone. Eso
sigue pendiente de comprobar contra el servicio real.

## Despliegue

GitHub Actions publica la web en GitHub Pages con cada push a `main`
(`.github/workflows/deploy.yml`). Requiere activar **Settings → Pages → Build and
deployment → Source: GitHub Actions** una sola vez en el repositorio.
