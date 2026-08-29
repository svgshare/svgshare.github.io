/*
 * Carril de Google Drive, contra endpoints simulados.
 *
 * Ojo con lo que estas pruebas NO demuestran: que Google responda de verdad
 * como se simula aquí. En particular la lectura anónima —`files.get?alt=media`
 * con API key desde otro origen— necesita cabeceras CORS, que aquí se dan por
 * supuestas. Es la pieza pendiente de confirmar con credenciales reales.
 */
const { test, expect } = require('@playwright/test');
const { PLAIN, CRUFTY, heavySvg, upload, linkOf } = require('./helpers');

const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const CORS = { 'Access-Control-Allow-Origin': '*' };

// Sustituye config.js (vacío en el repo) y los tres endpoints de Google.
async function mockGoogle(page, options = {}) {
  const opts = {
    clientId: 'test-client-id.apps.googleusercontent.com',
    apiKey: 'test-api-key',
    authError: null,      // 'auth-cancelled', 'popup_failed_to_open'…
    gisReachable: true,
    uploadStatus: 200,
    permissionStatus: 200,
    downloadStatus: 200,
    downloadBody: PLAIN,
    ...options
  };
  const calls = { upload: [], permissions: [], download: [] };

  await page.route('**/assets/config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `window.SVGSHARE_CONFIG = ${JSON.stringify({
      googleClientId: opts.clientId,
      googleApiKey: opts.apiKey
    })};`
  }));

  await page.route('https://accounts.google.com/gsi/client', (route) => {
    if (!opts.gisReachable) return route.abort('failed');
    return route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.google = { accounts: { oauth2: { initTokenClient: function (config) {
          window.__gisConfig = config;
          return {
            callback: config.callback,
            error_callback: null,
            requestAccessToken: function () {
              var self = this;
              window.__authRequests = (window.__authRequests || 0) + 1;
              setTimeout(function () {
                ${opts.authError
                  ? `if (self.error_callback) self.error_callback({ type: ${JSON.stringify(opts.authError)} });`
                  : `self.callback({ access_token: 'fake-token', expires_in: 3600 });`}
              }, 0);
            }
          };
        } } } };`
    });
  });

  await page.route('https://www.googleapis.com/upload/drive/v3/files**', async (route) => {
    calls.upload.push({
      headers: route.request().headers(),
      body: route.request().postData()
    });
    if (opts.uploadStatus !== 200) {
      return route.fulfill({
        status: opts.uploadStatus,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'nope' } })
      });
    }
    return route.fulfill({
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({ id: FILE_ID })
    });
  });

  await page.route('https://www.googleapis.com/drive/v3/files/**', async (route) => {
    const url = route.request().url();

    if (url.includes('/permissions')) {
      calls.permissions.push({
        headers: route.request().headers(),
        body: route.request().postDataJSON()
      });
      return route.fulfill({
        status: opts.permissionStatus,
        headers: CORS,
        contentType: 'application/json',
        body: opts.permissionStatus === 200
          ? JSON.stringify({ id: 'perm' })
          : JSON.stringify({ error: { message: 'sharing is disabled' } })
      });
    }

    calls.download.push(url);
    if (opts.downloadStatus !== 200) {
      return route.fulfill({
        status: opts.downloadStatus,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'File not found' } })
      });
    }
    // La suposición del proyecto, escrita: Google responde con CORS abierto.
    return route.fulfill({
      headers: CORS,
      contentType: 'image/svg+xml',
      body: opts.downloadBody
    });
  });

  return calls;
}

async function saveToDrive(page) {
  await page.locator('#btnDrive').click();
  await page.locator('#linkBadge').waitFor({ state: 'visible' });
}

/* --------------------------------------------------------------- presencia */

test('con client id configurado el carril aparece', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await expect(page.locator('#driveBox')).toBeVisible();
});

test('sin client id el carril no aparece aunque haya API key', async ({ page }) => {
  await mockGoogle(page, { clientId: '' });
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await expect(page.locator('#driveBox')).toBeHidden();
});

test('el carril se resalta cuando el enlace autocontenido se pone largo', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');

  await upload(page, 'pequeno.svg', PLAIN);
  await expect(page.locator('#driveBox')).not.toHaveClass(/is-nudged/);
  await expect(page.locator('#driveSub')).toContainText('La imagen se guarda en tu cuenta');

  await page.locator('#btnReset').click();
  await upload(page, 'pesado.svg', heavySvg(1400));
  await expect(page.locator('#driveBox')).toHaveClass(/is-nudged/);
  await expect(page.locator('#driveSub')).toContainText('genera un enlace largo');
});

