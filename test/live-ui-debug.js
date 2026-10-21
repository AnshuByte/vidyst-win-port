'use strict';

const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.VIDYST_OUT ||
  path.join(process.env.USERPROFILE || require('os').homedir(), 'Downloads', 'final vidyst win port exe', 'test screenshots');

(async () => {
  const app = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.'],
    cwd: ROOT,
  });
  const page = await app.firstWindow();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  try {
    await page.waitForSelector('#dock .dock-item', { timeout: 25000 });
    await page.waitForTimeout(6000);

    await page.click('.tool[data-tab="destinations"]');
    await page.waitForTimeout(400);
    await page.click('#btnSink');
    await page.waitForTimeout(2500);
    console.log('sink button:', await page.locator('#btnSink').textContent());

    await page.click('#btnLive');
    await page.waitForTimeout(400);
    await page.click('#sheetGo');

    for (let i = 1; i <= 4; i++) {
      await page.waitForTimeout(2500);
      const st = await page.evaluate(() => window.api.state());
      const pill = await page.locator('#livePill').isVisible();
      console.log(`t=${i * 2.5}s liveState=`, JSON.stringify(st), 'pill=', pill);
    }

    const log = await page.evaluate(() => document.getElementById('log').textContent);
    console.log('\n===== APP LOG =====\n' + log.slice(-6000));

    const args = await page.evaluate(() => window.api.args());
    console.log('\n===== ARGS =====\n' + (args ? args.join('\n') : 'none'));

    await page.screenshot({ path: path.join(OUT, 'debug-live.png') });

    const st = await page.evaluate(() => window.api.state());
    if (st.live) await page.evaluate(() => window.api.stop());
    await page.waitForTimeout(1500);

    console.log('\nerrors:', errs.length ? errs.join('\n') : 'none');
    fs.writeFileSync(path.join(OUT, 'debug-live.log'), log + '\n\nARGS\n' + (args || []).join('\n'));
  } catch (e) {
    console.log('CRASH: ' + e.message);
    await page.screenshot({ path: path.join(OUT, 'debug-crash.png') }).catch(() => {});
  } finally {
    await app.close().catch(() => {});
  }
})();
