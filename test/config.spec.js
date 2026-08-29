/*
 * tools/write-config.js genera assets/config.js en el despliegue. Lo que
 * importa es que un valor hostil no pueda escaparse del literal: la salida es
 * un fichero JS que el navegador ejecuta.
 */
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = path.join(__dirname, '..', 'tools', 'write-config.js');

// Ejecuta el generador y devuelve tanto el texto como el objeto resultante.
function generate(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svgshare-config-'));
  const target = path.join(dir, 'config.js');
  const log = execFileSync(process.execPath, [SCRIPT, target], {
    env: { ...process.env, GOOGLE_CLIENT_ID: '', GOOGLE_API_KEY: '', ...env },
    encoding: 'utf8'
  });

  const text = fs.readFileSync(target, 'utf8');
  const sandbox = vm.createContext({ window: {} });
  vm.runInContext(text, sandbox, { filename: 'config.js' });
  fs.rmSync(dir, { recursive: true, force: true });

  return { text, log, config: sandbox.window.SVGSHARE_CONFIG };
}

test('sin variables el carril queda desactivado', () => {
  const { config, log } = generate({});
  expect(config).toEqual({ googleClientId: '', googleApiKey: '' });
  expect(log).toContain('Guardar en Drive (creador): desactivado');
  expect(log).toContain('Leer de Drive (visor): desactivado');
});

test('con las dos variables el carril queda completo', () => {
  const { config, log } = generate({
    GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
    GOOGLE_API_KEY: 'AIzaSyTest'
  });
  expect(config).toEqual({
    googleClientId: '123-abc.apps.googleusercontent.com',
    googleApiKey: 'AIzaSyTest'
  });
  expect(log).toContain('Guardar en Drive (creador): activado');
  expect(log).toContain('Leer de Drive (visor): activado');
});

test('solo el client id avisa de que falta la API key', () => {
  const { log } = generate({ GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com' });
  expect(log).toContain('Aviso');
  expect(log).toContain('GOOGLE_API_KEY');
});

test('solo la API key también avisa', () => {
  const { log } = generate({ GOOGLE_API_KEY: 'AIzaSyTest' });
  expect(log).toContain('Aviso');
  expect(log).toContain('no se puede guardar nada');
});

test('los espacios sobrantes de un pegado se recortan', () => {
  const { config } = generate({ GOOGLE_CLIENT_ID: '  123-abc.apps.googleusercontent.com\n' });
  expect(config.googleClientId).toBe('123-abc.apps.googleusercontent.com');
});

test('un valor con comillas no se escapa del literal', () => {
  const hostile = '";window.__pwned=1;var x="';
  const { config, text } = generate({ GOOGLE_CLIENT_ID: hostile });

  // El texto sigue ahí, pero escapado: es un dato, no código.
  expect(config.googleClientId).toBe(hostile);
  expect(text).toContain('\\";window.__pwned=1;var x=\\"');

  const sandbox = vm.createContext({ window: {} });
  vm.runInContext(text, sandbox, { filename: 'config.js' });
  expect(sandbox.__pwned).toBeUndefined();
  expect(sandbox.window.__pwned).toBeUndefined();
});

test('un valor con saltos de línea y barras no rompe el fichero', () => {
  const hostile = 'a\n</script><script>window.__pwned=1</script>\\';
  const { config } = generate({ GOOGLE_API_KEY: hostile });
  expect(config.googleApiKey).toBe(hostile);
});

test('el fichero generado avisa de que no se edita a mano', () => {
  expect(generate({}).text).toContain('No editar a mano');
});

test('el config.js del repositorio está vacío', () => {
  const sandbox = vm.createContext({ window: {} });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'assets', 'config.js'), 'utf8'),
    sandbox,
    { filename: 'config.js' }
  );
  expect(sandbox.window.SVGSHARE_CONFIG).toEqual({ googleClientId: '', googleApiKey: '' });
});
