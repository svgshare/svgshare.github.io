/*
 * Utilidades compartidas por las suites: SVGs de muestra y las dos maneras de
 * meter un archivo en el creador (selector de archivos y pegado).
 */

const PLAIN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24" viewBox="0 0 48 24">' +
  '<rect width="48" height="24" fill="#6d4aff"/></svg>';

// Todo lo que el saneador tiene que quitar, junto.
const HOSTILE =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'width="10" height="10" onload="window.__pwned = 1">' +
  '<script>window.__pwned = 1;<\/script>' +
  '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hola</div></foreignObject>' +
  '<image href="https://example.com/tracker.png" width="4" height="4"/>' +
  '<image xlink:href="https://example.com/otro.png" width="4" height="4"/>' +
  '<a href="javascript:alert(1)"><rect width="10" height="10"/></a>' +
  '<use href="#ok"/>' +
  '<image href="data:image/png;base64,iVBORw0KGgo=" width="2" height="2"/>' +
  '<rect id="ok" width="10" height="10" fill="#000"/></svg>';

// Ruido típico de editor: comentarios, metadata, namespaces e indentación.
const CRUFTY = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!-- Creado con un editor muy verboso -->',
  '<svg xmlns="http://www.w3.org/2000/svg"',
  '     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"',
  '     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd"',
  '     width="32" height="32" viewBox="0 0 32 32"',
  '     inkscape:version="1.1" sodipodi:docname="dibujo.svg">',
  '  <metadata id="meta7">basura</metadata>',
  '  <sodipodi:namedview id="vista" inkscape:zoom="4"/>',
  '  <g inkscape:label="Capa 1" inkscape:groupmode="layer">',
  '    <circle cx="16" cy="16" r="12" fill="#0a0"/>',
  '  </g>',
  '</svg>'
].join('\n');

// Un SVG grande de verdad: sirve para empujar el medidor a ámbar o rojo.
function heavySvg(paths) {
  let out = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">';
  for (let i = 0; i < paths; i++) {
    const x = (i * 7.31) % 600;
    const y = (i * 11.79) % 600;
    out += `<path d="M${x.toFixed(2)} ${y.toFixed(2)}l${(i % 37) + 3}.41 ${(i % 23) + 2}.77` +
      `q${(i % 13) + 1}.5 ${(i % 17) + 4}.25 ${(i % 29) + 6}.13 ${(i % 11) + 8}.9z" ` +
      `fill="#${(i % 16).toString(16)}${(i % 9)}${(i % 7)}a4f" opacity="0.${(i % 89) + 10}"/>`;
  }
  return out + '</svg>';
}

// El creador solo lee archivos, así que se le entrega uno de verdad.
async function upload(page, name, text) {
  await page.setInputFiles('#file', {
    name,
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(text, 'utf8')
  });
  await page.locator('#result').waitFor({ state: 'visible' });
  await expectSettled(page);
}

// El otro camino de entrada: pegar el marcado.
async function paste(page, text) {
  await page.evaluate((svg) => {
    const data = new DataTransfer();
    data.setData('text/plain', svg);
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }));
  }, text);
  await page.locator('#result').waitFor({ state: 'visible' });
  await expectSettled(page);
}

// render() es asíncrono (comprime); el enlace es lo último que escribe.
async function expectSettled(page) {
  await page.waitForFunction(() => document.getElementById('link').value.length > 0);
}

function linkOf(page) {
  return page.locator('#link').inputValue();
}

// Ir de la página al enlace que ella misma acaba de generar solo cambia el
// fragmento, y eso no recarga nada: hay que salir del documento primero.
async function openLink(page, url) {
  await page.goto('about:blank');
  await page.goto(url);
}

module.exports = { PLAIN, HOSTILE, CRUFTY, heavySvg, upload, paste, expectSettled, linkOf, openLink };
