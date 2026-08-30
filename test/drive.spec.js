/*
 * Lo que queda del carril de Drive fuera de /account/: el atajo de la portada y
 * el visor de un enlace corto.
 *
 * Ojo con lo que estas pruebas NO demuestran: que Google responda de verdad
 * como se simula aquí. En particular la lectura anónima —`files.get?alt=media`
 * con API key desde otro origen— necesita cabeceras CORS, que aquí se dan por
 * supuestas. Es la pieza pendiente de confirmar con credenciales reales.
 */
const { test, expect } = require('@playwright/test');
const { mockGoogle } = require('./google-mock');
const { PLAIN, heavySvg, upload } = require('./helpers');

const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

/* ------------------------------------------------------ atajo de la portada */

// Sin haber cargado nada tiene que haber camino a la carpeta: la tarjeta del
// resultado vive dentro de #result, que está oculto hasta que hay un SVG.
test('se puede ir a la carpeta sin haber cargado ninguna imagen', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');

  await expect(page.locator('#result')).toBeHidden();
  const link = page.locator('#accountLink');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', './account/');
});

test('el enlace de cabecera lleva de verdad a la carpeta', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await page.locator('#accountLink').click();

  await expect(page).toHaveURL(/\/account\/$/);
  await expect(page.locator('#signinBox')).toBeVisible();
});

test('sin credenciales no hay enlace de cabecera', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#accountLink')).toBeHidden();
});

test('tras cargar un SVG conviven los dos caminos', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);

  await expect(page.locator('#accountLink')).toBeVisible();
  await expect(page.locator('#driveLink')).toBeVisible();
});

test('con las dos credenciales la portada enlaza a la carpeta', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);

  const link = page.locator('#driveLink');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', './account/');
});

test('sin credenciales la portada no menciona Drive', async ({ page }) => {
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await expect(page.locator('#driveLink')).toBeHidden();
});

test('sin client id el atajo no aparece aunque haya API key', async ({ page }) => {
  await mockGoogle(page, { clientId: '' });
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await expect(page.locator('#driveLink')).toBeHidden();
});

// Media configuración es peor que ninguna: el enlace corto que se ofrecería
// desde /account/ no lo sabría abrir este mismo despliegue.
test('sin API key el atajo no aparece aunque haya client id', async ({ page }) => {
  await mockGoogle(page, { apiKey: '' });
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await expect(page.locator('#driveLink')).toBeHidden();
});

test('el atajo se resalta cuando el enlace autocontenido se pone largo', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');

  await upload(page, 'pequeno.svg', PLAIN);
  await expect(page.locator('#driveLink')).not.toHaveClass(/is-nudged/);

  await page.locator('#btnReset').click();
  await upload(page, 'pesado.svg', heavySvg(1400));
  await expect(page.locator('#driveLink')).toHaveClass(/is-nudged/);
  await expect(page.locator('#driveSub')).toContainText('genera un enlace largo');
});

test('la portada ya no ofrece guardar en Drive', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);

  // El enlace del creador es siempre el autocontenido.
  await expect(page.locator('#link')).toHaveValue(/#/);
  expect(await page.locator('#btnDrive').count()).toBe(0);
  expect(await page.locator('#btnToggleMode').count()).toBe(0);
});

/* --------------------------------------------------------------------- visor */

test('el visor lee el fichero público sin sesión, con API key', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'logo.svg', shared: true }] });
  const id = state.files[0].id;
  await page.goto(`/?d=${id}&n=logo.svg`);

  await expect(page.locator('#viewer')).toBeVisible();
  await expect(page.locator('#stageImg')).toBeVisible();
  await expect(page).toHaveTitle('SVGshare - logo.svg');

  const read = state.calls.filter((c) => c.search.includes('alt=media'));
  expect(read).toHaveLength(1);
  expect(read[0].search).toContain('key=test-api-key');
  // Sin sesión: el visor no toca el flujo de OAuth.
  expect(await page.evaluate(() => window.__gisConfig)).toBeUndefined();
});

test('el SVG traído de Drive pasa por el mismo saneador', async ({ page }) => {
  const state = await mockGoogle(page, {
    files: [{
      name: 'sucio.svg',
      shared: true,
      content: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
        '<script>window.__pwned = 1;<\/script>' +
        '<image href="https://example.com/tracker.png" width="4" height="4"/>' +
        '<rect width="10" height="10"/></svg>'
    }]
  });
  await page.goto(`/?d=${state.files[0].id}`);
  await expect(page.locator('#stageImg')).toBeVisible();

  const src = await page.locator('#stageImg').getAttribute('src');
  const svg = Buffer.from(src.split(',')[1], 'base64').toString('utf8');
  expect(svg).not.toContain('script');
  expect(svg).not.toContain('example.com');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('un id de fichero con forma inválida no genera ninguna petición', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/?d=../../secreto');
  await expect(page.locator('#stageError')).toBeVisible();
  expect(state.calls.filter((c) => c.path.startsWith('/drive'))).toHaveLength(0);
});

test('un fichero borrado o ya no público deja mensaje y salida', async ({ page }) => {
  await mockGoogle(page);
  await page.goto(`/?d=${FILE_ID}`);

  await expect(page.locator('#stageError')).toContainText('Puede que ya no exista');
  const link = page.locator('.stage-link');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', `https://drive.google.com/file/d/${FILE_ID}/view`);
  await expect(link).toHaveAttribute('rel', 'noopener');
});

test('sin API key el visor de Drive lo dice en vez de fallar en silencio', async ({ page }) => {
  await mockGoogle(page, { apiKey: '' });
  await page.goto(`/?d=${FILE_ID}`);
  await expect(page.locator('#stageError')).toContainText('no tiene configurada la lectura');
});
