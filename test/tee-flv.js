'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const FF = path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe');
const OUT = path.join(process.env.TEMP, 'tee-live.mp4');
const URL = 'rtmp://127.0.0.1:1935/live/tee';
try { fs.unlinkSync(OUT); } catch (_) {}

const sink = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', URL, '-f', 'null', '-'], {
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let sinkTail = '';
sink.stderr.on('data', (d) => { sinkTail += d.toString(); });

setTimeout(() => {
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30',
    '-f', 'lavfi', '-i', 'sine=f=440:r=48000',
    '-t', '5', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '4000k',
    '-c:a', 'aac', '-b:a', '160k',
    '-f', 'tee',
    `[f=flv:onfail=ignore]${URL}|[f=mp4]${OUT.replace(/\\/g, '/')}`,
  ];
  const p = spawn(FF, args, { windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => { err += d.toString(); });
  p.on('exit', (code) => {
    console.log('ffmpeg exit:', code);
    if (err.trim()) console.log('stderr:\n' + err.trim().split(/\r?\n/).slice(-8).join('\n'));
    const ok = fs.existsSync(OUT);
    console.log('mp4 exists:', ok, ok ? fs.statSync(OUT).size + ' bytes' : '');
    console.log('sink got data:', /Input #0, flv/.test(sinkTail));
    try { sink.kill(); } catch (_) {}
    process.exit(ok ? 0 : 1);
  });
}, 1800);
