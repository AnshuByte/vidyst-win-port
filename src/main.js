'use strict';

const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const { buildFfmpegArgs } = require('./pipeline');

let mainWindow = null;
let ffmpegPath = null;
let ffmpegProc = null;
let sinkProc = null;
let liveState = { live: false, startedAt: null, targets: 0, record: null, applying: false };
let liveSegments = [];
let liveBaseRecord = null;
let restarting = false;
let applying = false;
let sinkWanted = false;
let sinkTail = '';
let capsCache = null;
let lastArgs = null;
let previewChain = Promise.resolve();

/* ---------------------------------------------------------------- ffmpeg loc */

function resolveFfmpeg() {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'));
  candidates.push(path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe'));
  candidates.push(path.join(process.cwd(), 'vendor', 'ffmpeg', 'ffmpeg.exe'));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err })
    );
  });
}

async function probe() {
  if (capsCache) return capsCache;
  if (!ffmpegPath) throw new Error('ffmpeg.exe not found');

  const [ver, enc, flt, dev, mux] = await Promise.all([
    run(ffmpegPath, ['-hide_banner', '-version']),
    run(ffmpegPath, ['-hide_banner', '-encoders']),
    run(ffmpegPath, ['-hide_banner', '-filters']),
    run(ffmpegPath, ['-hide_banner', '-devices']),
    run(ffmpegPath, ['-hide_banner', '-muxers']),
  ]);

  const encText = enc.stdout + enc.stderr;
  const fltText = flt.stdout + flt.stderr;
  const devText = dev.stdout + dev.stderr;
  const muxText = mux.stdout + mux.stderr;
  const has = (name) => new RegExp('(^|\\s)' + name + '(\\s|$)', 'm').test(encText);

  // `-encoders` only says the codec is compiled in. NVENC/AMF/QSV builds list
  // their encoders even on machines with no matching GPU or driver, and ffmpeg
  // then dies at startup with "Cannot load nvcuda.dll". Smoke-test each one
  // with a real 3-frame encode before trusting it.
  const smoke = async (name) => {
    const r = await run(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30',
        '-frames:v', '3', '-c:v', name, '-f', 'null', '-'],
      25000
    );
    return r.ok;
  };
  const [nvenc, amf, qsv] = await Promise.all([
    has('h264_nvenc') ? smoke('h264_nvenc') : false,
    has('h264_amf') ? smoke('h264_amf') : false,
    has('h264_qsv') ? smoke('h264_qsv') : false,
  ]);

  capsCache = {
    version: (ver.stdout.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown',
    encoders: {
      h264_nvenc: nvenc,
      h264_amf: amf,
      h264_qsv: qsv,
      libx264: has('libx264'),
    },
    ddagrab: /\bddagrab\b/.test(fltText),
    gdigrab: /\bgdigrab\b/.test(devText),
    dshow: /\bdshow\b/.test(devText),
    tee: /\btee\b/.test(muxText),
  };
  return capsCache;
}

async function listDevices() {
  if (!ffmpegPath) return { video: [], audio: [] };
  const r = await run(
    ffmpegPath,
    ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    25000
  );
  const text = r.stdout + '\n' + r.stderr;
  const video = [];
  const audio = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/"([^"]+)"\s+\((video|audio)\)/);
    if (m) (m[2] === 'video' ? video : audio).push(m[1]);
  }
  return { video, audio };
}

/* ------------------------------------------------------------------ lifecycle */

function sendLog(line) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stream:log', line);
}

function sendState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stream:state', liveState);
}

