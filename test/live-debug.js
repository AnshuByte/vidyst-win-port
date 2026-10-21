'use strict';

/* Reproduces the app's live command against a local RTMP sink and prints
   ffmpeg's stderr, so failures are readable outside the UI. */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { buildFfmpegArgs } = require('../src/pipeline');

const FF = path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe');
const URL = 'rtmp://127.0.0.1:1935/live/debug';
const REC = path.join(process.env.USERPROFILE || '.', 'Videos', 'Vidyst', 'rec-debug.mp4');

fs.mkdirSync(path.dirname(REC), { recursive: true });
try { fs.unlinkSync(REC); } catch (_) {}

const caps = {
  encoders: { h264_nvenc: false, h264_amf: false, h264_qsv: false, libx264: true },
  ddagrab: true,
  gdigrab: true,
  tee: true,
};

const sink = spawn(FF, ['-hide_banner', '-loglevel', 'info', '-listen', '1', '-i', URL, '-f', 'null', '-'], {
  windowsHide: true,
});
sink.stderr.on('data', (d) => process.stdout.write('[sink] ' + d.toString()));

setTimeout(() => {
  const args = buildFfmpegArgs(
    {
      layout: 'side',
      monitor: 0,
      engine: 'ddagrab',
      camera: 'Integrated Camera',
      mic: 'Microphone Array (Intel® Smart Sound Technology for Digital Microphones)',
      encoder: 'auto',
      bitrate: 6000,
      fps: 30,
      wideTargets: [URL],
      tallTargets: [],
      recordPath: REC,
    },
    'live',
    caps
  );

  console.log('\n--- ffmpeg live ---\n');
  const p = spawn(FF, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  p.stderr.on('data', (d) => process.stdout.write(d.toString()));
  p.on('exit', (code, sig) => {
    console.log(`\n=== ffmpeg EXIT code=${code} sig=${sig} ===`);
    console.log('record file exists:', fs.existsSync(REC), fs.existsSync(REC) ? fs.statSync(REC).size + ' bytes' : '');
    try { sink.kill(); } catch (_) {}
    process.exit(0);
  });

  setTimeout(() => {
    console.log('\n=== sending q ===');
    try { p.stdin.write('q'); p.stdin.end(); } catch (_) {}
  }, 10000);

  setTimeout(() => {
    try { p.kill(); } catch (_) {}
    try { sink.kill(); } catch (_) {}
    console.log('\n=== hard kill (no exit within 20s) ===');
    process.exit(1);
  }, 20000);
}, 1800);
