/*
 * El creador: cargar, sanear, optimizar y construir el enlace.
 */
const { test, expect } = require('@playwright/test');
const { PLAIN, HOSTILE, CRUFTY, heavySvg, upload, paste, linkOf, openLink } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('la portada arranca en el creador, no en el visor', async ({ page }) => {
  await expect(page.locator('#creator')).toBeVisible();
  await expect(page.locator('#viewer')).toBeHidden();
  await expect(page.locator('#dropCard')).toBeVisible();
  await expect(page.locator('#result')).toBeHidden();
});

test('un SVG cargado produce un enlace con el payload en el fragmento', async ({ page }) => {
  await upload(page, 'cuadrado.svg', PLAIN);

  const link = await linkOf(page);
  expect(link).toMatch(/#(z|b)=[A-Za-z0-9\-_]+&n=cuadrado\.svg$/);
  expect(new URL(link).search).toBe('');           // nada viaja en la query string
  await expect(page.locator('#fileName')).toHaveText('cuadrado.svg');
  await expect(page.locator('#previewImg')).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/);
});

test('el fragmento se comprime cuando comprimir ayuda', async ({ page }) => {
  await upload(page, 'pesado.svg', heavySvg(300));
  expect(await linkOf(page)).toContain('#z=');
});

test('dimensiones y peso se muestran junto al nombre', async ({ page }) => {
  await upload(page, 'cuadrado.svg', PLAIN);
  await expect(page.locator('#stats')).toHaveText(/48 × 24 · \d+ B/);
});

test('las dimensiones salen del viewBox si no hay width/height', async ({ page }) => {
  await paste(page, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60"/></svg>');
  await expect(page.locator('#stats')).toHaveText(/120 × 60/);
});

test('pegar marcado SVG entra por el mismo camino', async ({ page }) => {
  await paste(page, PLAIN);
  await expect(page.locator('#fileName')).toHaveText('pegado.svg');
  expect(await linkOf(page)).toContain('&n=pegado.svg');
});

test('el saneador quita scripts, handlers y referencias externas', async ({ page }) => {
  await paste(page, HOSTILE);

  const url = await linkOf(page);
  await openLink(page, url);
  const source = await page.evaluate(async () => {
    document.getElementById('btnSource').click();
    return document.getElementById('sourceCode').textContent;
  });

  expect(source).not.toContain('<script');
  expect(source).not.toContain('foreignObject');
  expect(source).not.toContain('onload');
  expect(source).not.toContain('example.com');
  expect(source).not.toContain('javascript:');
  // Lo legítimo sobrevive: referencias internas y data:image.
  expect(source).toContain('href="#ok"');
  expect(source).toContain('data:image/png;base64');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('optimizar quita comentarios, metadata y namespaces de editor', async ({ page }) => {
  await paste(page, CRUFTY);
  const short = await linkOf(page);

  await page.locator('#optMinify').uncheck();
  await page.waitForFunction((prev) => document.getElementById('link').value !== prev, short);
  const long = await linkOf(page);

  expect(short.length).toBeLessThan(long.length);

  await openLink(page, short);
  const source = await page.evaluate(() => {
    document.getElementById('btnSource').click();
    return document.getElementById('sourceCode').textContent;
  });
  expect(source).not.toContain('<!--');
  expect(source).not.toContain('metadata');
  expect(source).not.toContain('inkscape');
  expect(source).not.toContain('sodipodi');
  expect(source).toContain('<circle');
});

test('el medidor clasifica la longitud del enlace en tres niveles', async ({ page }) => {
  await upload(page, 'pequeno.svg', PLAIN);
  await expect(page.locator('#meterLabel')).toHaveClass(/is-ok/);
  await expect(page.locator('#meterLabel')).toContainText('en cualquier sitio');

  await paste(page, heavySvg(1400));
  await expect(page.locator('#meterLabel')).toHaveClass(/is-(warn|bad)/);
});

test('el contador de caracteres coincide con el enlace', async ({ page }) => {
  await upload(page, 'cuadrado.svg', PLAIN);
  const link = await linkOf(page);
  const label = await page.locator('#meterLabel b').textContent();
  expect(label).toBe(`${link.length.toLocaleString('es-ES')} caracteres`);
});

test('un archivo que no es SVG se rechaza con aviso', async ({ page }) => {
  await page.setInputFiles('#file', {
    name: 'foto.png',
    mimeType: 'image/png',
    buffer: Buffer.from('no soy un svg')
  });
  await expect(page.locator('#toast')).toHaveText('Elige un archivo .svg');
  await expect(page.locator('#result')).toBeHidden();
});

test('un .svg con contenido inválido avisa y no genera enlace', async ({ page }) => {
  await page.setInputFiles('#file', {
    name: 'roto.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg><rect></svg>')
  });
  await expect(page.locator('#toast')).toHaveText(/no es un SVG válido/);
  await expect(page.locator('#result')).toBeHidden();
});

test('«elegir otro archivo» devuelve el creador a su estado inicial', async ({ page }) => {
  await upload(page, 'cuadrado.svg', PLAIN);
  await page.locator('#btnReset').click();
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#dropCard')).toBeVisible();
});

test('el botón «Abrir» apunta al mismo enlace del cuadro de texto', async ({ page }) => {
  await upload(page, 'cuadrado.svg', PLAIN);
  expect(await page.locator('#btnOpen').getAttribute('href')).toBe(await linkOf(page));
});

test('sin credenciales de Google el carril de Drive no aparece', async ({ page }) => {
  await upload(page, 'cuadrado.svg', PLAIN);
  await expect(page.locator('#driveBox')).toBeHidden();
});
