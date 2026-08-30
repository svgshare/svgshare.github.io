/*
 * Selector de tema: automático (el del sistema), claro u oscuro.
 *
 * Se carga sin `defer` y aplica el atributo antes del primer pintado: si se
 * esperara al DOM, una recarga en oscuro daría un destello blanco.
 *
 * La preferencia es una comodidad por navegador, así que localStorage vale —
 * pero puede fallar (ventana privada, cookies bloqueadas), y ahí lo correcto es
 * caer en «automático» sin romper nada.
 */
(function (global) {
  'use strict';

  var KEY = 'svgshare-theme';
  var MODES = ['auto', 'light', 'dark'];
  var LABELS = { auto: 'Auto', light: 'Claro', dark: 'Oscuro' };

  function read() {
    try {
      var saved = localStorage.getItem(KEY);
      return MODES.indexOf(saved) !== -1 ? saved : 'auto';
    } catch (err) {
      return 'auto';
    }
  }

  function write(mode) {
    try { localStorage.setItem(KEY, mode); } catch (err) { /* da igual */ }
  }

  // «auto» se representa quitando el atributo: manda prefers-color-scheme.
  function apply(mode) {
    var root = document.documentElement;
    if (mode === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
  }

  var current = read();
  apply(current);

  function build() {
    var feet = document.querySelectorAll('.foot');
    Array.prototype.forEach.call(feet, function (foot) {
      var box = document.createElement('div');
      box.className = 'theme-switch';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Tema');

      MODES.forEach(function (mode) {
        var button = document.createElement('button');
        button.type = 'button';
        button.dataset.theme = mode;
        button.textContent = LABELS[mode];
        button.setAttribute('aria-pressed', String(mode === current));
        button.addEventListener('click', function () {
          current = mode;
          write(mode);
          apply(mode);
          sync();
        });
        box.appendChild(button);
      });
      foot.appendChild(box);
    });
    sync();
  }

  // Hay un selector por vista, y las tres pueden convivir en la misma página.
  function sync() {
    var buttons = document.querySelectorAll('.theme-switch button');
    Array.prototype.forEach.call(buttons, function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.theme === current));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }

  global.SVGShareTheme = { get: function () { return current; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
