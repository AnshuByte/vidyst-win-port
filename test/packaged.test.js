'use strict';

/* Verifies the packaged build (dist/win-unpacked) actually renders and that the
   bundled ffmpeg is found via resources/ffmpeg. Catches the "blank window"
   class of packaging bug that a source-mode test cannot. */

const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'win-unpacked', 'VidystWinPort.exe');
const OUT = process.env.VIDYST_OUT ||
  path.join(process.env.USERPROFILE || require('os').homedir(), 'Downloads', 'final vidyst win port exe', 'test screenshots');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  if (!fs.existsSync(EXE)) throw new Error('missing ' + EXE);
  const app = await electron.launch({ executablePath: EXE });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.waitForTimeout(1500);
  const boot = await page.evaluate(() => ({
    title: document.title,
    bodyLen: document.body.innerHTML.length,
    bg: getComputedStyle(document.body).backgroundColor,
    dock: document.querySelectorAll('#dock .dock-item').length,
    hasHook: !!window.__vidyst,
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
  }));
  await page.screenshot({ path: path.join(OUT, 'packaged-boot.png') });

  await page.waitForFunction(
    () => document.getElementById('prevWide')?.src.startsWith('data:image/png'),
    null,
    { timeout: 120000 }
  );
  const after = await page.evaluate(() => ({
    ok: window.__vidyst.state.ffmpegOk,
    caps: window.__vidyst.state.caps,
    engine: window.__vidyst.collect().engine,
    preview: document.getElementById('prevWide').src.length,
    log: document.getElementById('log').textContent.split('\n').slice(0, 6),
  }));
  await page.screenshot({ path: path.join(OUT, 'packaged-preview.png') });

  const dark = (() => {
    const m = boot.bg.match(/\d+/g) || [];
    return m.length >= 3 && Number(m[0]) + Number(m[1]) + Number(m[2]) < 60;
  })();
  const checks = [
    ['window has content', boot.bodyLen > 5000, String(boot.bodyLen)],
    ['dark theme applied', dark, boot.bg],
    ['dock rendered', boot.dock === 10, String(boot.dock)],
    ['diagnostics hook present', boot.hasHook],
    ['ffmpeg resolved in package', after.ok === true],
    ['capture caps detected', !!(after.caps && after.caps.ddagrab)],
    ['preview rendered in package', after.preview > 10000, after.preview + ' chars'],
    ['no renderer errors', errors.length === 0, errors.join(' | ')],
  ];
  let bad = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  }
  console.log('\nffmpegOk=' + after.ok + ' engine=' + after.engine);
  console.log('log: ' + after.log.join(' / '));
  console.log(`${checks.length - bad}/${checks.length} checks passed`);

  await app.close();
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
