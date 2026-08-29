# SVGshare

Web mobile-first para compartir imágenes SVG **dentro de la propia URL**: subes un
archivo y obtienes un enlace autocontenido. No hay servidor, ni base de datos, ni
almacenamiento: la imagen viaja codificada en el fragmento (`#`) del enlace, que el
navegador nunca envía al servidor.

👉 https://jgermade.github.io/svgshare/

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
.github/workflows/deploy.yml
```

## Desarrollo

No hay build ni dependencias; es HTML, CSS y JS estáticos:

```bash
python3 -m http.server 8080
# http://localhost:8080
```

## Despliegue

GitHub Actions publica la web en GitHub Pages con cada push a `main`
(`.github/workflows/deploy.yml`). Requiere activar **Settings → Pages → Build and
deployment → Source: GitHub Actions** una sola vez en el repositorio.