/* ----------------------------------------------------------------- guardar */

test('guardar sube el SVG y lo hace público, en ese orden', async ({ page }) => {
  const calls = await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await saveToDrive(page);

  expect(calls.upload).toHaveLength(1);
  expect(calls.upload[0].headers.authorization).toBe('Bearer fake-token');
  expect(calls.upload[0].headers['content-type']).toMatch(/^multipart\/related; boundary=svgshare-/);
  expect(calls.upload[0].body).toContain('"name":"cuadrado.svg"');
  expect(calls.upload[0].body).toContain('"mimeType":"image/svg+xml"');
  expect(calls.upload[0].body).toContain('<rect');

  expect(calls.permissions).toHaveLength(1);
  expect(calls.permissions[0].body).toEqual({ role: 'reader', type: 'anyone' });
  await expect(page.locator('#toast')).toHaveText('Guardado en tu Drive');
});

test('el enlace corto lleva el id en la query string y ronda los 70 caracteres', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await saveToDrive(page);

  const link = await linkOf(page);
  const url = new URL(link);
  expect(url.searchParams.get('d')).toBe(FILE_ID);
  expect(url.searchParams.get('n')).toBe('cuadrado.svg');
  expect(url.hash).toBe('');
  expect(link.length).toBeLessThan(100);
});

test('el pedido de scope es solo drive.file', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await saveToDrive(page);

  const config = await page.evaluate(() => window.__gisConfig);
  expect(config.scope).toBe('https://www.googleapis.com/auth/drive.file');
  expect(config.scope).not.toContain('email');
  expect(config.scope).not.toContain('profile');
});

test('el token no se guarda en localStorage, sessionStorage ni cookies', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await saveToDrive(page);

  const stored = await page.evaluate(() => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
    cookie: document.cookie
  }));
  expect(stored.local).not.toContain('fake-token');
  expect(stored.session).not.toContain('fake-token');
  expect(stored.cookie).not.toContain('fake-token');
  expect(stored.local).toBe('[]');
  expect(stored.session).toBe('[]');
});

test('el segundo guardado reutiliza el token en memoria', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await saveToDrive(page);

  const before = await page.evaluate(() => window.__authRequests || 0);
  await page.locator('#btnToggleMode').click();  // no vuelve a subir nada
  await expect(page.locator('#link')).toHaveValue(/#/);
  expect(await page.evaluate(() => window.__authRequests || 0)).toBe(before);
});

/* ------------------------------------------------------------- el conmutador */

test('una vez guardado se alterna entre los dos enlaces sin volver a subir', async ({ page }) => {
  const calls = await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  const inline = await linkOf(page);
  await saveToDrive(page);

  expect(await linkOf(page)).toContain('?d=');
  await expect(page.locator('#btnToggleMode')).toHaveText('usar el autocontenido');

  await page.locator('#btnToggleMode').click();
  await expect(page.locator('#link')).toHaveValue(inline);
  await expect(page.locator('#btnToggleMode')).toHaveText('usar el enlace corto');

  await page.locator('#btnToggleMode').click();
  await expect(page.locator('#link')).toHaveValue(/\?d=/);
  expect(calls.upload).toHaveLength(1);
});

test('en modo Drive el medidor siempre está en verde', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'pesado.svg', heavySvg(1400));
  await expect(page.locator('#meterLabel')).toHaveClass(/is-(warn|bad)/);

  await saveToDrive(page);
  await expect(page.locator('#meterLabel')).toHaveClass(/is-ok/);
  await expect(page.locator('#meterLabel')).toContainText('QR');
});

test('el botón de guardar desaparece mientras haya copia guardada', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await saveToDrive(page);
  await expect(page.locator('#driveBox')).toBeHidden();
});

test('cambiar el SVG descarta la copia obsoleta y avisa', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'dibujo.svg', CRUFTY);
  await saveToDrive(page);

  await page.locator('#optMinify').uncheck();   // el SVG cambia bajo la copia
  await expect(page.locator('#toast')).toHaveText(/vuelve a guardarlo/);
  await expect(page.locator('#linkBadge')).toBeHidden();
  await expect(page.locator('#link')).toHaveValue(/#/);
  await expect(page.locator('#driveBox')).toBeVisible();
});