// The local test sink accepts one publisher at a time. A live apply reconnects,
// so respawn the listener while the user still wants it running.
function launchSink() {
  if (!sinkWanted || sinkProc || !ffmpegPath) return null;
  const url = 'rtmp://127.0.0.1:1935/live/test';
  const proc = spawn(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'info', '-listen', '1', '-i', url, '-f', 'null', '-'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  sinkProc = proc;
  proc.stderr.on('data', (d) => {
    const t = d.toString();
    sinkTail = (sinkTail + t).slice(-4000);
    for (const l of t.replace(/\r/g, '\n').split('\n')) if (l.trim()) sendLog('[sink] ' + l);
  });
  proc.on('exit', () => {
    if (sinkProc === proc) sinkProc = null;
    if (sinkWanted) {
      setTimeout(() => {
        if (sinkWanted && !sinkProc) launchSink();
      }, 600);
    }
  });
  return proc;
}

async function spawnLive(o, startedAt) {
  if (o.recordPath) {
    try {
      fs.mkdirSync(path.dirname(o.recordPath), { recursive: true });
    } catch (err) {
      sendLog('[warn] could not create recording folder: ' + err.message);
    }
  }

  const args = buildFfmpegArgs(o, 'live', capsCache);
  lastArgs = args;
  sendLog('$ ffmpeg ' + args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));

  const proc = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  ffmpegProc = proc;
  liveState = {
    live: true,
    startedAt,
    targets: (o.wideTargets || []).length + (o.tallTargets || []).length,
    record: o.recordPath || null,
    pid: proc.pid,
    applying: !!applying,
  };
  sendState();

  let buf = '';
  proc.stderr.on('data', (d) => {
    buf += d.toString().replace(/\r/g, '\n');
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const l of lines) if (l.trim()) sendLog(l);
  });

  proc.on('exit', (code, sig) => {
    if (ffmpegProc === proc) ffmpegProc = null;

    // An apply stops this process on purpose; the session stays live.
    if (restarting) {
      if (o.recordPath) {
        try {
          const st = fs.statSync(o.recordPath);
          if (st.size < 64 * 1024) {
            fs.unlinkSync(o.recordPath);
            const i = liveSegments.indexOf(o.recordPath);
            if (i >= 0) liveSegments.splice(i, 1);
            sendLog('[apply] discarded empty recording segment');
          }
        } catch (_) {}
      }
      sendLog(`[apply] previous encoder exited (code=${code})`);
      return;
    }

    // A failed start can leave a 0-byte MP4 that players cannot open; do not
    // leave that next to real recordings.
    if (o.recordPath && code !== 0) {
      try {
        const st = fs.statSync(o.recordPath);
        if (st.size < 64 * 1024) {
          fs.unlinkSync(o.recordPath);
          sendLog(`[record] removed unusable file (${st.size} bytes) after ffmpeg exit ${code}`);
        }
      } catch (_) {}
    }
    liveState = { live: false, startedAt: null, targets: 0, record: null, exitCode: code, signal: sig, applying: false };
    sendState();
    sendLog(`[ffmpeg exited code=${code} signal=${sig}]`);
  });

  return { ok: true, pid: proc.pid, startedAt };
}

async function startStream(o) {
  if (ffmpegProc) throw new Error('A session is already running');
  await probe();
  // A preview still reading the camera or the desktop would starve the live
  // graph (DirectShow can only be opened by one process at a time).
  await previewChain;
  liveBaseRecord = o.recordPath || null;
  liveSegments = o.recordPath ? [o.recordPath] : [];
  restarting = false;
  applying = false;
  return spawnLive(o, Date.now());
}

