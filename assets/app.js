/*
 * SVGshare — the whole image travels inside the URL fragment.
 * Nothing is ever uploaded: encoding and decoding happen in the browser.
 */
(function () {
  'use strict';

  var Drive = self.SVGShareDrive || {
    canUpload: function () { return false; },
    canRead: function () { return false; },
    canShorten: function () { return false; },
    isFileId: function () { return false; }
  };

  var MAX_INPUT_BYTES = 2 * 1024 * 1024; // sanity limit for the source file
  var URL_OK = 8000;                     // shares well anywhere
  var URL_WARN = 32000;                  // still fine in modern browsers

  /* ---------------------------------------------------------------- bytes */

  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

  function toBase64(bytes) {
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  function fromBase64(text) {
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function toBase64Url(bytes) {
    return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(text) {
    var normalized = text.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4) normalized += '=';
    return fromBase64(normalized);
  }

  async function deflate(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      return null;
    }
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream === 'function') {
      try {
        var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (err) {
        /* fall through to the JS decoder */
      }
    }
    if (typeof self.inflateRaw !== 'function') throw new Error('no-inflate');
    return self.inflateRaw(bytes);
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function formatCount(n) {
    return n.toLocaleString('es-ES');
  }

  /* ------------------------------------------------------------------ svg */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';
  var DROP_NS = [
    'http://www.inkscape.org/namespaces/inkscape',
    'http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd',
    'http://ns.adobe.com/AdobeIllustrator/10.0/'
  ];
  var KEEP_SPACE = { text: 1, tspan: 1, textpath: 1, title: 1, desc: 1, style: 1 };

  function parseSvg(text) {
    var doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    var root = doc.documentElement;
    if (!root || root.getElementsByTagName('parsererror').length ||
        root.nodeName.toLowerCase() === 'parsererror') {
      throw new Error('El archivo no es un SVG válido.');
    }
    if (root.nodeName.toLowerCase() !== 'svg') {
      throw new Error('El archivo no contiene un elemento <svg>.');
    }
    if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', SVG_NS);
    return doc;
  }

  // Drops scripts, event handlers and references that could reach the network.
  function sanitize(doc) {
    var root = doc.documentElement;
    var i;

    var dangerous = [];
    var tags = ['script', 'foreignObject'];
    for (i = 0; i < tags.length; i++) {
      var found = root.getElementsByTagName(tags[i]);
      for (var j = 0; j < found.length; j++) dangerous.push(found[j]);
    }
    if (root.nodeName.toLowerCase() === 'script') throw new Error('El archivo no es un SVG válido.');
    dangerous.forEach(function (node) {
      if (node.parentNode) node.parentNode.removeChild(node);
    });

    var all = [root].concat(Array.prototype.slice.call(root.getElementsByTagName('*')));
    all.forEach(function (el) {
      var attrs = Array.prototype.slice.call(el.attributes || []);
      attrs.forEach(function (attr) {
        var name = attr.localName ? attr.localName.toLowerCase() : attr.name.toLowerCase();
        var value = (attr.value || '').trim();

        if (name.indexOf('on') === 0) {
          el.removeAttributeNode(attr);
          return;
        }
        if (name === 'href' || name === 'src' || name === 'xlink:href') {
          if (!/^(#|data:image\/)/i.test(value)) el.removeAttributeNode(attr);
          return;
        }
        if (/^\s*javascript:/i.test(value)) el.removeAttributeNode(attr);
      });
    });

    return doc;
  }

  // Removes editor cruft and layout whitespace so the link stays short.
  function minify(doc) {
    var root = doc.documentElement;

    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_PROCESSING_INSTRUCTION);
    var junk = [];
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        var parent = node.parentNode;
        var parentName = parent && parent.nodeName ? parent.nodeName.toLowerCase() : '';
        if (!KEEP_SPACE[parentName] && !/\S/.test(node.nodeValue)) junk.push(node);
      } else {
        junk.push(node);
      }
    }
    junk.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });

    var elements = [root].concat(Array.prototype.slice.call(root.getElementsByTagName('*')));
    elements.forEach(function (el) {
      var name = el.nodeName.toLowerCase();
      if (el !== root && (name === 'metadata' || DROP_NS.indexOf(el.namespaceURI) !== -1)) {
        if (el.parentNode) el.parentNode.removeChild(el);
        return;
      }
      Array.prototype.slice.call(el.attributes || []).forEach(function (attr) {
        if (DROP_NS.indexOf(attr.namespaceURI) !== -1) {
          el.removeAttributeNode(attr);
          return;
        }
        // xmlns:inkscape and friends live in the xmlns namespace
        if (attr.name.indexOf('xmlns:') === 0 && DROP_NS.indexOf(attr.value) !== -1) {
          el.removeAttributeNode(attr);
        }
      });
    });

    var out = new XMLSerializer().serializeToString(root);
    return out.replace(/>\s*\n\s*</g, '><').trim();
  }

  function serialize(doc) {
    return new XMLSerializer().serializeToString(doc.documentElement).trim();
  }

  function dimensionsOf(text) {
    try {
      var root = parseSvg(text).documentElement;
      var w = root.getAttribute('width');
      var h = root.getAttribute('height');
      if (w && h) return w.trim() + ' × ' + h.trim();
      var box = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/);
      if (box.length === 4) return Math.round(box[2]) + ' × ' + Math.round(box[3]);
    } catch (err) { /* ignore */ }
    return null;
  }

  function dataUri(text) {
    return 'data:image/svg+xml;base64,' + toBase64(encoder.encode(text));
  }

  /* -------------------------------------------------------------- payload */

  async function encodePayload(text) {
    var raw = encoder.encode(text);
    var packed = await deflate(raw);
    if (packed && packed.length < raw.length) return 'z=' + toBase64Url(packed);
    return 'b=' + toBase64Url(raw);
  }

  // The fragment holds the image plus, optionally, the original file name:
  //   #z=<deflate-raw+base64url>&n=<nombre.svg>
  function parseHash(hash) {
    var params = {};
    (hash || '').replace(/^#\/?/, '').split('&').forEach(function (part) {
      var eq = part.indexOf('=');
      if (eq > 0) params[part.slice(0, eq)] = part.slice(eq + 1);
    });
    return params;
  }

  async function decodePayload(params) {
    var kind = params.z !== undefined ? 'z' : params.b !== undefined ? 'b' : null;
    if (!kind || !/^[A-Za-z0-9\-_=]+$/.test(params[kind])) return null;
    var bytes = fromBase64Url(params[kind]);
    if (kind === 'z') bytes = await inflate(bytes);
    return decoder.decode(bytes);
  }

  // The name arrives from the URL, so keep it to a plain, single-segment file name.
  function cleanName(raw) {
    if (!raw) return '';
    var name;
    try { name = decodeURIComponent(raw); } catch (err) { return ''; }
    name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return name.slice(0, 80);
  }

  function downloadName(name) {
    if (!name) return 'svgshare.svg';
    return /\.svgz?$/i.test(name) ? name : name + '.svg';
  }

  function baseUrl() {
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }

  function shareUrl(payload, name) {
    return baseUrl() + '#' + payload + (name ? '&n=' + encodeURIComponent(name) : '');
  }

  // The Drive lane puts the file id in the *query string* on purpose. The id is
  // already the capability — whoever holds the link can read the file — so it
  // gains nothing by hiding in the fragment, and being server-visible leaves the
  // door open to an edge worker rendering per-file preview cards later.
  function driveUrl(fileId, name) {
    return baseUrl() + '?d=' + encodeURIComponent(fileId) +
      (name ? '&n=' + encodeURIComponent(name) : '');
  }

  function queryParams() {
    var params = {};
    location.search.replace(/^\?/, '').split('&').forEach(function (part) {
      var eq = part.indexOf('=');
      if (eq > 0) params[part.slice(0, eq)] = part.slice(eq + 1);
    });
    return params;
  }

  // Google's errors are developer-facing; these are the ones a person can act on.
  function driveMessage(err) {
    var code = err && (err.code || err.message);
    if (code === 'auth-cancelled' || code === 'popup_closed' || code === 'popup_failed_to_open') {
      return 'Se canceló el acceso a Google Drive';
    }
    if (code === 'gis-unreachable') return 'No se pudo contactar con Google';
    if (code === 'not-configured') return 'Este SVGshare no tiene configurado Google Drive';
    if (code === 'sharing-blocked') {
      return 'Tu cuenta no permite compartir fuera de la organización';
    }
    if (err && err.status === 401) return 'La sesión de Google caducó, inténtalo otra vez';
    if (err && err.status === 403) return 'Google rechazó la operación: ' + err.message;
    return 'No se pudo guardar en Drive' + (err && err.message ? ': ' + err.message : '');
  }

  /* ----------------------------------------------------------------- toast */

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
    } catch (err) { /* fall through */ }

    var helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(helper);
    helper.select();
    helper.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(helper);
    return ok;
  }

  function bindBackgrounds(container, target) {
    container.addEventListener('click', function (event) {
      var chip = event.target.closest('[data-bg]');
      if (!chip) return;
      target.dataset.bg = chip.dataset.bg;
      Array.prototype.forEach.call(container.querySelectorAll('[data-bg]'), function (el) {
        el.classList.toggle('is-active', el === chip);
      });
    });
  }

  /* ----------------------------------------------------------------- viewer */

  // Either lane ends up here with the SVG text; the Drive one just fetches it
  // first. Everything downstream (sanitising, rendering, download) is shared.
  function resolveSource(params) {
    if (params.d !== undefined) {
      var id = decodeURIComponent(params.d);
      if (!Drive.isFileId(id)) return Promise.reject(new Error('bad-id'));
      if (!Drive.canRead()) return Promise.reject(new Error('not-configured'));
      return Drive.download(id);
    }
    return decodePayload(params);
  }

  function startViewer(params) {
    var viewer = document.getElementById('viewer');
    var stage = document.getElementById('stage');
    var img = document.getElementById('stageImg');
    var errorEl = document.getElementById('stageError');
    var dialog = document.getElementById('sourceDialog');
    var codeEl = document.getElementById('sourceCode');
    var source = '';
    var name = cleanName(params.n);

    viewer.hidden = false;
    document.title = 'SVGshare - ' + (name || 'SVG compartido');

    function fail(message) {
      img.hidden = true;
      errorEl.hidden = false;
      errorEl.textContent = message;
      // Sin imagen no hay lienzo que mostrar: se devuelve el fondo al tema
      // para que el mensaje se lea, y sobra el selector de fondo.
      stage.removeAttribute('data-bg');
      document.querySelector('.bg-switch').hidden = true;
      document.getElementById('btnDownload').disabled = true;
      document.getElementById('btnSource').disabled = true;
    }

    resolveSource(params).then(function (text) {
      if (text === null) return fail('El enlace está dañado o incompleto.');
      try {
        // Text fetched from Drive is as untrusted as text from the URL: it goes
        // through exactly the same sanitiser before being rendered.
        source = minify(sanitize(parseSvg(text)));
      } catch (err) {
        return fail('El enlace está dañado o la imagen no es un SVG válido.');
      }
      img.src = dataUri(source);
    }).catch(function (err) {
      var code = err && err.message;
      if (params.d !== undefined) {
        var id = decodeURIComponent(params.d);
        fail(code === 'not-configured'
          ? 'Este SVGshare no tiene configurada la lectura de Google Drive.'
          : 'No se pudo cargar la imagen desde Google Drive. Puede que ya no exista o que haya dejado de ser pública.');
        if (Drive.isFileId(id)) offerDriveLink(id);
        return;
      }
      fail(code === 'no-inflate'
        ? 'Tu navegador no puede descomprimir este enlace. Prueba con uno más reciente.'
        : 'El enlace está dañado o incompleto.');
    });

    // When the fetch fails the file may still be reachable from Drive itself,
    // so hand the reader that door instead of a dead end.
    function offerDriveLink(id) {
      var link = document.createElement('a');
      link.href = Drive.fileUrl(id);
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'stage-link';
      link.textContent = 'Abrir en Google Drive';
      errorEl.insertAdjacentElement('afterend', link);
    }

    bindBackgrounds(document.querySelector('.bg-switch'), stage);

    document.getElementById('btnDownload').addEventListener('click', function () {
      var blob = new Blob([source], { type: 'image/svg+xml' });
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadName(name);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });

    document.getElementById('btnSource').addEventListener('click', function () {
      codeEl.textContent = source;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });

    dialog.addEventListener('click', function (event) {
      if (event.target.closest('[data-close-dialog]')) dialog.close();
    });

    document.getElementById('btnCopySource').addEventListener('click', async function () {
      toast(await copyText(source) ? '¡Código copiado!' : 'No se pudo copiar');
    });

    window.addEventListener('hashchange', function () { location.reload(); });
  }

  /* ---------------------------------------------------------------- creator */

  function startCreator() {
    var creator = document.getElementById('creator');
    var fileInput = document.getElementById('file');
    var drop = document.getElementById('drop');
    var dropCard = document.getElementById('dropCard');
    var result = document.getElementById('result');
    var previewImg = document.getElementById('previewImg');
    var fileNameEl = document.getElementById('fileName');
    var statsEl = document.getElementById('stats');
    var meterFill = document.getElementById('meterFill');
    var meterLabel = document.getElementById('meterLabel');
    var linkEl = document.getElementById('link');
    var btnCopy = document.getElementById('btnCopy');
    var btnShare = document.getElementById('btnShare');
    var btnOpen = document.getElementById('btnOpen');
    var btnReset = document.getElementById('btnReset');
    var optMinify = document.getElementById('optMinify');
    var driveBox = document.getElementById('driveBox');
    var driveSub = document.getElementById('driveSub');
    var btnDrive = document.getElementById('btnDrive');
    var linkBadge = document.getElementById('linkBadge');
    var linkBadgeText = document.getElementById('linkBadgeText');
    var btnToggleMode = document.getElementById('btnToggleMode');

    var current = null;   // { name, text }
    var pending = '';     // current serialised output, the bytes Drive would get
    var saved = null;     // { id, output } once stored in Drive
    var mode = 'inline';  // 'inline' | 'drive'
    var token = 0;

    creator.hidden = false;
    // Without both credentials the whole lane stays out of the way.
    driveBox.hidden = !Drive.canShorten();

    function show(name, text) {
      current = { name: name, text: text };
      render();
    }

    async function render() {
      if (!current) return;
      var mine = ++token;
      var doc;
      try {
        doc = sanitize(parseSvg(current.text));
      } catch (err) {
        toast(err.message);
        return;
      }

      var output = optMinify.checked ? minify(doc) : serialize(doc);
      var payload = await encodePayload(output);
      if (mine !== token) return;

      // The stored copy belongs to the bytes that were uploaded; if the source
      // changed underneath, the short link no longer describes this image.
      if (saved && saved.output !== output) {
        saved = null;
        mode = 'inline';
        toast('El SVG ha cambiado: vuelve a guardarlo para el enlace corto');
      }

      var inline = shareUrl(payload, current.name);
      var url = mode === 'drive' && saved ? driveUrl(saved.id, current.name) : inline;
      var bytes = encoder.encode(output).length;
      var size = dimensionsOf(output);

      pending = output;
      previewImg.src = dataUri(output);
      fileNameEl.textContent = current.name;
      statsEl.textContent = [size, formatBytes(bytes)].filter(Boolean).join(' · ');
      linkEl.value = url;
      btnOpen.href = url;
      // Once a copy exists in Drive the badge is the switch between both links,
      // in both directions: going back to the self-contained one must not strand
      // the short one.
      linkBadge.hidden = !saved;
      if (saved) {
        linkBadgeText.textContent = mode === 'drive' ? 'en tu Drive' : 'guardado en tu Drive';
        btnToggleMode.textContent = mode === 'drive' ? 'usar el autocontenido' : 'usar el enlace corto';
      }
      driveBox.hidden = !Drive.canShorten() || Boolean(saved);

      var length = url.length;
      var level = mode === 'drive' ? 'ok'
        : length <= URL_OK ? 'ok' : length <= URL_WARN ? 'warn' : 'bad';
      var note = mode === 'drive'
        ? 'Guardado en tu Drive. Se puede compartir en cualquier sitio, incluso como QR.'
        : {
          ok: 'Se puede compartir en cualquier sitio.',
          warn: 'Funciona en navegadores modernos; algunas apps de chat pueden cortarlo.',
          bad: 'Demasiado largo: muchos navegadores y apps lo rechazarán. Simplifica el SVG.'
        }[level];

      // The lane earns its keep exactly when the fragment starts to hurt.
      if (mode !== 'drive' && Drive.canShorten()) {
        driveSub.textContent = level === 'ok'
          ? 'La imagen se guarda en tu cuenta y el enlace baja a unos 70 caracteres, pese lo que pese el SVG.'
          : 'Este SVG genera un enlace largo. Guardándolo en tu Drive baja a unos 70 caracteres.';
        driveBox.classList.toggle('is-nudged', level !== 'ok');
      }

      meterFill.style.width = Math.min(100, (length / URL_WARN) * 100).toFixed(1) + '%';
      meterFill.style.background = 'var(--' + (level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : 'bad') + ')';
      meterLabel.className = 'meter-label is-' + level;
      meterLabel.innerHTML = '<b>' + formatCount(length) + ' caracteres</b> de enlace · ' + note;

      dropCard.hidden = true;
      result.hidden = false;
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function loadFile(file) {
      if (!file) return;
      var isSvg = /image\/svg\+xml/.test(file.type) || /\.svgz?$/i.test(file.name);
      if (!isSvg) return toast('Elige un archivo .svg');
      if (file.size > MAX_INPUT_BYTES) return toast('El archivo es demasiado grande (máx. 2 MB)');

      var reader = new FileReader();
      reader.onload = function () { show(file.name, String(reader.result)); };
      reader.onerror = function () { toast('No se pudo leer el archivo'); };
      reader.readAsText(file);
    }

    fileInput.addEventListener('change', function () {
      loadFile(fileInput.files && fileInput.files[0]);
      fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      window.addEventListener(type, function (event) {
        event.preventDefault();
        drop.classList.add('is-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      window.addEventListener(type, function (event) {
        event.preventDefault();
        if (type === 'drop' || event.target === document.documentElement || !event.relatedTarget) {
          drop.classList.remove('is-over');
        }
      });
    });
    window.addEventListener('drop', function (event) {
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length) loadFile(files[0]);
    });

    window.addEventListener('paste', function (event) {
      var data = event.clipboardData;
      if (!data) return;
      if (data.files && data.files.length) return loadFile(data.files[0]);
      var text = data.getData('text/plain') || '';
      if (/^\s*(<\?xml|<svg)/i.test(text)) {
        event.preventDefault();
        show('pegado.svg', text);
      }
    });

    optMinify.addEventListener('change', render);

    btnCopy.addEventListener('click', async function () {
      toast(await copyText(linkEl.value) ? '¡Enlace copiado!' : 'No se pudo copiar');
    });

    if (navigator.share) {
      btnShare.hidden = false;
      btnShare.addEventListener('click', function () {
        navigator.share({ title: 'SVG compartido', url: linkEl.value }).catch(function () {});
      });
    }

    btnDrive.addEventListener('click', async function () {
      if (!current || !pending) return;
      var output = pending;
      btnDrive.disabled = true;
      btnDrive.textContent = 'Guardando…';
      try {
        var id = await Drive.save(current.name, output);
        saved = { id: id, output: output };
        mode = 'drive';
        toast('Guardado en tu Drive');
        render();
      } catch (err) {
        toast(driveMessage(err));
      } finally {
        btnDrive.disabled = false;
        btnDrive.textContent = 'Guardar en mi Drive';
      }
    });

    btnToggleMode.addEventListener('click', function () {
      mode = mode === 'drive' ? 'inline' : 'drive';
      render();
    });

    btnReset.addEventListener('click', function () {
      current = null;
      pending = '';
      saved = null;
      mode = 'inline';
      linkBadge.hidden = true;
      driveBox.hidden = !Drive.canShorten();
      token++;
      result.hidden = true;
      dropCard.hidden = false;
      fileInput.value = '';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    linkEl.addEventListener('focus', function () { linkEl.select(); });
  }

  /* -------------------------------------------------------------- bootstrap */

  var query = queryParams();
  var hashParams = parseHash(location.hash);
  if (query.d !== undefined) startViewer({ d: query.d, n: query.n });
  else if (hashParams.z !== undefined || hashParams.b !== undefined) startViewer(hashParams);
  else startCreator();
})();
