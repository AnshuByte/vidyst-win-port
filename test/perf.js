'use strict';

/* Measures real encoding throughput for capture-graph combinations.
   Reports output frames, media seconds produced and wall time. */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { buildFfmpegArgs } = require('../src/pipeline');

const FF = path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe');
const CAM = 'Integrated Camera';
const MIC = 'Microphone Array (Intel® Smart Sound Technology for Digital Microphones)';
const caps = { encoders: { h264_nvenc: false, h264_amf: false, h264_qsv: false, libx264: true }, ddagrab: true, gdigrab: true, tee: true };

function trial(name, opts, seconds) {
  return new Promise((resolve) => {
    const out = path.join(process.env.TEMP, 'perf-' + name + '.mp4');
    try { fs.unlinkSync(out); } catch (_) {}
    const args = buildFfmpegArgs(
      { monitor: 0, encoder: 'libx264', bitrate: 6000, fps: 30, wideTargets: [], tallTargets: [], ...opts, recordPath: out },
      'live', caps
    );
    const p = spawn(FF, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let last = '';
    const t0 = Date.now();
    p.stderr.on('data', (d) => {
      const s = d.toString().replace(/\r/g, '\n');
      for (const line of s.split('\n')) if (line.includes('frame=')) last = line;
    });
    p.on('exit', () => {
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      const wall = (Date.now() - t0) / 1000;
      console.log(`\n=== ${name} ===`);
      console.log(`wall ${wall.toFixed(1)}s  file ${(size / 1024 / 1024).toFixed(2)} MB`);
      console.log(last.trim());
      resolve();
    });
    setTimeout(() => { try { p.stdin.write('q'); p.stdin.end(); } catch (_) {} }, seconds * 1000);
    setTimeout(() => { try { p.kill(); } catch (_) {} }, seconds * 1000 + 7000);
  });
}

(async () => {
  await trial('ddagrab-screen', { engine: 'ddagrab', layout: 'screen', camera: null, mic: MIC }, 8);
  await trial('ddagrab-side-cam', { engine: 'ddagrab', layout: 'side', camera: CAM, mic: MIC }, 8);
  await trial('gdi-screen', { engine: 'gdigrab', layout: 'screen', camera: null, mic: MIC }, 8);
  await trial('gdi-side-cam', { engine: 'gdigrab', layout: 'side', camera: CAM, mic: MIC }, 8);
  process.exit(0);
})();
