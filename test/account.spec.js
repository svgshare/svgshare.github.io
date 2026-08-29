/*
 * La vista de carpeta (/account/): entrar, listar, subir, compartir, borrar y
 * la barra de cuota. Todo contra el Drive simulado de test/google-mock.js.
 *
 * El token vive solo en memoria, así que cada carga empieza sin sesión: el
 * botón de Google es siempre el punto de entrada.
 */
const { test, expect } = require('@playwright/test');
const { mockGoogle, PLAIN } = require('./google-mock');

const TALL = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="1000" viewBox="0 0 100 1000"><rect width="100" height="1000" fill="#0a0"/></svg>';

// Entra y espera a que la carpeta esté pintada.
async function signIn(page) {
  await page.locator('#btnSignin').click();
  await page.locator('#folderBox').waitFor({ state: 'visible' });
  await page.waitForFunction(() =>
    document.getElementById('grid').children.length > 0 ||
    !document.getElementById('emptyNote').hidden);
}

/* ------------------------------------------------------------------ entrar */

test('sin sesión se ofrece el botón de Google', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/account/');
  await expect(page.locator('#signinBox')).toBeVisible();
  await expect(page.locator('#btnSignin')).toContainText('Entrar con Google');
  await expect(page.locator('#folderBox')).toBeHidden();
});

test('entrar abre la carpeta y pide solo el scope drive.file', async ({ page }) => {
  await mockGoogle(page, { files: [{ name: 'logo.svg' }] });
  await page.goto('/account/');
  await signIn(page);

  await expect(page.locator('#signinBox')).toBeHidden();
  await expect(page.locator('.tile')).toHaveCount(1);
  const config = await page.evaluate(() => window.__gisConfig);
  expect(config.scope).toBe('https://www.googleapis.com/auth/drive.file');
});

test('cancelar el acceso deja el botón y explica por qué', async ({ page }) => {
  await mockGoogle(page, { authError: 'auth-cancelled' });
  await page.goto('/account/');
  await page.locator('#btnSignin').click();
  await expect(page.locator('#signinError')).toContainText('Se canceló el acceso');
  await expect(page.locator('#btnSignin')).toBeEnabled();
});

test('si no se alcanza Google se dice', async ({ page }) => {
  await mockGoogle(page, { gisReachable: false });
  await page.goto('/account/');
  await page.locator('#btnSignin').click();
  await expect(page.locator('#signinError')).toContainText('No se pudo contactar con Google');
});

test('sin credenciales en el despliegue no hay carpeta que enseñar', async ({ page }) => {
  await mockGoogle(page, { clientId: '', apiKey: '' });
  await page.goto('/account/');
  await expect(page.locator('#offBox')).toBeVisible();
  await expect(page.locator('#signinBox')).toBeHidden();
});

test('el token sigue sin tocar localStorage ni cookies', async ({ page }) => {
  await mockGoogle(page, { files: [{ name: 'logo.svg' }] });
  await page.goto('/account/');
  await signIn(page);

  const stored = await page.evaluate(() => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
    cookie: document.cookie
  }));
  expect(stored.local).toBe('[]');
  expect(stored.session).toBe('[]');
  expect(stored.cookie).not.toContain('fake-token');
});

/* ----------------------------------------------------------------- carpeta */

test('la carpeta se crea si no existía', async ({ page }) => {
  const state = await mockGoogle(page, { folderMissing: true });
  await page.goto('/account/');
  await signIn(page);
  expect(state.folderCreated).toBe(true);
});

test('una carpeta vacía lo dice en vez de quedarse en blanco', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);
  await expect(page.locator('#emptyNote')).toBeVisible();
  await expect(page.locator('.tile')).toHaveCount(0);
});

test('cada tarjeta muestra nombre, peso y previsualización', async ({ page }) => {
  await mockGoogle(page, { files: [{ name: 'logo.svg' }, { name: 'icono.svg' }] });
  await page.goto('/account/');
  await signIn(page);

  await expect(page.locator('.tile')).toHaveCount(2);
  await expect(page.locator('.tile-name').first()).toHaveText('logo.svg');
  await expect(page.locator('.tile-size').first()).toContainText('B');

  const src = await page.locator('.tile-art img').first().getAttribute('src');
  expect(src).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(Buffer.from(src.split(',')[1], 'base64').toString('utf8')).toContain('<rect');
});

test('la previsualización de la carpeta tampoco recorta un SVG alto', async ({ page }) => {
  await mockGoogle(page, { files: [{ name: 'alto.svg', content: TALL }] });
  await page.goto('/account/');
  await signIn(page);

  // Hay que esperar a que el navegador la decodifique: con el src ya puesto,
  // el elemento todavía mide 0×0 durante un instante.
  await page.waitForFunction(() => {
    const img = document.querySelector('.tile-art img');
    return img && img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().height > 0;
  });
  const m = await page.evaluate(() => {
    const img = document.querySelector('.tile-art img');
    const box = document.querySelector('.tile-art');
    const r = img.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return { iw: r.width, ih: r.height, bw: b.width, bh: b.height };
  });
  expect(m.ih).toBeLessThanOrEqual(m.bh + 1);
  expect(m.iw).toBeLessThanOrEqual(m.bw + 1);
  expect(m.iw / m.ih).toBeCloseTo(0.1, 1);
});

