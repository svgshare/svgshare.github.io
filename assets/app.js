/*
 * SVGshare — the whole image travels inside the URL fragment.
 * Nothing is ever uploaded: encoding and decoding happen in the browser.
 */
(function () {
  'use strict';

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

  function shareUrl(payload, name) {
    var base = location.origin + location.pathname.replace(/index\.html$/, '');
    return base + '#' + payload + (name ? '&n=' + encodeURIComponent(name) : '');
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
      document.getElementById('btnDownload').disabled = true;
      document.getElementById('btnSource').disabled = true;
    }

    decodePayload(params).then(function (text) {
      if (text === null) return fail('El enlace está dañado o incompleto.');
      try {
        source = minify(sanitize(parseSvg(text)));
      } catch (err) {
        return fail('El enlace está dañado o la imagen no es un SVG válido.');
      }
      img.src = dataUri(source);
    }).catch(function (err) {
      fail(err && err.message === 'no-inflate'
        ? 'Tu navegador no puede descomprimir este enlace. Prueba con uno más reciente.'
        : 'El enlace está dañado o incompleto.');
    });

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

    var current = null; // { name, text }
    var token = 0;

    creator.hidden = false;

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

    linkEl.addEventListener('focus', function () { linkEl.select(); });
  }

  /* -------------------------------------------------------------- bootstrap */

  var hashParams = parseHash(location.hash);
  if (hashParams.z !== undefined || hashParams.b !== undefined) startViewer(hashParams);
  else startCreator();
})();
