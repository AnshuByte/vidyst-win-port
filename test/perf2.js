'use strict';

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
    const out = path.join(process.env.TEMP, 'p2-' + name + '.mp4');
    try { fs.unlinkSync(out); } catch (_) {}
    const args = buildFfmpegArgs(
      { monitor: 0, encoder: 'libx264', bitrate: 6000, fps: 30, wideTargets: [], tallTargets: [], ...opts, recordPath: out },
      'live', caps
    );
    const p = spawn(FF, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let last = '';
    p.stderr.on('data', (d) => {
      const s = d.toString().replace(/\r/g, '\n');
      for (const line of s.split('\n')) if (line.includes('frame=')) last = line;
    });
    p.on('exit', () => {
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      const m = last.match(/frame=\s*(\d+).*time=(\S+).*speed=\s*(\S+)/);
      console.log(`${name.padEnd(28)} frames=${m ? m[1] : '?'}  media=${m ? m[2] : '?'}  speed=${m ? m[3] : '?'}  size=${(size / 1048576).toFixed(2)}MB`);
      resolve();
    });
    setTimeout(() => { try { p.stdin.write('q'); p.stdin.end(); } catch (_) {} }, seconds * 1000);
    setTimeout(() => { try { p.kill(); } catch (_) {} }, seconds * 1000 + 6000);
  });
}

(async () => {
  const six = 6;
  await trial('screen-no-mic', { engine: 'ddagrab', layout: 'screen', camera: null, mic: null }, six);
  await trial('screen-mic', { engine: 'ddagrab', layout: 'screen', camera: null, mic: MIC }, six);
  await trial('screen-cam-no-mic', { engine: 'ddagrab', layout: 'screen-cam', camera: CAM, mic: null }, six);
  await trial('screen-cam-mic', { engine: 'ddagrab', layout: 'screen-cam', camera: CAM, mic: MIC }, six);
  await trial('side-no-mic', { engine: 'ddagrab', layout: 'side', camera: CAM, mic: null }, six);
  process.exit(0);
})();
