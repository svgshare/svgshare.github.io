/*
 * El decodificador DEFLATE en JS (assets/inflate.js) es el respaldo para
 * navegadores sin DecompressionStream, así que se contrasta contra la
 * implementación de referencia: zlib.deflateRawSync de Node.
 *
 * No hace falta navegador: el fichero solo depende de globalThis.
 */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'inflate.js'), 'utf8');
const sandbox = vm.createContext({});
vm.runInContext(source, sandbox, { filename: 'inflate.js' });
const inflateRaw = sandbox.inflateRaw;

function roundtrip(buffer, level) {
  const packed = zlib.deflateRawSync(buffer, level === undefined ? undefined : { level });
  return Buffer.from(inflateRaw(new Uint8Array(packed)));
}

test('el decodificador se expone como inflateRaw', () => {
  expect(typeof inflateRaw).toBe('function');
});

test('bloques sin comprimir (stored): nivel 0', () => {
  const data = Buffer.from('SVGshare — la imagen viaja dentro del enlace', 'utf8');
  expect(roundtrip(data, 0).equals(data)).toBe(true);
});

test('bloques con árbol fijo: entradas cortas y repetitivas', () => {
  const data = Buffer.from('abababababababababab', 'utf8');
  expect(roundtrip(data, 1).equals(data)).toBe(true);
});

test('bloques con árbol dinámico: un SVG realista', () => {
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">';
  for (let i = 0; i < 400; i++) {
    svg += `<path d="M${i} ${i * 3}l12.5 7.25q3.1 4.2 9.75 11.3z" fill="#${(i % 16).toString(16)}3c7f"/>`;
  }
  const data = Buffer.from(svg + '</svg>', 'utf8');
  expect(roundtrip(data, 9).equals(data)).toBe(true);
});

test('la entrada vacía devuelve salida vacía', () => {
  expect(roundtrip(Buffer.alloc(0)).length).toBe(0);
});

test('un solo byte sobrevive', () => {
  const data = Buffer.from([0x41]);
  expect(roundtrip(data).equals(data)).toBe(true);
});

test('UTF-8 multibyte no se corrompe', () => {
  const data = Buffer.from('diseño ñandú · 日本語 · 🎨'.repeat(50), 'utf8');
  expect(roundtrip(data).equals(data)).toBe(true);
});

test('distancias largas: repetición muy separada en la ventana', () => {
  const data = Buffer.concat([
    Buffer.from('MARCA-UNICA-AL-PRINCIPIO'),
    Buffer.alloc(40000, 0x2e),
    Buffer.from('MARCA-UNICA-AL-PRINCIPIO')
  ]);
  expect(roundtrip(data).equals(data)).toBe(true);
});

test('fuzzing contra zlib: 200 entradas aleatorias en todos los niveles', () => {
  // Semilla fija: un fallo es reproducible, no un misterio de una tirada.
  let seed = 20260829;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let round = 0; round < 200; round++) {
    const size = Math.floor(rand() * 6000);
    const bytes = Buffer.alloc(size);
    // Mezcla de ruido puro y datos repetitivos: el ruido fuerza bloques
    // stored, la repetición fuerza árboles fijos y dinámicos.
    const repetitive = rand() < 0.5;
    const alphabet = repetitive ? 6 : 256;
    for (let i = 0; i < size; i++) bytes[i] = Math.floor(rand() * alphabet);

    const level = Math.floor(rand() * 10);
    const packed = zlib.deflateRawSync(bytes, { level });
    const back = Buffer.from(inflateRaw(new Uint8Array(packed)));
    expect(
      back.equals(bytes),
      `ronda ${round}: ${size} bytes, nivel ${level}, ${repetitive ? 'repetitivo' : 'ruido'}`
    ).toBe(true);
  }
});

test('datos truncados fallan en vez de devolver basura', () => {
  const packed = zlib.deflateRawSync(Buffer.from('x'.repeat(5000)));
  expect(() => inflateRaw(new Uint8Array(packed.subarray(0, 5)))).toThrow();
});

test('datos que no son DEFLATE fallan', () => {
  expect(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))).toThrow();
});
