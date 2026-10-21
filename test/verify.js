'use strict';

/* End-to-end verification of the real command builder against the bundled ffmpeg.
   Usage:  node test/verify.js [preview|record|tee|all]
   Device names come from CAM / MIC env vars so this stays machine-agnostic. */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { buildFfmpegArgs, RESOLUTIONS } = require('../src/pipeline');

const ffmpeg = path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe');
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

// Force software encoding so this test measures the graph, not the GPU.
const caps = {
  encoders: { libx264: true, h264_nvenc: false, h264_amf: false, h264_qsv: false },
  ddagrab: true, gdigrab: true, dshow: true, tee: true,
};

const CAM = process.env.CAM || null;
const MIC = process.env.MIC || null;

function baseOpts(extra = {}) {
  return {
    layout: 'screen-cam',
    monitor: 0,
    engine: 'ddagrab',
    camera: CAM,
    mic: MIC,
    encoder: 'libx264',
    bitrate: 4000,
    resolution: '720p',
    fps: 30,
    wideTargets: [],
    tallTargets: [],
    recordPath: null,
    ...extra,
  };
}

function withLimit(args, seconds) {
  // -t is an output option: it must sit before the last output target.
  const a = args.slice();
  a.splice(a.length - 1, 0, '-t', String(seconds));
  return a;
}

function show(title, args) {
  console.log('\n=== ' + title + ' ===');
  console.log(args.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' '));
}

function decodes(file) {
  if (!fs.existsSync(file)) return false;
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const err = String(r.stderr || '').trim();
  if (err) console.log('decode errors: ' + err.split('\n').slice(0, 3).join(' | '));
  return r.status === 0 && !err;
}

function runOnce(title, opts, mode, limit) {
  let args = buildFfmpegArgs(opts, mode, caps);
  if (limit) args = withLimit(args, limit);
  show(title, args);
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
  if (r.status !== 0) {
    console.log('FAILED exit=' + r.status);
    console.log((r.stderr || '').split(/\r?\n/).slice(-25).join('\n'));
    return false;
  }
  console.log('OK exit=0');
  return true;
}

async function runTee(title, opts, limit) {
  const url = 'rtmp://127.0.0.1:1935/live/test';
  const sink = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'info', '-listen', '1', '-i', url, '-f', 'null', '-'], {
    windowsHide: true,
  });
  let sinkLog = '';
  sink.stderr.on('data', (d) => { sinkLog += d.toString(); });
  await new Promise((r) => setTimeout(r, 1500));

  const args = withLimit(buildFfmpegArgs(opts, 'live', caps), limit);
  show(title, args);

  const pub = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let pubLog = '';
  pub.stderr.on('data', (d) => { pubLog += d.toString(); });

  const code = await new Promise((resolve) => {
    const stop = setTimeout(() => {
      try { pub.stdin.write('q'); } catch (_) {}
      const hard = setTimeout(() => { try { pub.kill(); } catch (_) {} }, 12000);
      pub.on('exit', () => clearTimeout(hard));
    }, limit * 1000);
    const guard = setTimeout(() => { try { pub.kill(); } catch (_) {} }, (limit + 30) * 1000);
    pub.on('exit', (c) => { clearTimeout(stop); clearTimeout(guard); resolve(c); });
  });

  await new Promise((r) => setTimeout(r, 800));
  try { sink.kill(); } catch (_) {}

  const received = /Input #0, flv/.test(sinkLog);
  console.log('publisher exit=' + code);
  console.log('sink received stream: ' + (received ? 'YES' : 'NO'));
  if (!received) {
    console.log('--- sink tail ---');
    console.log(sinkLog.split(/\r?\n/).slice(-15).join('\n'));
    console.log('--- publisher tail ---');
    console.log(pubLog.split(/\r?\n/).slice(-15).join('\n'));
  }
  return received;
}

async function main() {
  const which = process.argv[2] || 'all';
  const results = {};

  if (which === 'preview' || which === 'all') {
    const wide = path.join(outDir, 'preview-wide.png');
    const tall = path.join(outDir, 'preview-tall.png');
    for (const f of [wide, tall]) { try { fs.unlinkSync(f); } catch (_) {} }
    const ran = runOnce('preview frames (both canvases)',
      baseOpts({ previewWidePath: wide, previewTallPath: tall }), 'preview', 0);
    results.preview = ran && fs.existsSync(wide) && fs.existsSync(tall);
    for (const f of [wide, tall]) {
      if (fs.existsSync(f)) console.log(`${path.basename(f)} = ${fs.statSync(f).size} bytes`);
    }
  }

  if (which === 'record' || which === 'all') {
    const mp4 = path.join(outDir, 'record.mp4');
    try { fs.unlinkSync(mp4); } catch (_) {}
    const ran = runOnce('record 8s (720p wide canvas + mic)', baseOpts({ recordPath: mp4 }), 'live', 8);
    results.record = ran && decodes(mp4);
    if (fs.existsSync(mp4)) console.log('record.mp4 = ' + Math.round(fs.statSync(mp4).size / 1024) + ' KB, decodes: ' + decodes(mp4));
  }

  if (which === 'tee' || which === 'all') {
    const mp4 = path.join(outDir, 'tee.mp4');
    try { fs.unlinkSync(mp4); } catch (_) {}
    results.tee = await runTee(
      'simulcast 8s (RTMP sink + MP4 from one encode)',
      baseOpts({ recordPath: mp4, wideTargets: ['rtmp://127.0.0.1:1935/live/test'] }),
      8
    ) && decodes(mp4);
    if (fs.existsSync(mp4)) console.log('tee.mp4 = ' + Math.round(fs.statSync(mp4).size / 1024) + ' KB');
  }

  console.log('\n=== SUMMARY ===');
  for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v ? 'PASS' : 'FAIL'}`);
  process.exit(Object.values(results).every(Boolean) ? 0 : 1);
}

main();
