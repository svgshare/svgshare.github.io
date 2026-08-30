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
  // El visor rellena el código cuando termina de decodificar el enlace.
  await expect(page.locator('#stageImg')).toHaveAttribute('src', /^data:/);
  const source = await page.evaluate(() => {
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
  await expect(page.locator('#stageImg')).toHaveAttribute('src', /^data:/);
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

/* --------------------------------------------------- proporción de la caja */

// Antes la caja tenía alto fijo y `overflow: hidden`: un SVG alto se renderizaba
// a su tamaño natural y se veía recortado.
const RATIOS = {
  'alto (100×1000)': ['<svg xmlns="http://www.w3.org/2000/svg" width="100" height="1000" viewBox="0 0 100 1000"><rect width="100" height="1000" fill="#6d4aff"/></svg>', 0.1],
  'apaisado (1000×100)': ['<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="100" viewBox="0 0 1000 100"><rect width="1000" height="100" fill="#0a0"/></svg>', 10],
  'solo viewBox': ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 1000"><rect width="100" height="1000" fill="#f60"/></svg>', 0.1],
  'medidas en porcentaje': ['<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 100 1000"><rect width="100" height="1000" fill="#09c"/></svg>', 0.1]
};

for (const [nombre, [svg, ratio]] of Object.entries(RATIOS)) {
  test(`la vista previa no recorta un SVG ${nombre}`, async ({ page }) => {
    await paste(page, svg);

    const m = await page.evaluate(() => {
      const img = document.getElementById('previewImg');
      const box = document.getElementById('preview');
      const r = img.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return {
        img: { w: r.width, h: r.height },
        box: { w: b.width, h: b.height },
        page: document.documentElement.scrollWidth,
        viewport: window.innerWidth
      };
    });

    // La imagen cabe entera: nada que `overflow: hidden` pueda cortar.
    expect(m.img.w).toBeLessThanOrEqual(m.box.w + 1);
    expect(m.img.h).toBeLessThanOrEqual(m.box.h + 1);
    // Y conserva su proporción, sin deformarse para encajar.
    expect(m.img.w / m.img.h).toBeCloseTo(ratio, 1);
    // La caja tampoco se sale de la página.
    expect(m.box.w).toBeLessThanOrEqual(m.viewport);
    expect(m.page).toBeLessThanOrEqual(m.viewport);
  });
}

test('la caja adopta la proporción del SVG cuando cabe', async ({ page }) => {
  await paste(page, '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="#6d4aff"/></svg>');
  const box = await page.locator('#preview').boundingBox();
  expect(box.width / box.height).toBeCloseTo(1.5, 1);
});

// Es un objetivo que se pulsa: tiene que responder al puntero, no solo al foco.
test('la zona de carga reacciona al pasar el puntero', async ({ page }) => {
  const drop = page.locator('#drop');
  const leer = () => drop.evaluate((el) => {
    const s = getComputedStyle(el);
    return s.borderTopColor + ' | ' + s.backgroundColor;
  });

  const reposo = await leer();
  await drop.hover();
  // Hay una transición de .15s: el valor no cambia en el mismo instante.
  await expect.poll(leer).not.toBe(reposo);
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

// Compartir y abrir se explican con su icono; el nombre se queda en el título
// y en la etiqueta, que es lo que lee un lector de pantalla.
test('compartir y abrir son botones de icono, sin texto', async ({ page }) => {
  await upload(page, 'cuadrado.svg', PLAIN);

  for (const id of ['#btnShare', '#btnOpen']) {
    const btn = page.locator(id);
    expect((await btn.textContent()).trim()).toBe('');
    await expect(btn.locator('svg')).toHaveCount(1);
    await expect(btn).toHaveAttribute('aria-label', /\S/);
    await expect(btn).toHaveAttribute('title', /\S/);
  }
  // El de copiar, en cambio, sigue diciendo lo que hace.
  await expect(page.locator('#btnCopy')).toContainText('Copiar enlace');
});

test('sin credenciales de Google el carril de Drive no aparece', async ({ page }) => {
  await upload(page, 'cuadrado.svg', PLAIN);
  await expect(page.locator('#driveBox')).toBeHidden();
});
