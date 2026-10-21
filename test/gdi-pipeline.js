const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { buildFfmpegArgs } = require('../src/pipeline');
const FF = path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe');
const OUT = path.join(process.env.TEMP, 'gdi-pipeline.mp4');
const URL = 'rtmp://127.0.0.1:1935/live/gdi';
try { fs.unlinkSync(OUT); } catch (_) {}
const sink = spawn(FF, ['-hide_banner','-loglevel','error','-listen','1','-i',URL,'-f','null','-'], { windowsHide: true });
setTimeout(() => {
  const args = buildFfmpegArgs({
    layout:'side', monitor:0, engine:'gdigrab', camera:'Integrated Camera',
    mic:'Microphone Array (Intel® Smart Sound Technology for Digital Microphones)',
    encoder:'libx264', bitrate:6000, fps:30, wideTargets:[URL], tallTargets:[], recordPath:OUT,
  }, 'live', { encoders:{h264_nvenc:false,h264_amf:false,h264_qsv:true,libx264:true}, ddagrab:true, gdigrab:true, tee:true });
  const p = spawn(FF, args, { windowsHide: true, stdio:['pipe','ignore','pipe'] });
  const t0 = Date.now();
  p.stderr.on('data', d => {
    const s = d.toString();
    for (const line of s.replace(/\r/g,'\n').split('\n')) {
      if (/frame=|Error|error|failed|Output #|Stream #0:0|Input #/.test(line) && line.trim()) {
        console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] ${line.trim()}`);
      }
    }
  });
  p.on('exit', c => {
    console.log('EXIT', c, 'mp4:', fs.existsSync(OUT) ? fs.statSync(OUT).size + 'b' : 'missing');
    try { sink.kill(); } catch(_) {}
    process.exit(0);
  });
  setTimeout(() => { console.log('--- q ---'); try { p.stdin.write('q'); p.stdin.end(); } catch(_){} }, 20000);
  setTimeout(() => { try { p.kill(); } catch(_){}; try { sink.kill(); } catch(_){}; console.log('HARD KILL'); process.exit(1); }, 28000);
}, 1800);