test('«elegir otro archivo» olvida la copia guardada', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await saveToDrive(page);

  await page.locator('#btnReset').click();
  await upload(page, 'otro.svg', PLAIN);
  await expect(page.locator('#linkBadge')).toBeHidden();
  await expect(page.locator('#link')).toHaveValue(/#/);
});

/* -------------------------------------------------------------------- errores */

test('cancelar el acceso a Google se explica en castellano', async ({ page }) => {
  await mockGoogle(page, { authError: 'auth-cancelled' });
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await page.locator('#btnDrive').click();
  await expect(page.locator('#toast')).toHaveText('Se canceló el acceso a Google Drive');
  await expect(page.locator('#linkBadge')).toBeHidden();
});

test('una ventana emergente bloqueada se trata como cancelación', async ({ page }) => {
  await mockGoogle(page, { authError: 'popup_failed_to_open' });
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await page.locator('#btnDrive').click();
  await expect(page.locator('#toast')).toHaveText('Se canceló el acceso a Google Drive');
});

test('si no se alcanza Google se dice, no se calla', async ({ page }) => {
  await mockGoogle(page, { gisReachable: false });
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await page.locator('#btnDrive').click();
  await expect(page.locator('#toast')).toHaveText('No se pudo contactar con Google');
});

test('una cuenta que no permite compartir fuera de la organización', async ({ page }) => {
  await mockGoogle(page, { permissionStatus: 403 });
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await page.locator('#btnDrive').click();
  await expect(page.locator('#toast')).toHaveText('Tu cuenta no permite compartir fuera de la organización');
});

test('un 401 al subir invita a repetir', async ({ page }) => {
  await mockGoogle(page, { uploadStatus: 401 });
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await page.locator('#btnDrive').click();
  await expect(page.locator('#toast')).toHaveText('La sesión de Google caducó, inténtalo otra vez');
});

test('el botón se rehabilita tras un error', async ({ page }) => {
  await mockGoogle(page, { uploadStatus: 500 });
  await page.goto('/');
  await upload(page, 'cuadrado.svg', PLAIN);
  await page.locator('#btnDrive').click();
  await expect(page.locator('#toast')).toContainText('No se pudo guardar en Drive');
  await expect(page.locator('#btnDrive')).toBeEnabled();
  await expect(page.locator('#btnDrive')).toHaveText('Guardar en mi Drive');
});

/* --------------------------------------------------------------------- visor */

test('el visor lee el fichero público sin sesión, con API key', async ({ page }) => {
  const calls = await mockGoogle(page);
  await page.goto(`/?d=${FILE_ID}&n=logo.svg`);

  await expect(page.locator('#viewer')).toBeVisible();
  await expect(page.locator('#stageImg')).toBeVisible();
  await expect(page).toHaveTitle('SVGshare - logo.svg');

  expect(calls.download).toHaveLength(1);
  expect(calls.download[0]).toContain('alt=media');
  expect(calls.download[0]).toContain('key=test-api-key');
  // Sin sesión: el visor no toca el flujo de OAuth.
  expect(await page.evaluate(() => window.__gisConfig)).toBeUndefined();
});

test('el SVG traído de Drive pasa por el mismo saneador', async ({ page }) => {
  await mockGoogle(page, {
    downloadBody: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<script>window.__pwned = 1;<\/script>' +
      '<image href="https://example.com/tracker.png" width="4" height="4"/>' +
      '<rect width="10" height="10"/></svg>'
  });
  await page.goto(`/?d=${FILE_ID}`);
  await expect(page.locator('#stageImg')).toBeVisible();

  const src = await page.locator('#stageImg').getAttribute('src');
  const svg = Buffer.from(src.split(',')[1], 'base64').toString('utf8');
  expect(svg).not.toContain('script');
  expect(svg).not.toContain('example.com');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('un id de fichero con forma inválida no genera ninguna petición', async ({ page }) => {
  const calls = await mockGoogle(page);
  await page.goto('/?d=../../secreto');
  await expect(page.locator('#stageError')).toBeVisible();
  expect(calls.download).toHaveLength(0);
});

test('un fichero borrado o ya no público deja mensaje y salida', async ({ page }) => {
  await mockGoogle(page, { downloadStatus: 404 });
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
