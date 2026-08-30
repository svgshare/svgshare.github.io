/*
 * Selector de tema en el pie, y el arreglo del icono de imagen rota.
 *
 * «auto» se representa quitando el atributo del <html>, de modo que mande
 * prefers-color-scheme; claro y oscuro lo escriben para ganarle.
 */
const { test, expect } = require('@playwright/test');
const { PLAIN, paste } = require('./helpers');
const { mockGoogle } = require('./google-mock');

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const PAYLOAD = 'b=' + b64url(PLAIN);

const theme = (page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const bg = (page) => page.evaluate(() =>
  getComputedStyle(document.body).backgroundColor);

/* ------------------------------------------------------------- presencia */

test('la portada tiene selector de tema en el pie', async ({ page }) => {
  await page.goto('/');
  const box = page.locator('#creator .foot .theme-switch');
  await expect(box).toBeVisible();
  await expect(box.locator('button')).toHaveText(['Auto', 'Claro', 'Oscuro']);
});

test('el visor también lo tiene', async ({ page }) => {
  await page.goto(`/#${PAYLOAD}`);
  await expect(page.locator('#viewer .foot .theme-switch')).toBeVisible();
});

test('la vista de carpeta también lo tiene', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/account/');
  await expect(page.locator('.foot .theme-switch')).toBeVisible();
});

/* -------------------------------------------------------------- elección */

test('arranca en automático, sin atributo', async ({ page }) => {
  await page.goto('/');
  expect(await theme(page)).toBeNull();
  await expect(page.locator('#creator .theme-switch button[data-theme="auto"]'))
    .toHaveAttribute('aria-pressed', 'true');
});

test('elegir oscuro lo aplica y cambia el fondo', async ({ page }) => {
  await page.goto('/');
  const antes = await bg(page);

  await page.locator('#creator .theme-switch button[data-theme="dark"]').click();
  expect(await theme(page)).toBe('dark');
  expect(await bg(page)).not.toBe(antes);
  await expect(page.locator('#creator .theme-switch button[data-theme="dark"]'))
    .toHaveAttribute('aria-pressed', 'true');
});

test('elegir claro gana al sistema en oscuro', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const oscuro = await bg(page);

  await page.locator('#creator .theme-switch button[data-theme="light"]').click();
  expect(await theme(page)).toBe('light');
  expect(await bg(page)).not.toBe(oscuro);
});

test('elegir oscuro gana al sistema en claro', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const claro = await bg(page);

  await page.locator('#creator .theme-switch button[data-theme="dark"]').click();
  expect(await bg(page)).not.toBe(claro);
});

test('volver a automático devuelve el mando al sistema', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const sistema = await bg(page);

  await page.locator('#creator .theme-switch button[data-theme="light"]').click();
  expect(await bg(page)).not.toBe(sistema);

  await page.locator('#creator .theme-switch button[data-theme="auto"]').click();
  expect(await theme(page)).toBeNull();
  expect(await bg(page)).toBe(sistema);
});

/* ---------------------------------------------------------- persistencia */

test('la elección sobrevive a una recarga y no hay destello', async ({ page }) => {
  await page.goto('/');
  await page.locator('#creator .theme-switch button[data-theme="dark"]').click();

  await page.reload();
  // Se aplica antes del primer pintado: ya está puesto al ejecutar el primer script.
  const alArrancar = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(alArrancar).toBe('dark');
  await expect(page.locator('#creator .theme-switch button[data-theme="dark"]'))
    .toHaveAttribute('aria-pressed', 'true');
});

test('la elección se comparte entre la portada y la carpeta', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await page.locator('#creator .theme-switch button[data-theme="dark"]').click();

  await page.goto('/account/');
  expect(await theme(page)).toBe('dark');
});

test('sin localStorage la página sigue funcionando', async ({ page }) => {
  await page.addInitScript(() => {
    // Como en una ventana privada con el almacenamiento bloqueado.
    Object.defineProperty(window, 'localStorage', {
      get() { throw new Error('bloqueado'); }
    });
  });
  await page.goto('/');
  await expect(page.locator('#creator .theme-switch')).toBeVisible();
  expect(await theme(page)).toBeNull();

  await page.locator('#creator .theme-switch button[data-theme="dark"]').click();
  expect(await theme(page)).toBe('dark');
});

// Visor y creador conviven en index.html, así que hay dos selectores en el
// documento aunque solo uno se vea. Tienen que decir lo mismo.
test('los dos selectores de index.html se mantienen coherentes', async ({ page }) => {
  await page.goto('/');
  await page.locator('#creator .theme-switch button[data-theme="dark"]').click();

  const pressed = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.theme-switch button[data-theme="dark"]'))
      .map((b) => b.getAttribute('aria-pressed')));
  expect(pressed).toHaveLength(2);
  expect(pressed).toEqual(['true', 'true']);
});

/* -------------------------------------------------- icono de imagen rota */

test('el visor no muestra un <img> sin src mientras carga', async ({ page }) => {
  await page.goto('/');
  const visible = await page.evaluate(() => {
    const img = document.getElementById('stageImg');
    return { src: img.getAttribute('src'), display: getComputedStyle(img).display };
  });
  expect(visible.src).toBeNull();
  expect(visible.display).toBe('none');
});

test('la vista previa del creador tampoco, antes de cargar nada', async ({ page }) => {
  await page.goto('/');
  const display = await page.evaluate(() =>
    getComputedStyle(document.getElementById('previewImg')).display);
  expect(display).toBe('none');
});

test('en cuanto hay src la imagen se muestra', async ({ page }) => {
  await page.goto('/');
  await paste(page, PLAIN);
  const display = await page.evaluate(() =>
    getComputedStyle(document.getElementById('previewImg')).display);
  expect(display).toBe('block');
});

test('las tarjetas de la carpeta no parpadean rotas mientras se piden', async ({ page }) => {
  await mockGoogle(page, { files: [{ name: 'logo.svg' }] });
  await page.goto('/account/');
  await page.locator('#btnSignin').click();
  // El hueco de añadir también es .tile y está desde el principio: hay que
  // esperar a la tarjeta de la imagen, que es la que trae el <img>.
  await page.locator('.tile:not(.tile-add)').first().waitFor();

  // Nada más existir la tarjeta, el <img> aún no tiene src: no debe ocupar.
  const antes = await page.evaluate(() => {
    const img = document.querySelector('.tile-art img');
    return img.hasAttribute('src') ? 'ya-cargada' : getComputedStyle(img).display;
  });
  expect(['none', 'ya-cargada']).toContain(antes);

  await expect(page.locator('.tile-art img')).toHaveAttribute('src', /^data:/);
  const despues = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.tile-art img')).display);
  expect(despues).toBe('block');
});
