'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const FF = path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = process.env.TEMP;

function runCase(name, slaveOpts) {
  return new Promise((resolve) => {
    const out = path.join(TMP, name + '.mp4');
    try { fs.unlinkSync(out); } catch (_) {}
    const url = out.replace(/\\/g, '/');
    const args = [
      '-hide_banner', '-loglevel', 'info',
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30',
      '-f', 'lavfi', '-i', 'sine=f=440:r=48000',
      '-t', '2', '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
      '-f', 'tee', `[f=mp4${slaveOpts}]${url}`,
    ];
    const p = spawn(FF, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('exit', (code) => {
      const exists = fs.existsSync(out);
      console.log(`\n=== ${name} (exit ${code}) ===`);
      console.log('exists:', exists, exists ? fs.statSync(out).size + ' bytes' : '');
      const lines = err.split(/\r?\n/).filter((l) => /error|invalid|seek|output|stream|tee|mp4/i.test(l));
      console.log(lines.slice(-10).join('\n'));
      resolve();
    });
  });
}

(async () => {
  await runCase('tee-plain', '');
  await runCase('tee-frag', ':movflags=+frag_keyframe+empty_moov');
  await runCase('tee-faststart', ':movflags=+faststart');
})();
