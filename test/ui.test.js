'use strict';

/* Drives the real Electron app with Playwright: clicks every panel, changes
   layouts, opens the Go Live sheet, streams to the local RTMP sink, records an
   MP4, stops, and asserts on DOM + main-process state. Screenshots go next to
   the delivered exe. */

const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.VIDYST_OUT ||
  path.join(process.env.USERPROFILE || require('os').homedir(), 'Downloads', 'final vidyst win port exe', 'test screenshots');
const VIDEOS = path.join(process.env.USERPROFILE || '', 'Videos', 'Vidyst');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const app = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.'],
    cwd: ROOT,
  });

  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  let logText = '';
  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('shot   ' + name + '.png');
  };
  const dumpLog = async () => {
    logText = await page.evaluate(() => document.getElementById('log').textContent);
    fs.writeFileSync(path.join(OUT, 'live-ffmpeg.log'), logText);
    return logText;
  };

  try {
    await page.waitForSelector('#dock .dock-item', { timeout: 25000 });
    // First preview runs ffmpeg once for both canvases; wait for the actual result.
    await page.waitForFunction(
      () => document.getElementById('prevWide').src.startsWith('data:image/png'),
      null,
      { timeout: 90000 }
    );
    await page.waitForTimeout(800);

    check('dock renders 10 layouts', (await page.locator('#dock .dock-item').count()) === 10,
      String(await page.locator('#dock .dock-item').count()));

    const wideSrc = await page.evaluate(() => document.getElementById('prevWide').src);
    const tallSrc = await page.evaluate(() => document.getElementById('prevTall').src);
    check('wide preview rendered', wideSrc.startsWith('data:image/png'), wideSrc.slice(0, 22));
    check('tall preview rendered', tallSrc.startsWith('data:image/png'), tallSrc.slice(0, 22));

    const encLabel = await page.locator('.kv', { hasText: 'Encoder' }).locator('span').last().textContent();
    check('encoder label resolved', !!encLabel && !encLabel.includes('detecting'), encLabel);

    const bootErrors = await page.evaluate(() =>
      document.getElementById('log').textContent
        .split('\n')
        .filter((l) => /unconnected|preview failed|Invalid argument/i.test(l))
    );
    check('no preview errors at boot', bootErrors.length === 0, bootErrors.join(' | '));

    await shot('01-program');

    await page.click('.tool[data-tab="destinations"]');
    await page.waitForTimeout(350);
    check('destinations panel opens', (await page.locator('.side-title').textContent()) === 'Destinations');
    await shot('02-destinations');

    await page.click('.tool[data-tab="sources"]');
    await page.waitForTimeout(350);
    check('sources panel opens', (await page.locator('.side-title').textContent()) === 'Sources');
    const camOptions = await page.locator('#selCamera option').count();
    check('camera devices listed', camOptions > 1, camOptions + ' options');
    check('camera ratio control present', (await page.locator('#rngCam').count()) === 1);
    await shot('03-sources');

    await page.click('.tool[data-tab="audio"]');
    await page.waitForTimeout(300);
    await shot('04-audio');

    await page.click('.tool[data-tab="settings"]');
    await page.waitForTimeout(300);
    await shot('05-settings');

    // layout switch -> preview re-render
    await page.click('[data-layout="side"]');
    await page.click('.tool[data-tab="program"]');
    await page.waitForFunction(
      (prev) => {
        const el = document.getElementById('prevWide');
        return el.src.startsWith('data:image/png') && el.src !== prev;
      },
      wideSrc,
      { timeout: 90000 }
    );
    check('layout switch marks active', await page.locator('[data-layout="side"]').evaluate((el) => el.classList.contains('active')));
    const wide2 = await page.evaluate(() => document.getElementById('prevWide').src);
    check('preview re-rendered after layout change', wide2.startsWith('data:image/png') && wide2 !== wideSrc);
    check('panel follows layout switch', (await page.locator('.kv', { hasText: 'Layout' }).locator('span').last().textContent()) === 'Side by side');
    await shot('06-layout-side');

    // add a destination, then a local sink, then disable the unreachable one
    await page.click('.tool[data-tab="destinations"]');
    await page.waitForTimeout(300);
    await page.click('#btnAddDest');
    await page.waitForTimeout(200);
    const urlInput = page.locator('.dest-card').last().locator('.dest-url');
    await urlInput.fill('rtmp://a.rtmp.youtube.com/live2/TEST-KEY-123');
    await urlInput.press('Tab');
    await page.waitForTimeout(400);
    check('destination counted in top bar', (await page.locator('#onCount').textContent()).includes('1 of 1'),
      await page.locator('#onCount').textContent());

    await page.click('#btnSink');
    await page.waitForTimeout(2500);
    check('test sink started', (await page.locator('#btnSink').textContent()).includes('Stop'),
      await page.locator('#btnSink').textContent());
    check('top bar counts both destinations', (await page.locator('#onCount').textContent()).includes('2 of 2'),
      await page.locator('#onCount').textContent());
    await shot('07-destinations-filled');

    // turn the fake YouTube row off so the live test targets only the sink
    await page.locator('.dest-card').nth(2).locator('.toggle').click();
    await page.waitForTimeout(300);
    check('toggle disables a destination', (await page.locator('#onCount').textContent()).includes('1 of 2'),
      await page.locator('#onCount').textContent());

    await page.click('#btnLive');
    await page.waitForTimeout(500);
    check('go-live sheet opens', await page.locator('#modal').isVisible());
    check('sheet lists destination rows', (await page.locator('#sheetDests .sheet-dest').count()) >= 1);
    await shot('08-go-live-sheet');
    await page.click('#sheetCancel');
    await page.waitForTimeout(300);
    check('sheet closes', !(await page.locator('#modal').isVisible()));

    // ---- real end-to-end: stream + record to the local sink
    await page.click('#btnLive');
    await page.waitForTimeout(400);
    await page.click('#sheetGo');

    let st = null;
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      st = await page.evaluate(() => window.api.state());
      if (st.live) break;
    }
    check('main process reports live', st && st.live, JSON.stringify(st));
    if (!st || !st.live) {
      const l = await dumpLog();
      console.log('\n--- ffmpeg log tail ---\n' + l.slice(-2500));
    }

    check('live pill visible', await page.locator('#livePill').isVisible());
    const timerText = await page.locator('#timer').textContent();
    check('timer running', /^00:00:\d\d$/.test(timerText), timerText);
    await shot('10-live');

    const liveArgs = await page.evaluate(() => window.api.args());
    const recPath = st && st.record;
    check('recording path set', !!recPath, recPath || '');
    const argText = Array.isArray(liveArgs) ? liveArgs.join(' ') : '';
    check('single encode fanned out by tee', argText.includes('[f=mp4]') && argText.includes('|'),
      argText.includes('[f=mp4]') ? 'tee has RTMP + MP4 slaves' : 'no mp4 slave');

    // let it run a few seconds of real media
    await sleep(4000);

    // ---- reconfigure while live: camera ratio + layout. The graph reopens,
    // the session timer continues, and the recording continues as a segment.
    await page.click('.tool[data-tab="sources"]');
    await page.waitForTimeout(400);
    await page.locator('#rngCam').evaluate((el) => {
      el.value = '40';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const pidBefore = st.pid;
    const startedBefore = st.startedAt;
    await page.click('[data-layout="screen-tile"]');
    let applied = false;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const s = await page.evaluate(() => window.api.state());
      if (s.live && s.pid !== pidBefore) { st = s; applied = true; break; }
      st = s;
    }
    check(
      'layout and camera ratio apply while live',
      applied && !!st.live && st.pid !== pidBefore && st.startedAt === startedBefore,
      `pid ${pidBefore} -> ${st.pid}, timer ${st.startedAt === startedBefore ? 'kept' : 'RESET'}`
    );
    check(
      'live pill returns to LIVE after apply',
      (await page.locator('#livePill').textContent()).trim() === 'LIVE'
    );
    await shot('10b-live-reconfigured');
    await sleep(5000);

    await page.click('#btnLive'); // Stop
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      st = await page.evaluate(() => window.api.state());
      if (!st.live) break;
    }
    check('stream stopped', st && !st.live, JSON.stringify(st));
    check('live pill hidden after stop', !(await page.locator('#livePill').isVisible()));
    await shot('11-stopped');

    if (recPath && fs.existsSync(recPath)) {
      const size = fs.statSync(recPath).size;
      check('MP4 recorded', size > 100 * 1024, `${(size / 1024 / 1024).toFixed(2)} MB at ${recPath}`);
      const probe = require('child_process').spawnSync(
        path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe'),
        ['-v', 'error', '-i', recPath, '-f', 'null', '-'],
        { encoding: 'utf8' }
      );
      check('MP4 decodes cleanly', probe.status === 0 && !String(probe.stderr).trim(),
        (String(probe.stderr).trim().split('\n')[0] || 'no errors'));
      const part2 = recPath.replace(/\.mp4$/i, '-p2.mp4');
      check('recording segments merged into one MP4', !fs.existsSync(part2),
        fs.existsSync(part2) ? 'part left: ' + part2 : 'one file');
    } else {
      check('MP4 recorded', false, 'file missing: ' + recPath);
    }

    // log drawer
    if (await page.locator('#modal').isVisible()) await page.click('#sheetCancel');
    await page.click('#btnLog');
    await page.waitForTimeout(400);
    await shot('12-log');
    const l = await dumpLog();
    check('ffmpeg input logged', /Input #0, dshow/.test(l));
    check('rtmp sink in command', /rtmp:\/\/127\.0\.0\.1:1935\/live\/test/.test(l));
    check('recording output logged', /\[f=mp4\]/.test(l), (l.match(/\[f=mp4\][^\s|']+/) || [''])[0]);
    check('no encoder failure', !/Cannot load nvcuda|Error while opening encoder/.test(l),
      (l.match(/Cannot load nvcuda[^\n]*/) || [''])[0]);
    check('no renderer errors', errors.length === 0, errors.slice(0, 3).join(' | '));

    const failed = results.filter((r) => !r.ok).length;
    fs.writeFileSync(path.join(OUT, 'ui-test-report.json'),
      JSON.stringify({ when: new Date().toISOString(), results, errors }, null, 2));
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
  } catch (err) {
    console.log('TEST CRASH: ' + err.message);
    await dumpLog().catch(() => {});
    await shot('99-crash');
    fs.writeFileSync(path.join(OUT, 'ui-test-report.json'),
      JSON.stringify({ results, errors, crash: err.message, log: logText.slice(-6000) }, null, 2));
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
  }
})();
