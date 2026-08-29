/*
 * El visor: reconstruir la imagen desde el enlace, y fallar con sentido cuando
 * el enlace no da para más.
 */
const { test, expect } = require('@playwright/test');
const zlib = require('node:zlib');
const { PLAIN, upload, linkOf, openLink } = require('./helpers');

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('un enlace recién creado se abre y pinta la imagen', async ({ page }) => {
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  const link = await linkOf(page);

  await openLink(page, link);
  await expect(page.locator('#viewer')).toBeVisible();
  await expect(page.locator('#creator')).toBeHidden();
  await expect(page.locator('#stageError')).toBeHidden();

  const src = await page.locator('#stageImg').getAttribute('src');
  expect(src).toMatch(/^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(src.split(',')[1], 'base64').toString('utf8');
  expect(svg).toContain('<rect');
  expect(svg).toContain('#6d4aff');
});

test('la imagen se pinta como <img data:>, nunca en línea', async ({ page }) => {
  const payload = 'b=' + base64url(Buffer.from(PLAIN, 'utf8'));
  await page.goto(`/#${payload}`);
  await expect(page.locator('#stageImg')).toHaveAttribute('src', /^data:/);
  // Nada del SVG compartido acaba dentro del DOM de la página.
  expect(await page.locator('#stage svg').count()).toBe(0);
});

test('un enlace sin comprimir (b=) también se abre', async ({ page }) => {
  await page.goto('/#b=' + base64url(Buffer.from(PLAIN, 'utf8')));
  await expect(page.locator('#stageImg')).toBeVisible();
  await expect(page.locator('#stageError')).toBeHidden();
});

test('un enlace comprimido (z=) se descomprime', async ({ page }) => {
  await page.goto('/#z=' + base64url(zlib.deflateRawSync(Buffer.from(PLAIN, 'utf8'))));
  await expect(page.locator('#stageImg')).toBeVisible();
  await expect(page.locator('#stageError')).toBeHidden();
});

test('sin DecompressionStream entra el decodificador DEFLATE en JS', async ({ page }) => {
  await page.addInitScript(() => { delete window.DecompressionStream; });
  await page.goto('/#z=' + base64url(zlib.deflateRawSync(Buffer.from(PLAIN, 'utf8'))));

  await expect(page.locator('#stageError')).toBeHidden();
  const src = await page.locator('#stageImg').getAttribute('src');
  expect(Buffer.from(src.split(',')[1], 'base64').toString('utf8')).toContain('#6d4aff');
});

test('sin ninguna vía de descompresión el visor lo dice', async ({ page }) => {
  await page.addInitScript(() => {
    delete window.DecompressionStream;
    // inflate.js se carga después: el setter se traga la asignación.
    Object.defineProperty(window, 'inflateRaw', { get: () => undefined, set: () => {} });
  });
  await page.goto('/#z=' + base64url(zlib.deflateRawSync(Buffer.from(PLAIN, 'utf8'))));
  await expect(page.locator('#stageError')).toContainText('no puede descomprimir');
});

test('el visor abre el código fuente de la imagen', async ({ page }) => {
  await page.goto('/#b=' + base64url(Buffer.from(PLAIN, 'utf8')));
  await page.locator('#btnSource').click();
  await expect(page.locator('#sourceDialog')).toBeVisible();
  await expect(page.locator('#sourceCode')).toContainText('<rect');
});

test('el selector de fondo cambia el lienzo', async ({ page }) => {
  await page.goto('/#b=' + base64url(Buffer.from(PLAIN, 'utf8')));
  const stage = page.locator('#stage');
  await expect(stage).toHaveAttribute('data-bg', 'checker');

  await page.locator('.bg-switch [data-bg="dark"]').click();
  await expect(stage).toHaveAttribute('data-bg', 'dark');
  await page.locator('.bg-switch [data-bg="light"]').click();
  await expect(stage).toHaveAttribute('data-bg', 'light');
});

test('un payload dañado deja un mensaje, no una página en blanco', async ({ page }) => {
  await page.goto('/#z=' + base64url(Buffer.from('esto no es deflate', 'utf8')));
  await expect(page.locator('#stageError')).toBeVisible();
  await expect(page.locator('#stageError')).toContainText('dañado');
});

test('un payload con caracteres fuera de base64url se rechaza', async ({ page }) => {
  await page.goto('/#b=***');
  await expect(page.locator('#stageError')).toContainText('dañado o incompleto');
});

test('cuando falla, el visor esconde el fondo y desactiva las acciones', async ({ page }) => {
  await page.goto('/#b=***');
  await expect(page.locator('.bg-switch')).toBeHidden();
  await expect(page.locator('#btnDownload')).toBeDisabled();
  await expect(page.locator('#btnSource')).toBeDisabled();
  expect(await page.locator('#stage').getAttribute('data-bg')).toBeNull();
});

test('un payload que decodifica pero no es SVG se rechaza', async ({ page }) => {
  await page.goto('/#b=' + base64url(Buffer.from('<html><body>hola</body></html>', 'utf8')));
  await expect(page.locator('#stageError')).toContainText('no es un SVG válido');
});

test('el saneado se aplica también al abrir el enlace', async ({ page }) => {
  const nasty = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
    '<script>window.__pwned = 1;<\/script><rect width="10" height="10"/></svg>';
  await page.goto('/#b=' + base64url(Buffer.from(nasty, 'utf8')));
  await expect(page.locator('#stageImg')).toBeVisible();

  const src = await page.locator('#stageImg').getAttribute('src');
  expect(Buffer.from(src.split(',')[1], 'base64').toString('utf8')).not.toContain('script');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});
