/*
 * Tubería SVG compartida por el creador, el visor y la vista de carpeta.
 *
 * Vive en un módulo propio por una razón concreta: `sanitize()` es la frontera
 * de seguridad de todo el proyecto —todo SVG que se pinta pasa por ella, venga
 * de la URL, de Google Drive o del disco— y tener dos copias sería la forma más
 * fácil de que una se quedara atrás.
 */
(function (global) {
  'use strict';

  var encoder = new TextEncoder();

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';
  var DROP_NS = [
    'http://www.inkscape.org/namespaces/inkscape',
    'http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd',
    'http://ns.adobe.com/AdobeIllustrator/10.0/'
  ];
  var KEEP_SPACE = { text: 1, tspan: 1, textpath: 1, title: 1, desc: 1, style: 1 };


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

  // Sirve tanto para el peso de un SVG como para la cuota de una cuenta, que
  // se cuenta en gigas: sin los tramos grandes salían cifras como «15360 MB».
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    if (n < 1099511627776) return (n / 1073741824).toFixed(n < 10737418240 ? 1 : 0) + ' GB';
    return (n / 1099511627776).toFixed(1) + ' TB';
  }

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

  global.SVGShare = {
    toBase64: toBase64,
    fromBase64: fromBase64,
    toBase64Url: toBase64Url,
    fromBase64Url: fromBase64Url,
    formatBytes: formatBytes,
    parseSvg: parseSvg,
    sanitize: sanitize,
    minify: minify,
    serialize: serialize,
    dimensionsOf: dimensionsOf,
    dataUri: dataUri
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