test('el SVG que llega de Drive pasa por el saneador antes de pintarse', async ({ page }) => {
  await mockGoogle(page, {
    files: [{
      name: 'sucio.svg',
      content: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
        '<script>window.__pwned = 1;<\/script>' +
        '<image href="https://example.com/tracker.png" width="4" height="4"/>' +
        '<rect width="10" height="10"/></svg>'
    }]
  });
  await page.goto('/account/');
  await signIn(page);

  const src = await page.locator('.tile-art img').getAttribute('src');
  const svg = Buffer.from(src.split(',')[1], 'base64').toString('utf8');
  expect(svg).not.toContain('script');
  expect(svg).not.toContain('example.com');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('cada tarjeta enlaza al visor del fichero', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'logo.svg' }] });
  await page.goto('/account/');
  await signIn(page);

  const href = await page.locator('.tile-open').getAttribute('href');
  const url = new URL(href);
  expect(url.pathname).toBe('/');
  expect(url.searchParams.get('d')).toBe([...state.store.keys()][0]);
  expect(url.searchParams.get('n')).toBe('logo.svg');
});

/* ------------------------------------------------------------------ subir */

test('subir un SVG lo guarda en la carpeta, ya saneado', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);

  await page.setInputFiles('#file', {
    name: 'nuevo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<script>window.__pwned = 1;<\/script><rect width="10" height="10"/></svg>')
  });
  await expect(page.locator('.tile')).toHaveCount(1);

  const stored = [...state.store.values()][0];
  expect(stored.name).toBe('nuevo.svg');
  expect(stored.parent).toBe(state.folderId);
  expect(stored.content).not.toContain('script');
});

test('un archivo que no es SVG se rechaza al subir', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/');
  await signIn(page);

  await page.setInputFiles('#file', {
    name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from('no soy svg')
  });
  await expect(page.locator('#toast')).toContainText('no es un SVG');
  expect(state.store.size).toBe(0);
});

test('un fallo al subir se explica y no deja la vista rota', async ({ page }) => {
  await mockGoogle(page, { failUpload: 500 });
  await page.goto('/account/');
  await signIn(page);

  await page.setInputFiles('#file', {
    name: 'nuevo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(PLAIN)
  });
  await expect(page.locator('#toast')).toContainText('Algo falló con Drive');
  await expect(page.locator('#folderBox')).toBeVisible();
});

/* -------------------------------------------------------------- compartir */

test('compartir una imagen la hace pública y da el enlace corto', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'logo.svg' }] });
  await page.goto('/account/');
  await signIn(page);

  await page.locator('.tile-actions .linkish').first().click();
  await expect(page.locator('#shareDialog')).toBeVisible();

  const link = page.locator('#shareLink');
  await expect(link).not.toHaveValue('Preparando…');
  const url = new URL(await link.inputValue());
  expect(url.searchParams.get('d')).toBe([...state.store.keys()][0]);
  expect(url.searchParams.get('n')).toBe('logo.svg');
  expect([...state.store.values()][0].shared).toBe(true);
  await expect(page.locator('.tile-size')).toContainText('compartido');
});

test('compartir la carpeta da un enlace a la vista de carpeta', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'logo.svg' }] });
  await page.goto('/account/');
  await signIn(page);

  await page.locator('#btnShareFolder').click();
  const link = page.locator('#shareLink');
  await expect(link).not.toHaveValue('Preparando…');
  const url = new URL(await link.inputValue());
  expect(url.pathname).toBe('/account/');
  expect(url.searchParams.get('f')).toBe(state.folderId);
  expect(state.folderShared).toBe(true);
});

test('dejar de compartir revoca el permiso', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'logo.svg', shared: true }] });
  await page.goto('/account/');
  await signIn(page);

  await page.locator('.tile-actions .linkish').first().click();
  await expect(page.locator('#shareLink')).not.toHaveValue('Preparando…');
  await page.locator('#btnUnshare').click();

  await expect(page.locator('#toast')).toContainText('Ya no se comparte');
  expect([...state.store.values()][0].shared).toBe(false);
  await expect(page.locator('.tile-size')).not.toContainText('compartido');
});

test('una cuenta que no permite compartir se explica', async ({ page }) => {
  await mockGoogle(page, { files: [{ name: 'logo.svg' }], failPermission: 403 });
  await page.goto('/account/');
  await signIn(page);

  await page.locator('.tile-actions .linkish').first().click();
  await expect(page.locator('#toast')).toContainText('no permite compartir');
});

/* ----------------------------------------------------------------- borrar */

