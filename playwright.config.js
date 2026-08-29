/*
 * El sitio no tiene build: se sirve tal cual y se prueba en Chromium a 390 px,
 * el ancho de referencia del diseño mobile-first.
 */
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.PORT || 8081);
const BASE = `http://127.0.0.1:${PORT}/`;

module.exports = defineConfig({
  testDir: './test',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: { baseURL: BASE },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } }
    }
  ],
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
    url: `${BASE}index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'ignore'
  }
});
