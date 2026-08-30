/*
 * Google Drive lane: the image is stored in the *uploader's* own account, so
 * the quota is theirs and the link shrinks to a file id. Requires only the
 * `drive.file` scope — per-file access to what this app creates — which is a
 * non-sensitive scope and therefore needs no OAuth verification.
 *
 * The access token lives in memory, mirrored into sessionStorage so that
 * reloading the tab does not ask for a second click. Asking Google again on
 * load is not an option: its token client answers `prompt: 'none'` with a
 * popup window, and with no click behind it the browser blocks it and warns.
 * The copy is scoped to the tab and to this client id, and is dropped as soon
 * as it expires or Drive answers 401. Closing the tab throws it away.
 */
(function (global) {
  'use strict';

  var CONFIG = global.SVGSHARE_CONFIG || {};
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var GIS_SRC = 'https://accounts.google.com/gsi/client';
  var DRIVE = 'https://www.googleapis.com/drive/v3';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
  var FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
  var FOLDER_NAME = 'SVGshare';
  var FOLDER_MIME = 'application/vnd.google-apps.folder';
  // El id de permiso que Drive asigna a «cualquiera con el enlace».
  var ANYONE = 'anyoneWithLink';
  var FIELDS = 'id,name,size,modifiedTime,shared,mimeType';

  var TOKEN_KEY = 'svgshare.drive.token';

  var tokenClient = null;
  var gisLoading = null;

  /* -------------------------------------------------------------- el token */

  // sessionStorage puede no estar (ventana privada, almacenamiento bloqueado):
  // sin él todo sigue igual, solo que recargar vuelve a pedir el botón.
  function box() {
    try { return global.sessionStorage || null; } catch (err) { return null; }
  }

  function readStored() {
    var store = box();
    if (!store) return null;
    var saved = null;
    try { saved = JSON.parse(store.getItem(TOKEN_KEY)); } catch (err) { saved = null; }
    if (!saved || typeof saved.value !== 'string' || typeof saved.expiresAt !== 'number') {
      return null;
    }
    // Otro client id es otro despliegue: su token no sirve aquí.
    if (saved.clientId !== (CONFIG.googleClientId || '')) return null;
    return { value: saved.value, expiresAt: saved.expiresAt };
  }

  function writeStored(entry) {
    var store = box();
    if (!store) return;
    try {
      if (!entry) store.removeItem(TOKEN_KEY);
      else {
        store.setItem(TOKEN_KEY, JSON.stringify({
          value: entry.value,
          expiresAt: entry.expiresAt,
          clientId: CONFIG.googleClientId || ''
        }));
      }
    } catch (err) { /* sin sitio o sin permiso: da igual */ }
  }

  var token = readStored();  // { value, expiresAt }

  function keepToken(value, expiresIn) {
    token = { value: value, expiresAt: Date.now() + (Number(expiresIn) || 3600) * 1000 };
    writeStored(token);
    return token.value;
  }

  // Un minuto de margen: no vale un token que caduca a mitad de la petición.
  function liveToken() {
    if (!token) return null;
    if (token.expiresAt > Date.now() + 60000) return token.value;
    forget();
    return null;
  }

  // Para que la vista de carpeta sepa, sin preguntar a Google ni parpadear,
  // si la recarga trae sesión o hay que enseñar el botón.
  function hasSession() { return Boolean(liveToken()); }

  // Uploading needs a client id; reading a public file needs an API key.
  function canUpload() { return Boolean(CONFIG.googleClientId); }
  function canRead() { return Boolean(CONFIG.googleApiKey); }

  // Offering the short link only makes sense when this deployment can also
  // serve it back: a link the viewer cannot open is worse than no link at all.
  function canShorten() { return canUpload() && canRead(); }

  function isFileId(id) { return typeof id === 'string' && FILE_ID.test(id); }

  function fileUrl(id) { return 'https://drive.google.com/file/d/' + id + '/view'; }

  function loadGis() {
    if (global.google && global.google.accounts && global.google.accounts.oauth2) {
      return Promise.resolve();
    }
    if (!gisLoading) {
      gisLoading = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = GIS_SRC;
        script.async = true;
        script.onload = resolve;
        script.onerror = function () {
          gisLoading = null;
          reject(new Error('gis-unreachable'));
        };
        document.head.appendChild(script);
      });
    }
    return gisLoading;
  }

  // `interactive` false reuses a live token and never opens a popup, so the UI
  // can tell "already connected" from "needs a click" without bothering anyone.
  function getToken(interactive) {
    var live = liveToken();
    if (live) return Promise.resolve(live);
    if (!interactive) return Promise.resolve(null);
    return requestToken();
  }

  // Siempre detrás de un clic: el token client abre una ventana emergente, y
  // sin gesto del usuario el navegador la bloquea y saca su aviso.
  function requestToken() {
    if (!canUpload()) return Promise.reject(new Error('not-configured'));

    return loadGis().then(function () {
      if (!tokenClient) {
        tokenClient = global.google.accounts.oauth2.initTokenClient({
          client_id: CONFIG.googleClientId,
          scope: SCOPE,
          callback: function () {}
        });
      }
      return new Promise(function (resolve, reject) {
        tokenClient.callback = function (response) {
          if (!response || response.error) {
            return reject(new Error((response && response.error) || 'auth-failed'));
          }
          resolve(keepToken(response.access_token, response.expires_in));
        };
        tokenClient.error_callback = function (err) {
          reject(new Error((err && err.type) || 'auth-cancelled'));
        };
        // An empty prompt reuses the existing grant when there is one.
        tokenClient.requestAccessToken({ prompt: '' });
      });
    });
  }

  function forget() {
    token = null;
    writeStored(null);
  }

  function apiError(response, body) {
    // Un 401 es un token muerto (caducado o revocado). Si se quedara guardado,
    // recargar y hasta volver a pulsar el botón repetirían el mismo fallo.
    if (response.status === 401) forget();
    var detail = body && body.error && body.error.message;
    var err = new Error(detail || ('HTTP ' + response.status));
    err.status = response.status;
    return err;
  }

  function readJson(response) {
    return response.json().catch(function () { return null; });
  }

  // Single multipart/related request: metadata part + file part.
  function upload(name, svg, parentId) {
    return getToken(true).then(function (accessToken) {
      var boundary = 'svgshare-' + Math.random().toString(36).slice(2);
      var metadata = { name: name || 'imagen.svg', mimeType: 'image/svg+xml' };
      if (isFileId(parentId)) metadata.parents = [parentId];
      var body =
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Type: image/svg+xml; charset=UTF-8\r\n\r\n' +
        svg + '\r\n' +
        '--' + boundary + '--';

      return fetch(UPLOAD, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'multipart/related; boundary=' + boundary
        },
        body: body
      }).then(function (response) {
        return readJson(response).then(function (json) {
          if (!response.ok) throw apiError(response, json);
          if (!json || !isFileId(json.id)) throw new Error('bad-response');
          return json.id;
        });
      });
    });
  }

  // "Anyone with the link can read" — the file id becomes the capability.
  function publish(fileId) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    return getToken(true).then(function (accessToken) {
      return fetch(DRIVE + '/files/' + fileId + '/permissions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ role: 'reader', type: 'anyone' })
      }).then(function (response) {
        return readJson(response).then(function (json) {
          if (!response.ok) {
            var err = apiError(response, json);
            // Workspace accounts often forbid sharing outside the organisation.
            if (response.status === 403) err.code = 'sharing-blocked';
            throw err;
          }
          return true;
        });
      });
    });
  }

  function save(name, svg) {
    return upload(name, svg).then(function (id) {
      return publish(id).then(function () { return id; });
    });
  }

  /* ------------------------------------------------------------- la carpeta */

  // Una petición autenticada cualquiera. El scope drive.file limita todo esto a
  // lo que la propia app creó, así que no hace falta filtrar por nada más.
  function api(path, options) {
    return getToken(true).then(function (accessToken) {
      var opts = options || {};
      var headers = { Authorization: 'Bearer ' + accessToken };
      if (opts.json) headers['Content-Type'] = 'application/json';
      return fetch(DRIVE + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.json ? JSON.stringify(opts.json) : undefined
      }).then(function (response) {
        if (response.status === 204) return null;
        return readJson(response).then(function (json) {
          if (!response.ok) throw apiError(response, json);
          return json;
        });
      });
    });
  }

  function query(q, fields) {
    return '?q=' + encodeURIComponent(q) +
      '&fields=' + encodeURIComponent('files(' + (fields || FIELDS) + ')') +
      '&orderBy=folder,modifiedTime desc&pageSize=200';
  }

  // La carpeta «SVGshare» del Drive del usuario. Con el scope drive.file la
  // búsqueda solo ve carpetas que esta app creó, así que no puede colarse otra
  // carpeta del usuario que se llame igual.
  function ensureFolder() {
    var q = "name = '" + FOLDER_NAME + "' and mimeType = '" + FOLDER_MIME +
      "' and trashed = false";
    return api('/files' + query(q, 'id,name')).then(function (json) {
      var found = json && json.files && json.files[0];
      if (found && isFileId(found.id)) return found.id;
      return api('/files?fields=id', {
        method: 'POST',
        json: { name: FOLDER_NAME, mimeType: FOLDER_MIME }
      }).then(function (created) {
        if (!created || !isFileId(created.id)) throw new Error('bad-response');
        return created.id;
      });
    });
  }

  // Una subcarpeta dentro de la que se esté viendo. También la crea esta app,
  // así que el scope drive.file la alcanza igual que a la raíz.
  function createFolder(name, parentId) {
    var metadata = { name: name || 'Nueva carpeta', mimeType: FOLDER_MIME };
    if (isFileId(parentId)) metadata.parents = [parentId];
    return api('/files?fields=id', { method: 'POST', json: metadata })
      .then(function (created) {
        if (!created || !isFileId(created.id)) throw new Error('bad-response');
        return created.id;
      });
  }

  // Nombre de una carpeta a la que se entra por enlace directo, para el rastro
  // de migas: navegando se conoce, pero al abrir /account/?id=… no.
  function meta(fileId) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    return api('/files/' + fileId + '?fields=id,name,mimeType,shared');
  }

  function metaPublic(fileId) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    if (!canRead()) return Promise.reject(new Error('not-configured'));
    return fetch(DRIVE + '/files/' + fileId +
      '?fields=id,name,mimeType,shared&key=' + encodeURIComponent(CONFIG.googleApiKey))
      .then(function (response) {
        return readJson(response).then(function (json) {
          if (!response.ok) throw apiError(response, json);
          return json;
        });
      });
  }

  function isFolder(item) { return Boolean(item) && item.mimeType === FOLDER_MIME; }

  function listFolder(folderId) {
    if (!isFileId(folderId)) return Promise.reject(new Error('bad-id'));
    var q = "'" + folderId + "' in parents and trashed = false";
    return api('/files' + query(q)).then(function (json) {
      return (json && json.files) || [];
    });
  }

  // Lectura del contenido con sesión: no depende de que el fichero sea público.
  function fetchOwn(fileId) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    return getToken(true).then(function (accessToken) {
      return fetch(DRIVE + '/files/' + fileId + '?alt=media', {
        headers: { Authorization: 'Bearer ' + accessToken }
      }).then(function (response) {
        if (!response.ok) {
          return readJson(response).then(function (json) { throw apiError(response, json); });
        }
        return response.text();
      });
    });
  }

  function remove(fileId) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    return api('/files/' + fileId, { method: 'DELETE' }).then(function () { return true; });
  }

  function unpublish(fileId) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    return api('/files/' + fileId + '/permissions/' + ANYONE, { method: 'DELETE' })
      .then(function () { return false; });
  }

  // Espacio de la cuenta. `limit` no viene en cuentas sin tope.
  function quota() {
    return getToken(true).then(function (accessToken) {
      return fetch(DRIVE + '/about?fields=storageQuota', {
        headers: { Authorization: 'Bearer ' + accessToken }
      }).then(function (response) {
        return readJson(response).then(function (json) {
          if (!response.ok) throw apiError(response, json);
          var q = (json && json.storageQuota) || {};
          return {
            usage: Number(q.usage) || 0,
            usageInDrive: Number(q.usageInDrive) || 0,
            limit: q.limit === undefined ? null : Number(q.limit)
          };
        });
      });
    });
  }

  // Listado anónimo de una carpeta pública, con API key y sin sesión. Descansa
  // en la misma suposición que la lectura anónima de un fichero: que la Drive
  // API responda con cabeceras CORS. Sin confirmar contra Google.
  function listPublic(folderId) {
    if (!isFileId(folderId)) return Promise.reject(new Error('bad-id'));
    if (!canRead()) return Promise.reject(new Error('not-configured'));
    var q = "'" + folderId + "' in parents and trashed = false";
    return fetch(DRIVE + '/files' + query(q) + '&key=' + encodeURIComponent(CONFIG.googleApiKey))
      .then(function (response) {
        return readJson(response).then(function (json) {
          if (!response.ok) throw apiError(response, json);
          return (json && json.files) || [];
        });
      });
  }

  // Read side: no session, no token. Works because the file is already public
  // and the Drive API answers cross-origin requests carrying an API key.
  function download(fileId) {
    if (!isFileId(fileId)) return Promise.reject(new Error('bad-id'));
    if (!canRead()) return Promise.reject(new Error('not-configured'));
    var url = DRIVE + '/files/' + fileId + '?alt=media&key=' + encodeURIComponent(CONFIG.googleApiKey);
    return fetch(url).then(function (response) {
      if (!response.ok) {
        return readJson(response).then(function (json) { throw apiError(response, json); });
      }
      return response.text();
    });
  }

  global.SVGShareDrive = {
    canUpload: canUpload,
    canRead: canRead,
    canShorten: canShorten,
    isFileId: isFileId,
    fileUrl: fileUrl,
    getToken: getToken,
    hasSession: hasSession,
    forget: forget,
    save: save,
    upload: upload,
    publish: publish,
    unpublish: unpublish,
    download: download,
    ensureFolder: ensureFolder,
    createFolder: createFolder,
    isFolder: isFolder,
    meta: meta,
    metaPublic: metaPublic,
    listFolder: listFolder,
    listPublic: listPublic,
    fetchOwn: fetchOwn,
    remove: remove,
    quota: quota,
    folderName: FOLDER_NAME
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