test('borrar quita el fichero de Drive y de la vista, tras confirmar', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'logo.svg' }, { name: 'otro.svg' }] });
  await page.goto('/account/');
  await signIn(page);

  page.on('dialog', (dialog) => dialog.accept());
  await page.locator('.tile').first().locator('.is-danger').click();

  await expect(page.locator('.tile')).toHaveCount(1);
  expect(state.store.size).toBe(1);
});

test('cancelar la confirmación no borra nada', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'logo.svg' }] });
  await page.goto('/account/');
  await signIn(page);

  page.on('dialog', (dialog) => dialog.dismiss());
  await page.locator('.is-danger').click();

  await expect(page.locator('.tile')).toHaveCount(1);
  expect(state.store.size).toBe(1);
});

/* ------------------------------------------------------------------ cuota */

test('la barra de cuota muestra uso, tope y porcentaje', async ({ page }) => {
  await mockGoogle(page, {
    files: [{ name: 'logo.svg' }],
    quota: { usage: 3 * 1024 * 1024 * 1024, limit: 15 * 1024 * 1024 * 1024 }
  });
  await page.goto('/account/');
  await signIn(page);

  await expect(page.locator('#quotaBox')).toBeVisible();
  await expect(page.locator('#quotaFigure')).toContainText('de');
  await expect(page.locator('#quotaFigure')).toContainText('GB');
  await expect(page.locator('#quotaNote')).toContainText('20%');
  const width = await page.locator('#quotaFill').evaluate((el) => el.style.width);
  expect(parseFloat(width)).toBeCloseTo(20, 0);
});

test('un Drive casi lleno avisa', async ({ page }) => {
  await mockGoogle(page, {
    quota: { usage: 14.5 * 1024 * 1024 * 1024, limit: 15 * 1024 * 1024 * 1024 }
  });
  await page.goto('/account/');
  await signIn(page);
  await expect(page.locator('#quotaNote')).toContainText('casi lleno');
});

test('una cuenta sin tope no finge una barra', async ({ page }) => {
  await mockGoogle(page, { quota: { usage: 1024 * 1024, limit: null } });
  await page.goto('/account/');
  await signIn(page);
  await expect(page.locator('#quotaNote')).toContainText('no tiene límite');
  expect(await page.locator('#quotaFill').evaluate((el) => el.style.width)).toBe('0%');
});

/* ------------------------------------------------- carpeta ajena, anónima */

test('una carpeta compartida se abre sin sesión y en solo lectura', async ({ page }) => {
  const state = await mockGoogle(page, { files: [{ name: 'logo.svg', shared: true }] });
  await page.goto('/account/');
  await signIn(page);
  await page.locator('#btnShareFolder').click();
  await expect(page.locator('#shareLink')).not.toHaveValue('Preparando…');
  const shared = await page.locator('#shareLink').inputValue();

  // Otra pestaña, sin sesión ninguna.
  const guest = await page.context().newPage();
  await mockGoogleShared(guest, state);
  await guest.goto(shared);

  await expect(guest.locator('.tile')).toHaveCount(1);
  await expect(guest.locator('#uploadCard')).toBeHidden();
  await expect(guest.locator('.tile-actions')).toHaveCount(0);
  expect(await guest.evaluate(() => window.__gisConfig)).toBeUndefined();
});

test('una carpeta que ya no es pública deja mensaje', async ({ page }) => {
  await mockGoogle(page);
  await page.goto('/account/?f=1AbCdEfGhIjKlMnOpQrStUvWxYz012345');
  await expect(page.locator('#emptyNote')).toContainText('ya no exista');
});

test('un id de carpeta con forma inválida no genera peticiones', async ({ page }) => {
  const state = await mockGoogle(page);
  await page.goto('/account/?f=../../secreto');
  await expect(page.locator('#offBox')).toBeVisible();
  expect(state.calls.filter((c) => c.path.startsWith('/drive'))).toHaveLength(0);
});

// La pestaña invitada necesita su propio enrutado, compartiendo el estado.
async function mockGoogleShared(guest, state) {
  await guest.route('**/assets/config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: "window.SVGSHARE_CONFIG = { googleClientId: 'test-client-id.apps.googleusercontent.com', googleApiKey: 'test-api-key' };"
  }));
  await guest.route('https://www.googleapis.com/**', (route) => {
    const url = new URL(route.request().url());
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const q = url.searchParams.get('q') || '';
    const parent = (q.match(/'([^']+)' in parents/) || [])[1];

    if (url.pathname === '/drive/v3/files' && parent === state.folderId && state.folderShared) {
      const files = [...state.store.values()].map((f) => ({
        id: f.id, name: f.name, size: String(f.content.length),
        shared: f.shared, mimeType: f.mimeType
      }));
      return route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({ files }) });
    }
    const one = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (one && url.searchParams.get('alt') === 'media') {
      const file = state.store.get(one[1]);
      if (file && file.shared) {
        return route.fulfill({ headers: cors, contentType: 'image/svg+xml', body: file.content });
      }
    }
    return route.fulfill({
      status: 404, headers: cors, contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'File not found' } })
    });
  });
}
