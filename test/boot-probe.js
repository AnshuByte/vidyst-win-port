'use strict';

/* Boot diagnostics: dumps real renderer state before and after the first
   preview, so layout/engine/mic mismatches are visible instead of guessed. */

const { _electron: electron } = require('playwright-core');
const path = require('path');

const ROOT = path.join(__dirname, '..');

(async () => {
  const app = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.'],
    cwd: ROOT,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const snap = () =>
    page.evaluate(() => {
      const s = window.__vidyst.state;
      const c = window.__vidyst.collect();
      const kv = [...document.querySelectorAll('.kv')]
        .map((el) => el.textContent.replace(/\s+/g, ' ').trim())
        .filter((t) => /Layout|Canvas|Encoder|Record/.test(t));
      return {
        layout: s.layout,
        activeDock: document.querySelector('.dock-item.active')?.dataset.layout || null,
        summary: document.getElementById('sceneSummary')?.textContent || '',
        engine: c.engine,
        resolution: s.resolution,
        camera: s.camera,
        mic: s.mic,
        caps: s.caps && { ddagrab: s.caps.ddagrab, encoders: s.caps.encoders },
        previewReady: document.getElementById('prevWide').src.startsWith('data:image/png'),
        panel: kv,
        logErrors: document.getElementById('log').textContent
          .split('\n')
          .filter((l) => /error|failed|unconnected|Invalid/i.test(l))
          .slice(0, 6),
      };
    });

  await page.waitForTimeout(1200);
  const before = await snap();
  await page.waitForFunction(
    () => document.getElementById('prevWide').src.startsWith('data:image/png'),
    null,
    { timeout: 90000 }
  );
  await page.waitForTimeout(600);
  const after = await snap();

  console.log(JSON.stringify({ before, after, pageErrors: errors }, null, 2));
  await app.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
