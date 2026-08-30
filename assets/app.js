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

  /* --------------------------------------------------------- bytes y svg */

  var S = self.SVGShare;
  var toBase64Url = S.toBase64Url;
  var fromBase64Url = S.fromBase64Url;
  var formatBytes = S.formatBytes;
  var parseSvg = S.parseSvg;
  var sanitize = S.sanitize;
  var minify = S.minify;
  var serialize = S.serialize;
  var dimensionsOf = S.dimensionsOf;
  var dataUri = S.dataUri;

  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

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

  function formatCount(n) {
    return n.toLocaleString('es-ES');
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

  function queryParams() {
    var params = {};
    location.search.replace(/^\?/, '').split('&').forEach(function (part) {
      var eq = part.indexOf('=');
      if (eq > 0) params[part.slice(0, eq)] = part.slice(eq + 1);
    });
    return params;
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
    var preview = document.getElementById('preview');
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
    var driveLink = document.getElementById('driveLink');
    var driveSub = document.getElementById('driveSub');
    var accountLink = document.getElementById('accountLink');

    var current = null;   // { name, text }
    var token = 0;

    creator.hidden = false;
    // Saving to Drive lives in /account/ now; the creator only points at it,
    // and only when this deployment can both store and serve those links.
    // El de la cabecera está siempre; el de la tarjeta solo tras cargar un SVG,
    // porque su trabajo es otro: avisar cuando el enlace se pone largo.
    driveLink.hidden = !Drive.canShorten();
    accountLink.hidden = !Drive.canShorten();

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

      var url = shareUrl(payload, current.name);
      var bytes = encoder.encode(output).length;
      var size = dimensionsOf(output);

      previewImg.src = dataUri(output);
      fileNameEl.textContent = current.name;
      statsEl.textContent = [size, formatBytes(bytes)].filter(Boolean).join(' · ');
      linkEl.value = url;
      btnOpen.href = url;

      var length = url.length;
      var level = length <= URL_OK ? 'ok' : length <= URL_WARN ? 'warn' : 'bad';
      var note = {
        ok: 'Se puede compartir en cualquier sitio.',
        warn: 'Funciona en navegadores modernos; algunas apps de chat pueden cortarlo.',
        bad: 'Demasiado largo: muchos navegadores y apps lo rechazarán. Simplifica el SVG.'
      }[level];

      // El atajo a la carpeta se gana el sitio justo cuando el fragmento duele.
      if (Drive.canShorten()) {
        driveSub.textContent = level === 'ok'
          ? 'Guarda tus SVG en tu propia cuenta y compártelos con un enlace de unos 70 caracteres, pese lo que pesen.'
          : 'Este SVG genera un enlace largo. Guardado en tu Drive baja a unos 70 caracteres.';
        driveLink.classList.toggle('is-nudged', level !== 'ok');
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

    btnReset.addEventListener('click', function () {
      current = null;
      token++;
      result.hidden = true;
      dropCard.hidden = false;
      fileInput.value = '';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // La proporción se toma del tamaño que el navegador resuelve para el SVG,
    // que es lo único fiable: hay SVG sin width/height, o con porcentajes.
    previewImg.addEventListener('load', function () {
      var w = previewImg.naturalWidth;
      var h = previewImg.naturalHeight;
      if (w > 0 && h > 0) preview.style.setProperty('--ratio', w + ' / ' + h);
      else preview.style.removeProperty('--ratio');
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
