/*
 * Un Google Drive de mentira, con estado, para las suites.
 *
 * Cubre lo que la app usa: buscar/crear la carpeta, listar, subir, leer,
 * borrar, compartir y dejar de compartir, y la cuota. Un único manejador para
 * todo googleapis.com que despacha por método y ruta, para no depender del
 * orden en que Playwright resuelve las rutas.
 *
 * Lo que NO demuestra: que Google se comporte así. En particular las cabeceras
 * CORS de la lectura y el listado anónimos se dan por supuestas aquí, y siguen
 * sin confirmarse contra el servicio real.
 */
const CORS = { 'Access-Control-Allow-Origin': '*' };
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const PLAIN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24" viewBox="0 0 48 24">' +
  '<rect width="48" height="24" fill="#6d4aff"/></svg>';

let seq = 0;
function newId(prefix) {
  seq += 1;
  return (prefix + '0123456789abcdefghij').slice(0, 24) + String(seq).padStart(4, '0');
}

async function mockGoogle(page, options = {}) {
  const opts = {
    clientId: 'test-client-id.apps.googleusercontent.com',
    apiKey: 'test-api-key',
    authError: null,
    gisReachable: true,
    files: [],              // [{ name, content, shared }] ya en la carpeta
    folderMissing: false,   // la carpeta SVGshare aún no existe
    quota: { usage: 3 * 1024 * 1024 * 1024, limit: 15 * 1024 * 1024 * 1024 },
    failList: 0,
    failUpload: 0,
    failDelete: 0,
    failPermission: 0,
    ...options
  };

  const folderId = newId('fold');
  const store = new Map();
  store.set(folderId, {
    id: folderId, name: 'SVGshare', parent: null, shared: false, mimeType: FOLDER_MIME
  });
  // Subcarpetas de partida: { name, folder: true, parentName }
  const byName = new Map([['SVGshare', folderId]]);
  for (const file of opts.files) {
    const id = newId(file.folder ? 'fold' : 'file');
    const parent = file.parent ? byName.get(file.parent) || folderId : folderId;
    store.set(id, {
      id,
      name: file.name,
      content: file.folder ? null : (file.content || PLAIN),
      shared: Boolean(file.shared),
      parent,
      mimeType: file.folder ? FOLDER_MIME : 'image/svg+xml'
    });
    if (file.folder) byName.set(file.name, id);
  }
  const state = {
    folderId, folderCreated: false, folderShared: false, store, byName, calls: [],
    // El store guarda también las carpetas (la raíz incluida), así que las
    // pruebas piden por separado lo que les interesa.
    get files() { return [...store.values()].filter((f) => f.mimeType !== FOLDER_MIME); },
    get folders() { return [...store.values()].filter((f) => f.mimeType === FOLDER_MIME); }
  };

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

  const json = (body, status = 200) => ({
    status,
    headers: CORS,
    contentType: 'application/json',
    body: JSON.stringify(body)
  });
  const fail = (status, message) => json({ error: { message } }, status);

  await page.route('https://www.googleapis.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    state.calls.push({ method, path, search: url.search, headers: request.headers() });

    const authed = (request.headers().authorization || '') === 'Bearer fake-token';
    const keyed = url.searchParams.get('key') === opts.apiKey && Boolean(opts.apiKey);

    /* -------- subida -------- */
    if (path.startsWith('/upload/drive/v3/files')) {
      if (opts.failUpload) return route.fulfill(fail(opts.failUpload, 'no se pudo subir'));
      if (!authed) return route.fulfill(fail(401, 'Login Required'));
      const body = request.postData() || '';
      const meta = JSON.parse(body.match(/\{[\s\S]*?\}/)[0]);
      const id = newId('file');
      const content = body.split('\r\n\r\n')[2].split('\r\n--')[0];
      store.set(id, {
        id,
        name: meta.name,
        content,
        shared: false,
        parent: (meta.parents || [])[0] || null,
        mimeType: 'image/svg+xml'
      });
      return route.fulfill(json({ id }));
    }

    /* -------- cuota -------- */
    if (path === '/drive/v3/about') {
      if (!authed) return route.fulfill(fail(401, 'Login Required'));
      const q = {};
      if (opts.quota) {
        q.usage = String(opts.quota.usage);
        q.usageInDrive = String(opts.quota.usage);
        if (opts.quota.limit !== null && opts.quota.limit !== undefined) {
          q.limit = String(opts.quota.limit);
        }
      }
      return route.fulfill(json({ storageQuota: q }));
    }

    /* -------- permisos -------- */
    const perm = path.match(/^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/(.+))?$/);
    if (perm) {
      if (opts.failPermission) {
        return route.fulfill(fail(opts.failPermission, 'sharing is disabled'));
      }
      if (!authed) return route.fulfill(fail(401, 'Login Required'));
      const id = perm[1];
      const on = method === 'POST';
      if (id === folderId) state.folderShared = on;
      else if (store.has(id)) store.get(id).shared = on;
      return method === 'DELETE'
        ? route.fulfill({ status: 204, headers: CORS, body: '' })
        : route.fulfill(json({ id: 'anyoneWithLink' }));
    }

    /* -------- un fichero concreto -------- */
    const one = path.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (one) {
      const id = one[1];
      const file = store.get(id);

      if (method === 'DELETE') {
        if (opts.failDelete) return route.fulfill(fail(opts.failDelete, 'no se pudo borrar'));
        if (!authed) return route.fulfill(fail(401, 'Login Required'));
        const doomed = [id];
        for (const entry of store.values()) if (entry.parent === id) doomed.push(entry.id);
        doomed.forEach((victim) => store.delete(victim));
        return route.fulfill({ status: 204, headers: CORS, body: '' });
      }

      if (url.searchParams.get('alt') === 'media') {
        if (!file) return route.fulfill(fail(404, 'File not found'));
        // Anónimo solo si el fichero es público y la API key es válida.
        if (!authed && !(keyed && file.shared)) {
          return route.fulfill(fail(404, 'File not found'));
        }
        return route.fulfill({ headers: CORS, contentType: 'image/svg+xml', body: file.content });
      }
      if (!file) return route.fulfill(fail(404, 'File not found'));
      if (!authed && !(keyed && file.shared)) return route.fulfill(fail(404, 'File not found'));
      return route.fulfill(json({
        id: file.id, name: file.name, mimeType: file.mimeType, shared: file.shared
      }));
    }

    /* -------- listar y crear -------- */
    if (path === '/drive/v3/files') {
      if (method === 'POST') {
        if (!authed) return route.fulfill(fail(401, 'Login Required'));
        const meta = request.postDataJSON() || {};
        // La raíz solo se crea una vez; las subcarpetas son entradas nuevas.
        if (meta.name === 'SVGshare' && !meta.parents) {
          state.folderCreated = true;
          if (!store.has(folderId)) {
            store.set(folderId, {
              id: folderId, name: 'SVGshare', parent: null, shared: false, mimeType: FOLDER_MIME
            });
          }
          return route.fulfill(json({ id: folderId }));
        }
        const id = newId('fold');
        store.set(id, {
          id,
          name: meta.name,
          parent: (meta.parents || [])[0] || null,
          shared: false,
          mimeType: meta.mimeType || FOLDER_MIME
        });
        byName.set(meta.name, id);
        return route.fulfill(json({ id }));
      }
      if (opts.failList) return route.fulfill(fail(opts.failList, 'no se pudo listar'));

      const q = url.searchParams.get('q') || '';
      // Búsqueda de la carpeta por nombre
      if (q.includes(FOLDER_MIME) && q.includes("name = 'SVGshare'")) {
        if (!authed) return route.fulfill(fail(401, 'Login Required'));
        if (opts.folderMissing) {
          store.delete(folderId);
          return route.fulfill(json({ files: [] }));
        }
        return route.fulfill(json({ files: [{ id: folderId, name: 'SVGshare' }] }));
      }
      // Contenido de una carpeta
      const parent = (q.match(/'([^']+)' in parents/) || [])[1];
      const folder = store.get(parent);
      const publicFolder = parent === folderId ? state.folderShared : Boolean(folder && folder.shared);
      if (!authed && !(keyed && publicFolder)) {
        return route.fulfill(fail(404, 'File not found'));
      }
      const files = [...store.values()]
        .filter((f) => f.parent === parent)
        .map((f) => ({
          id: f.id,
          name: f.name,
          size: f.mimeType === FOLDER_MIME ? undefined : String(f.content.length),
          modifiedTime: '2026-08-29T21:00:00.000Z',
          shared: f.shared,
          mimeType: f.mimeType
        }));
      return route.fulfill(json({ files }));
    }

    return route.fulfill(fail(404, 'endpoint no simulado: ' + method + ' ' + path));
  });

  return state;
}

module.exports = { mockGoogle, PLAIN, FOLDER_MIME };
