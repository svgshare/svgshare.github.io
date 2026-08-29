/*
 * Google Drive lane: the image is stored in the *uploader's* own account, so
 * the quota is theirs and the link shrinks to a file id. Requires only the
 * `drive.file` scope — per-file access to what this app creates — which is a
 * non-sensitive scope and therefore needs no OAuth verification.
 *
 * The access token lives in memory only. It is never written to localStorage,
 * sessionStorage or a cookie: a tab reload asks Google again (silently, once
 * the user has granted consent).
 */
(function (global) {
  'use strict';

  var CONFIG = global.SVGSHARE_CONFIG || {};
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var GIS_SRC = 'https://accounts.google.com/gsi/client';
  var DRIVE = 'https://www.googleapis.com/drive/v3';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
  var FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

  var token = null;        // { value, expiresAt }
  var tokenClient = null;
  var gisLoading = null;

  // Uploading needs a client id; reading a public file needs an API key.
  function canUpload() { return Boolean(CONFIG.googleClientId); }
  function canRead() { return Boolean(CONFIG.googleApiKey); }

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
    if (token && token.expiresAt > Date.now() + 60000) return Promise.resolve(token.value);
    if (!interactive) return Promise.resolve(null);
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
          token = {
            value: response.access_token,
            expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000
          };
          resolve(token.value);
        };
        tokenClient.error_callback = function (err) {
          reject(new Error((err && err.type) || 'auth-cancelled'));
        };
        // An empty prompt reuses the existing grant when there is one.
        tokenClient.requestAccessToken({ prompt: '' });
      });
    });
  }

  function forget() { token = null; }

  function apiError(response, body) {
    var detail = body && body.error && body.error.message;
    var err = new Error(detail || ('HTTP ' + response.status));
    err.status = response.status;
    return err;
  }

  function readJson(response) {
    return response.json().catch(function () { return null; });
  }

  // Single multipart/related request: metadata part + file part.
  function upload(name, svg) {
    return getToken(true).then(function (accessToken) {
      var boundary = 'svgshare-' + Math.random().toString(36).slice(2);
      var metadata = { name: name || 'imagen.svg', mimeType: 'image/svg+xml' };
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
    isFileId: isFileId,
    fileUrl: fileUrl,
    getToken: getToken,
    forget: forget,
    save: save,
    upload: upload,
    publish: publish,
    download: download
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