// Re-open the ffmpeg graph with new settings while the session is live. Both
// RTMP connections drop for a few seconds; the session timer keeps running and
// recording continues in segments that are merged on stop.
async function applyStream(o) {
  if (!ffmpegProc) return startStream(o);
  if (applying) return { ok: false, busy: true };

  const startedAt = liveState.startedAt || Date.now();
  applying = true;
  liveState = { ...liveState, applying: true };
  sendState();

  const old = ffmpegProc;
  restarting = true;
  sendLog('[apply] reconnecting with the new settings…');
  try { old.stdin.write('q'); old.stdin.end(); } catch (_) {}
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { old.kill(); } catch (_) {}
      resolve();
    }, 6000);
    old.once('exit', () => { clearTimeout(t); resolve(); });
  });
  restarting = false;

  // A new output file means the previous take is finished; merge its parts now.
  if (o.recordPath && liveBaseRecord && o.recordPath !== liveBaseRecord) {
    await finalizeRecording();
  }

  let segment = null;
  if (o.recordPath) {
    if (!liveBaseRecord) liveBaseRecord = o.recordPath;
    const n = liveSegments.length + 1;
    segment = n === 1 ? o.recordPath : o.recordPath.replace(/\.mp4$/i, `-p${n}.mp4`);
    liveSegments.push(segment);
  }

  // Give DirectShow/DXGI a moment to release the camera and the screen.
  await new Promise((r) => setTimeout(r, 500));

  try {
    applying = false;
    return { ...(await spawnLive({ ...o, recordPath: segment }, startedAt)), applied: true };
  } catch (err) {
    applying = false;
    liveState = { live: false, startedAt: null, targets: 0, record: null, exitCode: -1, signal: null, applying: false };
    sendState();
    sendLog('ERROR: could not reopen the live session: ' + (err.message || err));
    return { ok: false, error: String(err.message || err) };
  }
}

async function finalizeRecording() {
  const base = liveBaseRecord;
  const segs = [];
  for (const p of liveSegments) {
    try {
      if (!fs.existsSync(p)) continue;
      const size = fs.statSync(p).size;
      // Keep the first file even if it is short; drop empty later parts.
      if (size < 64 * 1024 && p !== base) {
        fs.rmSync(p, { force: true });
        sendLog('[record] removed empty recording part ' + path.basename(p));
        continue;
      }
      segs.push(p);
    } catch (_) {}
  }
  let merged = false;

  if (base && segs.length > 1 && ffmpegPath) {
    const list = path.join(app.getPath('temp'), `vidyst-concat-${Date.now()}.txt`);
    const tmp = base.replace(/\.mp4$/i, `.merged-${Date.now()}.mp4`);
    try {
      fs.writeFileSync(list, segs.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
      const r = await run(
        ffmpegPath,
        ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
          '-c', 'copy', '-movflags', '+faststart', '-y', tmp],
        180000
      );
      if (r.ok && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
        fs.rmSync(base, { force: true });
        fs.renameSync(tmp, base);
        for (const p of segs) if (p !== base) fs.rmSync(p, { force: true });
        merged = true;
        sendLog(`[record] merged ${segs.length} parts into ${path.basename(base)}`);
      } else {
        sendLog('[record] parts could not be merged (settings changed?); kept: ' + segs.map((p) => path.basename(p)).join(', '));
        fs.rmSync(tmp, { force: true });
      }
    } catch (err) {
      sendLog('[record] merge failed: ' + (err.message || err));
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    } finally {
      try { fs.rmSync(list, { force: true }); } catch (_) {}
    }
  }

  const result = { merged, base: merged ? base : (segs[0] || null), parts: merged ? 1 : segs.length };
  liveSegments = [];
  liveBaseRecord = null;
  return result;
}

async function stopStream() {
  const proc = ffmpegProc;
  if (!proc) {
    const recording = await finalizeRecording();
    return { ok: true, already: true, recording };
  }
  restarting = false;
  sendLog('[stopping] sending q to ffmpeg');
  try {
    proc.stdin.write('q');
    proc.stdin.end();
  } catch (_) {}
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      resolve();
    }, 6000);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
  const recording = await finalizeRecording();
  return { ok: true, recording };
}

/* ---------------------------------------------------------------------- IPC */

