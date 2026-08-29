/*
 * El nombre del archivo viaja en `n=`. Llega desde la URL, así que es tan poco
 * fiable como el payload y se limpia antes de usarse.
 */
const { test, expect } = require('@playwright/test');
const { PLAIN, upload, linkOf } = require('./helpers');

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const PAYLOAD = 'b=' + b64url(PLAIN);

test('el nombre del archivo viaja en el enlace', async ({ page }) => {
  await page.goto('/');
  await upload(page, 'logo.svg', PLAIN);
  expect(await linkOf(page)).toContain('&n=logo.svg');
});

test('el nombre da título a la pestaña del visor', async ({ page }) => {
  await page.goto(`/#${PAYLOAD}&n=logo.svg`);
  await expect(page).toHaveTitle('SVGshare - logo.svg');
});

test('sin nombre el visor usa un título genérico', async ({ page }) => {
  await page.goto(`/#${PAYLOAD}`);
  await expect(page).toHaveTitle('SVGshare - SVG compartido');
});

test('los acentos y espacios sobreviven al viaje', async ({ page }) => {
  await page.goto(`/#${PAYLOAD}&n=${encodeURIComponent('mi diseño ñandú.svg')}`);
  await expect(page).toHaveTitle('SVGshare - mi diseño ñandú.svg');
});

test('el nombre se reduce a un único segmento de ruta', async ({ page }) => {
  await page.goto(`/#${PAYLOAD}&n=${encodeURIComponent('../../etc/passwd.svg')}`);
  await expect(page).toHaveTitle('SVGshare - passwd.svg');
});

test('las barras invertidas también se recortan', async ({ page }) => {
  await page.goto(`/#${PAYLOAD}&n=${encodeURIComponent('C:\\Windows\\system32\\logo.svg')}`);
  await expect(page).toHaveTitle('SVGshare - logo.svg');
});

test('los caracteres de control se eliminan del nombre', async ({ page }) => {
  await page.goto(`/#${PAYLOAD}&n=${encodeURIComponent('lo\u0000go\u001f.svg')}`);
  await expect(page).toHaveTitle('SVGshare - logo.svg');
});

test('un nombre desmedido se recorta a 80 caracteres', async ({ page }) => {
  const largo = 'a'.repeat(500) + '.svg';
  await page.goto(`/#${PAYLOAD}&n=${encodeURIComponent(largo)}`);
  const title = await page.title();
  expect(title).toBe('SVGshare - ' + 'a'.repeat(80));
});

test('un `n=` mal codificado no rompe el visor', async ({ page }) => {
  await page.goto(`/#${PAYLOAD}&n=%E0%A4%A`);
  await expect(page).toHaveTitle('SVGshare - SVG compartido');
  await expect(page.locator('#stageImg')).toBeVisible();
});

test('el nombre no llega al marcado como HTML', async ({ page }) => {
  await page.goto(`/#${PAYLOAD}&n=${encodeURIComponent('<img src=x onerror=alert(1)>.svg')}`);
  await expect(page.locator('#stageImg')).toBeVisible();
  expect(await page.locator('#stage img').count()).toBe(1);
});

test('la descarga usa el nombre original', async ({ page }) => {
  await page.goto(`/#${PAYLOAD}&n=${encodeURIComponent('mi logo.svg')}`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btnDownload').click()
  ]);
  expect(download.suggestedFilename()).toBe('mi logo.svg');
});

test('sin nombre la descarga cae en svgshare.svg', async ({ page }) => {
  await page.goto(`/#${PAYLOAD}`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btnDownload').click()
  ]);
  expect(download.suggestedFilename()).toBe('svgshare.svg');
});

test('a un nombre sin extensión se le añade .svg al descargar', async ({ page }) => {
  await page.goto(`/#${PAYLOAD}&n=logo`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btnDownload').click()
  ]);
  expect(download.suggestedFilename()).toBe('logo.svg');
});

test('lo descargado es el SVG saneado', async ({ page }) => {
  const nasty = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
    '<script>window.__pwned = 1;<\/script><rect width="10" height="10"/></svg>';
  await page.goto(`/#b=${b64url(nasty)}&n=logo.svg`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#btnDownload').click()
  ]);
  const fs = require('node:fs');
  const path = await download.path();
  expect(fs.readFileSync(path, 'utf8')).not.toContain('script');
});
