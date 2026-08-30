/*
 * Vista de carpeta: los SVG que el usuario guarda en su propio Google Drive,
 * dentro de una carpeta «SVGshare» que esta app crea y es la única que ve.
 *
 * Dos modos, igual que la portada:
 *   /account/            mi carpeta, requiere iniciar sesión
 *   /account/?f=<id>     una carpeta compartida, anónima y de solo lectura
 *
 * El scope sigue siendo `drive.file`: acceso por fichero a lo que la propia app
 * crea. No puede ver el resto del Drive del usuario ni sabe de qué cuenta se
 * trata — no se piden `email` ni `profile` para no salir del scope no sensible.
 */
(function () {
  'use strict';

  var Drive = self.SVGShareDrive;
  var S = self.SVGShare;
  var MAX_INPUT_BYTES = 2 * 1024 * 1024;

  var rootId = null;    // la carpeta SVGshare
  var folderId = null;  // la que se está viendo (puede ser una subcarpeta)
  var trail = [];       // rastro de migas: [{ id, name }]
  var items = [];
  var sharing = null;   // { id, kind: 'file' | 'folder', name }

  /* ------------------------------------------------------------------ toast */

  var toastEl = document.getElementById('toast');
  var toastTimer;

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 2400);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) { /* sigue abajo */ }
    var helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(helper);
    helper.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(helper);
    return ok;
  }

  // Los errores de Google son para quien programa; estos son accionables.
  function driveMessage(err) {
    var code = err && (err.code || err.message);
    if (code === 'auth-cancelled' || code === 'popup_closed' || code === 'popup_failed_to_open') {
      return 'Se canceló el acceso a Google Drive';
    }
    if (code === 'gis-unreachable') return 'No se pudo contactar con Google';
    if (code === 'not-configured') return 'Este SVGshare no tiene configurado Google Drive';
    if (code === 'sharing-blocked') return 'Tu cuenta no permite compartir fuera de la organización';
    if (err && err.status === 401) return 'La sesión de Google caducó, inténtalo otra vez';
    if (err && err.status === 403) return 'Google rechazó la operación: ' + err.message;
    return 'Algo falló con Drive' + (err && err.message ? ': ' + err.message : '');
  }

  /* ------------------------------------------------------------------- url */

  function baseUrl() {
    return location.origin + location.pathname.replace(/account\/(index\.html)?$/, '');
  }

  function fileLink(id, name) {
    return baseUrl() + '?d=' + encodeURIComponent(id) +
      (name ? '&n=' + encodeURIComponent(name) : '');
  }

  function folderLink(id) {
    return baseUrl() + 'account/?f=' + encodeURIComponent(id);
  }

  // Navegación por carpetas propias: ?id= para que atrás y recargar funcionen.
  function ownLink(id) {
    return id && id !== rootId ? baseUrl() + 'account/?id=' + encodeURIComponent(id)
      : baseUrl() + 'account/';
  }

  function queryParams() {
    var params = {};
    location.search.replace(/^\?/, '').split('&').forEach(function (part) {
      var eq = part.indexOf('=');
      if (eq > 0) params[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
    });
    return params;
  }

  /* ------------------------------------------------------------------ vista */

  var grid = document.getElementById('grid');
  var emptyNote = document.getElementById('emptyNote');
  var folderBox = document.getElementById('folderBox');
  var signinBox = document.getElementById('signinBox');

  function show(el, on) { el.hidden = !on; }

  // Cada tarjeta pinta el SVG ya saneado, en un <img data:> igual que el visor:
  // ahí el navegador no ejecuta scripts ni deja salir peticiones de red.
  var FOLDER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';

  function card(item, readOnly) {
    var folder = Drive.isFolder(item);
    var li = document.createElement('li');
    li.className = 'tile' + (folder ? ' is-folder' : '');
    li.dataset.id = item.id;

    var figure = document.createElement('div');
    figure.className = 'tile-art' + (folder ? ' is-folder' : '');
    var img = null;
    if (folder) {
      figure.innerHTML = FOLDER_ICON;
    } else {
      figure.dataset.bg = 'checker';
      img = document.createElement('img');
      img.alt = item.name;
      img.loading = 'lazy';
      figure.appendChild(img);
    }

    var open = document.createElement('a');
    open.className = 'tile-open';
    open.href = folder
      ? (readPublic ? folderLink(item.id) : ownLink(item.id))
      : fileLink(item.id, item.name);
    open.appendChild(figure);

    // Entrar en una subcarpeta no recarga la página: se navega en el sitio.
    if (folder && !readPublic) {
      open.addEventListener('click', function (event) {
        event.preventDefault();
        enterFolder(item.id, item.name);
      });
    }

    var meta = document.createElement('div');
    meta.className = 'tile-meta';
    var name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = item.name;
    name.title = item.name;
    var size = document.createElement('span');
    size.className = 'tile-size';
    size.textContent = describe(item);
    meta.appendChild(name);
    meta.appendChild(size);

    li.appendChild(open);
    li.appendChild(meta);

    if (!readOnly) {
      var actions = document.createElement('div');
      actions.className = 'tile-actions';

      var share = document.createElement('button');
      share.type = 'button';
      share.className = 'linkish';
      share.textContent = item.shared ? 'Enlace' : 'Compartir';
      share.addEventListener('click', function () { openShare(item, 'file'); });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'linkish is-danger';
      del.textContent = 'Borrar';
      del.addEventListener('click', function () { removeItem(item); });

      actions.appendChild(share);
      actions.appendChild(del);
      li.appendChild(actions);
    }

    // La previsualización se pide aparte: la lista solo trae metadatos.
    if (img) paint(item, img);
    return li;
  }

  function describe(item) {
    return [
      Drive.isFolder(item) ? 'carpeta' : (item.size ? S.formatBytes(Number(item.size)) : null),
      item.shared ? 'compartido' : null
    ].filter(Boolean).join(' · ');
  }

  var readPublic = false;

  function paint(item, img) {
    var get = readPublic ? Drive.download(item.id) : Drive.fetchOwn(item.id);
    get.then(function (text) {
      img.src = S.dataUri(S.minify(S.sanitize(S.parseSvg(text))));
    }).catch(function () {
      img.closest('.tile-art').classList.add('is-broken');
    });
  }

  function render(readOnly) {
    grid.textContent = '';
    // Carpetas primero, como en cualquier gestor de archivos.
    items.slice().sort(function (a, b) {
      var fa = Drive.isFolder(a) ? 0 : 1;
      var fb = Drive.isFolder(b) ? 0 : 1;
      return fa - fb || a.name.localeCompare(b.name, 'es');
    }).forEach(function (item) { grid.appendChild(card(item, readOnly)); });
    show(emptyNote, items.length === 0);
    renderCrumbs();
  }

  // El rastro solo aparece cuando se ha bajado de la raíz.
  function renderCrumbs() {
    var box = document.getElementById('crumbs');
    box.textContent = '';
    if (readPublic || trail.length < 2) { box.hidden = true; return; }

    trail.forEach(function (step, i) {
      if (i) {
        var sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '/';
        box.appendChild(sep);
      }
      if (i === trail.length - 1) {
        var here = document.createElement('span');
        here.className = 'here';
        here.textContent = step.name;
        box.appendChild(here);
      } else {
        var link = document.createElement('a');
        link.href = ownLink(step.id);
        link.textContent = step.name;
        link.addEventListener('click', function (event) {
          event.preventDefault();
          goTo(i);
        });
        box.appendChild(link);
      }
    });
    box.hidden = false;
  }

  /* ------------------------------------------------------------------ cuota */

  function renderQuota(q) {
    var box = document.getElementById('quotaBox');
    if (!q || q.limit === null) {
      // Cuentas sin tope: la barra no diría nada.
      document.getElementById('quotaFigure').textContent = S.formatBytes(q ? q.usage : 0) + ' en uso';
      document.getElementById('quotaFill').style.width = '0%';
      document.getElementById('quotaNote').textContent = 'Esta cuenta no tiene límite de espacio.';
      show(box, true);
      return;
    }
    var pct = q.limit > 0 ? Math.min(100, (q.usage / q.limit) * 100) : 0;
    var level = pct < 75 ? 'ok' : pct < 90 ? 'warn' : 'bad';
    document.getElementById('quotaFigure').textContent =
      S.formatBytes(q.usage) + ' de ' + S.formatBytes(q.limit);
    var fill = document.getElementById('quotaFill');
    fill.style.width = pct.toFixed(1) + '%';
    fill.style.background = 'var(--' + level + ')';
    document.getElementById('quotaNote').textContent = pct >= 90
      ? 'Tu Drive está casi lleno: puede que las subidas empiecen a fallar.'
      : Math.round(pct) + '% del espacio de tu cuenta de Google.';
    show(box, true);
  }

  /* --------------------------------------------------------------- acciones */

  var shareDialog = document.getElementById('shareDialog');

  function openShare(item, kind) {
    sharing = { id: item.id, kind: kind, name: item.name };
    var isFolder = kind === 'folder';
    document.getElementById('shareTitle').textContent =
      isFolder ? 'Compartir la carpeta' : 'Compartir «' + item.name + '»';
    document.getElementById('shareNote').textContent = isFolder
      ? 'Cualquiera con este enlace podrá ver los SVG de la carpeta, pero no añadir ni borrar nada.'
      : 'Cualquiera con este enlace podrá ver y descargar esta imagen.';
    document.getElementById('shareLink').value = 'Preparando…';
    if (typeof shareDialog.showModal === 'function') shareDialog.showModal();
    else shareDialog.setAttribute('open', '');

    Drive.publish(item.id).then(function () {
      document.getElementById('shareLink').value =
        isFolder ? folderLink(item.id) : fileLink(item.id, item.name);
      item.shared = true;
      if (!isFolder) refreshTile(item);
    }).catch(function (err) {
      document.getElementById('shareLink').value = '';
      toast(driveMessage(err));
      shareDialog.close();
    });
  }

  function refreshTile(item) {
    var li = grid.querySelector('[data-id="' + item.id + '"]');
    if (!li) return;
    var btn = li.querySelector('.tile-actions .linkish');
    if (btn) btn.textContent = item.shared ? 'Enlace' : 'Compartir';
    var size = li.querySelector('.tile-size');
    if (size) size.textContent = describe(item);
  }

  // Borrar una carpeta en Drive se lleva por delante lo que hay dentro, así que
  // la pregunta tiene que decirlo.
  function removeItem(item) {
    var question = Drive.isFolder(item)
      ? '¿Borrar la carpeta «' + item.name + '» y todo su contenido? No se puede deshacer.'
      : '¿Borrar «' + item.name + '» de tu Drive? No se puede deshacer.';
    if (!confirm(question)) return;
    Drive.remove(item.id).then(function () {
      items = items.filter(function (x) { return x.id !== item.id; });
      render(false);
      toast('Borrado');
      Drive.quota().then(renderQuota).catch(function () {});
    }).catch(function (err) { toast(driveMessage(err)); });
  }

  function uploadFiles(files) {
    var list = Array.prototype.slice.call(files).filter(function (file) {
      var isSvg = /image\/svg\+xml/.test(file.type) || /\.svgz?$/i.test(file.name);
      if (!isSvg) toast('«' + file.name + '» no es un SVG');
      else if (file.size > MAX_INPUT_BYTES) toast('«' + file.name + '» pasa de 2 MB');
      else return true;
      return false;
    });
    if (!list.length) return;

    toast(list.length === 1 ? 'Subiendo…' : 'Subiendo ' + list.length + ' archivos…');
    // En serie: son subidas del usuario, no hay prisa, y así un fallo no deja
    // media docena de peticiones colgando.
    list.reduce(function (chain, file) {
      return chain.then(function () {
        return file.text().then(function (text) {
          // Se sanea antes de subir: lo que se guarda ya está limpio.
          var clean = S.minify(S.sanitize(S.parseSvg(text)));
          return Drive.upload(file.name, clean, folderId);
        });
      });
    }, Promise.resolve()).then(function () {
      toast('Listo');
      return reload();
    }).catch(function (err) {
      toast(driveMessage(err));
      return reload();
    });
  }

  function reload() {
    return Drive.listFolder(folderId).then(function (files) {
      items = files;
      render(false);
      return Drive.quota().then(renderQuota).catch(function () {});
    });
  }

  /* ---------------------------------------------------------- navegación */

  function enterFolder(id, name) {
    folderId = id;
    trail.push({ id: id, name: name });
    history.pushState({ id: id }, '', ownLink(id));
    items = [];
    render(false);
    reload().catch(function (err) { toast(driveMessage(err)); });
  }

  // Volver a un punto del rastro: se recorta y se recarga.
  function goTo(index) {
    trail = trail.slice(0, index + 1);
    folderId = trail[trail.length - 1].id;
    history.pushState({ id: folderId }, '', ownLink(folderId));
    items = [];
    render(false);
    reload().catch(function (err) { toast(driveMessage(err)); });
  }

  // El botón «atrás» del navegador tiene que funcionar dentro de la carpeta.
  window.addEventListener('popstate', function () {
    if (readPublic || !rootId) return;
    var target = queryParams().id || rootId;
    var known = trail.map(function (step) { return step.id; }).indexOf(target);
    if (known !== -1) {
      trail = trail.slice(0, known + 1);
      folderId = target;
      items = [];
      render(false);
      reload().catch(function () {});
    } else {
      openFolder(target);
    }
  });

  // Abrir una carpeta por su id, sin rastro previo (enlace directo o «atrás»
  // a un punto que ya no está en el rastro).
  function openFolder(id) {
    folderId = id;
    items = [];
    if (id === rootId) {
      trail = [{ id: rootId, name: Drive.folderName }];
      render(false);
      return reload().catch(function (err) { toast(driveMessage(err)); });
    }
    return Drive.meta(id).then(function (info) {
      trail = [{ id: rootId, name: Drive.folderName }, { id: id, name: info.name }];
      render(false);
      return reload();
    }).catch(function (err) {
      toast(driveMessage(err));
      folderId = rootId;
      trail = [{ id: rootId, name: Drive.folderName }];
      return reload().catch(function () {});
    });
  }

  function newFolder() {
    var name = prompt('Nombre de la nueva carpeta');
    if (name === null) return;
    name = name.trim();
    if (!name) return toast('Hace falta un nombre');

    Drive.createFolder(name, folderId).then(function () {
      toast('Carpeta creada');
      return reload();
    }).catch(function (err) { toast(driveMessage(err)); });
  }

  /* ------------------------------------------------------------- arranque */

  function startOwn() {
    show(signinBox, false);
    show(folderBox, true);

    Drive.ensureFolder().then(function (id) {
      rootId = id;
      var wanted = queryParams().id;
      return openFolder(Drive.isFileId(wanted) ? wanted : id);
    }).catch(function (err) {
      show(folderBox, false);
      show(signinBox, true);
      var error = document.getElementById('signinError');
      error.textContent = driveMessage(err);
      error.hidden = false;
    });
  }

  function startSignin() {
    show(signinBox, true);
    document.getElementById('btnSignin').addEventListener('click', function () {
      var btn = document.getElementById('btnSignin');
      btn.disabled = true;
      Drive.getToken(true).then(function () {
        startOwn();
      }).catch(function (err) {
        var error = document.getElementById('signinError');
        error.textContent = driveMessage(err);
        error.hidden = false;
      }).finally(function () { btn.disabled = false; });
    });
  }

  // Carpeta ajena: sin sesión, solo lectura, con API key.
  function startShared(id) {
    readPublic = true;
    document.getElementById('folderTitle').textContent = 'Carpeta compartida';
    document.getElementById('folderSub').textContent = 'Una selección de SVG compartida con un enlace.';
    document.getElementById('uploadCard').hidden = true;
    show(folderBox, true);

    Drive.listPublic(id).then(function (files) {
      items = files;
      render(true);
    }).catch(function (err) {
      emptyNote.textContent = err && err.message === 'not-configured'
        ? 'Este SVGshare no tiene configurada la lectura de Google Drive.'
        : 'No se pudo abrir la carpeta. Puede que ya no exista o que haya dejado de ser pública.';
      show(emptyNote, true);
    });
  }

  /* ------------------------------------------------------------- conexiones */

  document.getElementById('file').addEventListener('change', function (event) {
    uploadFiles(event.target.files);
    event.target.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (type) {
    window.addEventListener(type, function (event) {
      event.preventDefault();
      var drop = document.getElementById('drop');
      if (drop) drop.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    window.addEventListener(type, function (event) {
      event.preventDefault();
      var drop = document.getElementById('drop');
      if (drop) drop.classList.remove('is-over');
    });
  });
  window.addEventListener('drop', function (event) {
    var files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length && folderId) uploadFiles(files);
  });

  document.getElementById('btnRefresh').addEventListener('click', function () {
    if (folderId) reload().catch(function (err) { toast(driveMessage(err)); });
  });

  document.getElementById('btnNewFolder').addEventListener('click', newFolder);

  document.getElementById('btnShareFolder').addEventListener('click', function () {
    if (!folderId) return;
    var here = trail.length ? trail[trail.length - 1].name : Drive.folderName;
    openShare({ id: folderId, name: here }, 'folder');
  });

  shareDialog.addEventListener('click', function (event) {
    if (event.target.closest('[data-close-dialog]')) shareDialog.close();
  });

  document.getElementById('btnCopyShare').addEventListener('click', async function () {
    var value = document.getElementById('shareLink').value;
    toast(await copyText(value) ? '¡Enlace copiado!' : 'No se pudo copiar');
  });

  document.getElementById('btnUnshare').addEventListener('click', function () {
    if (!sharing) return;
    Drive.unpublish(sharing.id).then(function () {
      var item = items.filter(function (x) { return x.id === sharing.id; })[0];
      if (item) { item.shared = false; refreshTile(item); }
      shareDialog.close();
      toast('Ya no se comparte');
    }).catch(function (err) { toast(driveMessage(err)); });
  });

  /* ------------------------------------------------------------- bootstrap */

  var params = queryParams();

  if (params.f !== undefined) {
    if (!Drive.isFileId(params.f)) {
      show(document.getElementById('offBox'), true);
    } else {
      startShared(params.f);
    }
  } else if (!Drive.canShorten()) {
    show(document.getElementById('offBox'), true);
  } else {
    // Con consentimiento previo Google devuelve el token sin abrir ventana, así
    // que la sesión sobrevive a una recarga sin haber guardado nada en disco.
    Drive.getToken(false).then(function (token) {
      if (token) startOwn();
      else startSignin();
    }).catch(function () { startSignin(); });
  }
})();