function registerIpc() {
  ipcMain.handle('app:info', async () => {
    const caps = ffmpegPath ? await probe().catch(() => null) : null;
    return {
      ffmpegPath,
      caps,
      packaged: app.isPackaged,
      version: app.getVersion(),
      platform: process.platform,
      videos: app.getPath('videos'),
    };
  });

  ipcMain.handle('devices:list', async () => listDevices());

  ipcMain.handle('displays:list', async () =>
    screen.getAllDisplays().map((d, i) => ({
      index: i,
      id: d.id,
      width: d.size.width,
      height: d.size.height,
      primary: d.id === screen.getPrimaryDisplay().id,
      scaleFactor: d.scaleFactor,
    }))
  );

  ipcMain.handle('preview:frame', async (_e, o) => {
    if (ffmpegProc) {
      return { ok: false, error: 'Stop the live session before previewing (the camera is in use).' };
    }
    // Serialize: two preview runs at once would fight over the DirectShow camera.
    const runPreview = async () => {
      const dir = path.join(app.getPath('temp'), 'vidyst-win-port');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = Date.now();
      const wide = path.join(dir, `wide-${stamp}.png`);
      const tall = path.join(dir, `tall-${stamp}.png`);
      const args = buildFfmpegArgs(
        { ...o, previewWidePath: wide, previewTallPath: tall },
        'preview',
        capsCache
      );
      const r = await run(ffmpegPath, args, 45000);
      if (!fs.existsSync(wide) || !fs.existsSync(tall)) {
        return { ok: false, error: (r.stderr || '').split(/\r?\n/).slice(-12).join('\n') };
      }
      return {
        ok: true,
        wide: 'data:image/png;base64,' + fs.readFileSync(wide).toString('base64'),
        tall: 'data:image/png;base64,' + fs.readFileSync(tall).toString('base64'),
      };
    };
    const next = previewChain.then(runPreview, runPreview);
    previewChain = next.catch(() => {});
    return next;
  });

  ipcMain.handle('stream:start', async (_e, o) => {
    try {
      return await startStream(o);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('stream:apply', async (_e, o) => {
    try {
      return await applyStream(o);
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('stream:stop', async () => stopStream());
  ipcMain.handle('stream:state', async () => liveState);
  ipcMain.handle('stream:args', async () => lastArgs);

  ipcMain.handle('sink:start', async () => {
    const url = 'rtmp://127.0.0.1:1935/live/test';
    sinkWanted = true;
    if (sinkProc) return { ok: true, url };
    sinkTail = '';
    const proc = launchSink();
    await new Promise((r) => setTimeout(r, 1500));
    if (!proc || !sinkProc || proc.exitCode !== null) {
      sinkWanted = false;
      if (sinkProc) {
        try { sinkProc.kill(); } catch (_) {}
        sinkProc = null;
      }
      return { ok: false, error: 'sink exited: ' + sinkTail.split(/\r?\n/).slice(-6).join(' | ') };
    }
    return { ok: true, url };
  });

  ipcMain.handle('sink:stop', async () => {
    sinkWanted = false;
    if (sinkProc) {
      try { sinkProc.kill(); } catch (_) {}
      sinkProc = null;
    }
    return { ok: true };
  });

  ipcMain.handle('dialog:recordPath', async () => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Where should recordings go?',
      defaultPath: path.join(
        app.getPath('videos'),
        `vidyst-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4`
      ),
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    return r.canceled ? null : r.filePath;
  });

  ipcMain.handle('shell:openFolder', async (_e, p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    return true;
  });
}

/* --------------------------------------------------------------------- boot */

function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const width = Math.max(880, Math.min(1180, workAreaSize.width - 24));
  const height = Math.max(560, Math.min(800, workAreaSize.height - 24));

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 880,
    minHeight: 540,
    backgroundColor: '#0b0d12',
    title: 'Vidyst Win Port',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  ffmpegPath = resolveFfmpeg();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  sinkWanted = false;
  if (ffmpegProc) await stopStream().catch(() => {});
  if (sinkProc) { try { sinkProc.kill(); } catch (_) {} }
  app.quit();
});

app.on('before-quit', () => {
  sinkWanted = false;
  if (ffmpegProc) { try { ffmpegProc.kill(); } catch (_) {} }
  if (sinkProc) { try { sinkProc.kill(); } catch (_) {} }
});
