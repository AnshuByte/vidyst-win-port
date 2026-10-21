'use strict';

/* Pure ffmpeg argument construction. No Electron dependency, so it can be
   exercised by test/pipeline.test.js without launching the app. */

const LAYOUTS = [
  { id: 'screen', name: 'Screen' },
  { id: 'camera', name: 'Camera' },
  { id: 'screen-cam', name: 'Screen + cam' },
  { id: 'screen-cam-inv', name: 'Screen + cam inverted' },
  { id: 'screen-tile', name: 'Screen + tile' },
  { id: 'screen-tile-inv', name: 'Screen + tile inverted' },
  { id: 'side', name: 'Side by side' },
  { id: 'side-inv', name: 'Side by side inverted' },
  { id: 'screen-focus', name: 'Screen focus' },
  { id: 'framed', name: 'Framed' },
];

const RESOLUTIONS = {
  '1080p': [1920, 1080],
  '720p': [1280, 720],
  '480p': [854, 480],
};

function canvasDims(resolution) {
  const [W, H] = RESOLUTIONS[resolution] || RESOLUTIONS['720p'];
  return { W, H, TW: H, TH: W };
}

function pickEncoder(caps, requested) {
  const usable = (caps && caps.encoders) || {};
  if (requested && requested !== 'auto') {
    // A codec can be compiled in but unusable on this machine; never hand
    // ffmpeg an encoder that failed its startup smoke test.
    return usable[requested] ? requested : 'libx264';
  }
  // QSV is intentionally not auto-selected: on some Intel machines it opens
  // successfully but only manages a few frames per second, which is worse than
  // x264. It stays available as an explicit choice in Settings.
  for (const name of ['h264_nvenc', 'h264_amf', 'libx264']) {
    if (usable[name]) return name;
  }
  return 'libx264';
}

function videoEncoderArgs(codec, bitrateKbps) {
  const b = `${bitrateKbps}k`;
  const buf = `${bitrateKbps * 2}k`;
  switch (codec) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'cbr',
        '-b:v', b, '-maxrate', b, '-bufsize', buf, '-pix_fmt', 'yuv420p', '-g', '60'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cbr',
        '-b:v', b, '-maxrate', b, '-bufsize', buf, '-pix_fmt', 'yuv420p', '-g', '60'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast',
        '-b:v', b, '-maxrate', b, '-bufsize', buf, '-pix_fmt', 'nv12', '-g', '60'];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-b:v', b, '-maxrate', b, '-bufsize', buf, '-pix_fmt', 'yuv420p', '-g', '60'];
  }
}

function audioEncoderArgs() {
  return ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'];
}

/**
 * Build the two canvas chains (wide 16:9 + tall 9:16) from one capture graph.
 */
function buildGraph(o) {
  const fps = o.fps || 30;
  const { W, H, TW, TH } = canvasDims(o.resolution);
  const filters = [];
  let inputIndex = 0;
  let screenLabel;
  let camLabel = null;

  if (o.engine === 'ddagrab') {
    // Capture straight at the wide canvas size: downloading a full 1080p BGRA
    // frame and scaling it on the CPU is the single most expensive step.
    filters.push(
      `ddagrab=output_idx=${o.monitor || 0}:draw_mouse=1:framerate=${fps}:video_size=${W}x${H},` +
      `hwdownload,format=bgra,setpts=PTS-STARTPTS,setsar=1[scr0]`
    );
    screenLabel = '[scr0]';
  } else {
    screenLabel = `[${inputIndex}:v]`;
    inputIndex += 1;
  }

  if (o.camera) {
    // DirectShow stamps frames with system uptime (hundreds of thousands of
    // seconds). Rebase them before compositing, otherwise overlay/hstack tries
    // to reconcile a ~7 day offset and the graph collapses to a few fps.
    filters.push(`[${inputIndex}:v]setpts=PTS-STARTPTS,setsar=1[cam0]`);
    camLabel = '[cam0]';
    inputIndex += 1;
  }

  let micLabel = null;
  if (o.mic) {
    // Not bracketed: this is a -map input specifier, not a filtergraph label.
    micLabel = `${inputIndex}:a`;
    inputIndex += 1;
  } else if (o.needAudio !== false) {
    micLabel = '[silence]';
    filters.push('anullsrc=r=48000:cl=stereo[silence]');
  }

  // A filter output can only feed one chain. When both canvases are built, give
  // each one its own split branch of the screen and camera.
  let screenFor = () => screenLabel;
  let camFor = () => camLabel;
  if (o.needWide !== false && o.needTall !== false) {
    filters.push(`${screenLabel}split=2[scrW][scrT]`);
    screenFor = (tag) => (tag === 'wide' ? '[scrW]' : '[scrT]');
    if (camLabel) {
      filters.push(`${camLabel}split=2[camW][camT]`);
      camFor = (tag) => (tag === 'wide' ? '[camW]' : '[camT]');
    }
  }

  const base = (label, w, h, tag) => {
    filters.push(
      `${label}scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[${tag}]`
    );
    return `[${tag}]`;
  };
  const cover = (label, w, h, tag) => {
    filters.push(
      `${label}scale=${w}:${h}:force_original_aspect_ratio=increase,` +
      `crop=${w}:${h},setsar=1[${tag}]`
    );
    return `[${tag}]`;
  };

  const layout = o.layout || 'screen-cam';

  const compose = (w, h, tag) => {
    const wide = w > h;
    const screenLabel = screenFor(tag);
    const cam = camFor(tag);

    // Camera overlay ratio. 26% matches the original design; the slider can go
    // down to 12% and up to 50%. "Fit" letterboxes the camera instead of
    // cropping it to the overlay's 16:9 box.
    const camPct = Math.max(12, Math.min(50, Number(o.camScale) || 26));
    const camFit = o.camFit === 'fit';
    const camPlace = (label, cw, ch, ctag) => (camFit ? base : cover)(label, cw, ch, ctag);
    const camTile = (cw0, ch0, ctag, pct = camPct) => {
      let cw;
      let ch;
      if (cw0 > ch0) {
        cw = Math.max(80, Math.round((cw0 * pct) / 100));
        ch = Math.round((cw * 9) / 16);
      } else {
        ch = Math.max(80, Math.round((ch0 * pct * 1.23) / 100));
        cw = Math.min(cw0, Math.round((ch * 16) / 9));
      }
      return camPlace(cam, cw, ch, ctag);
    };

    // Layouts that need a camera fall back to the screen when there is none.
    if (layout === 'screen' || (!cam && layout !== 'camera')) {
      const s = base(screenLabel, w, h, `s_${tag}`);
      filters.push(`${s}fps=${fps},format=yuv420p[${tag}]`);
      return `[${tag}]`;
    }

    if (layout === 'camera') {
      const c = cover(cam || screenLabel, w, h, `c_${tag}`);
      filters.push(`${c}fps=${fps},format=yuv420p[${tag}]`);
      return `[${tag}]`;
    }

    // picture-in-picture, bottom-right
    if (layout === 'screen-cam' || layout === 'screen-cam-inv') {
      const s = base(screenLabel, w, h, `s_${tag}`);
      const c = camTile(w, h, `c_${tag}`);
      const margin = wide ? Math.round(w * 0.025) : 0;
      const pos =
        layout === 'screen-cam'
          ? `W-w-${margin}:H-h-${margin}`
          : `${margin}:${margin}`;
      filters.push(`${s}${c}overlay=${pos},fps=${fps},format=yuv420p[${tag}]`);
      return `[${tag}]`;
    }

    // Two regions on a black canvas. The screen drives the frame clock, so a
    // camera that stalls at 5 fps cannot drag the whole stream down.
    const splitCanvas = (firstIsScreen, screenShare, tag) => {
      let sw, sh, cw, ch, sx, sy, cx, cy;
      if (wide) {
        sw = Math.round(w * screenShare);
        sh = h;
        cw = w - sw;
        ch = h;
        sx = firstIsScreen ? 0 : cw;
        sy = 0;
        cx = firstIsScreen ? sw : 0;
        cy = 0;
      } else {
        sw = w;
        sh = Math.round(h * screenShare);
        cw = w;
        ch = h - sh;
        sx = 0;
        sy = firstIsScreen ? 0 : ch;
        cx = 0;
        cy = firstIsScreen ? sh : 0;
      }
      const s = cover(screenLabel, sw, sh, `s_${tag}`);
      const c = camPlace(cam, cw, ch, `c_${tag}`);
      filters.push(`color=black:s=${w}x${h}:r=${fps}[bg_${tag}]`);
      filters.push(`[bg_${tag}]${s}overlay=${sx}:${sy}[t_${tag}]`);
      filters.push(`[t_${tag}]${c}overlay=${cx}:${cy},fps=${fps},format=yuv420p[${tag}]`);
      return `[${tag}]`;
    };

    // The camera ratio slider also shifts where the split sits.
    const sideShare = Math.max(0.35, Math.min(0.65, 0.5 + (26 - camPct) / 250));
    const tileShare = Math.max(0.55, Math.min(0.82, 1 - (camPct / 100) * 1.28));

    if (layout === 'screen-tile') return splitCanvas(true, tileShare, tag);
    if (layout === 'screen-tile-inv') return splitCanvas(false, tileShare, tag);
    if (layout === 'side') return splitCanvas(true, sideShare, tag);
    if (layout === 'side-inv') return splitCanvas(false, sideShare, tag);

    // screen focus: full screen with a small camera inset, bottom-left
    if (layout === 'screen-focus') {
      const s = base(screenLabel, w, h, `s_${tag}`);
      const c = camTile(w, h, `c_${tag}`, Math.max(12, camPct * 0.8));
      const margin = wide ? Math.round(w * 0.03) : 0;
      filters.push(`${s}${c}overlay=${margin}:H-h-${margin},fps=${fps},format=yuv420p[${tag}]`);
      return `[${tag}]`;
    }

    // framed: dimmed screen with a bordered camera card in the middle
    const s = base(screenLabel, w, h, `s_${tag}`);
    filters.push(`${s}eq=brightness=-0.28:saturation=0.85[sf_${tag}]`);
    const camW = wide ? Math.round(w * 0.64) : Math.round(w * 0.9);
    const camH = wide ? Math.round((camW * 9) / 16) : Math.round(h * 0.56);
    const c = camPlace(cam, camW, camH, `c_${tag}`);
    const x = Math.round((w - camW) / 2);
    const y = Math.round((h - camH) / 2);
    filters.push(
      `[sf_${tag}]${c}overlay=${x}:${y},` +
      `drawbox=x=${x - 3}:y=${y - 3}:w=${camW + 6}:h=${camH + 6}:color=white@0.22:t=2,` +
      `fps=${fps},format=yuv420p[${tag}]`
    );
    return `[${tag}]`;
  };

  const wideLabel = o.needWide === false ? null : compose(W, H, 'wide');
  const tallLabel = o.needTall === false ? null : compose(TW, TH, 'tall');

  return { filters, wideLabel, tallLabel, micLabel, inputIndex };
}

function buildFfmpegArgs(o, mode, caps) {
  const needWide = mode === 'preview' ? true : !!o.recordPath || (o.wideTargets || []).length > 0;
  const needTall = mode === 'preview' ? true : (o.tallTargets || []).length > 0;

  const args = ['-hide_banner', '-loglevel', 'info', '-stats'];
  // A still preview needs no audio at all; creating an unmapped anullsrc makes
  // ffmpeg abort with "output 0 (silence) unconnected".
  const g = buildGraph({ ...o, needWide, needTall, needAudio: mode !== 'preview' });

  if (o.engine !== 'ddagrab') {
    args.push('-f', 'gdigrab', '-framerate', String(o.fps || 30), '-draw_mouse', '1', '-i', 'desktop');
  }
  if (o.camera) {
    args.push('-thread_queue_size', '512', '-f', 'dshow', '-rtbufsize', '256M', '-i', `video=${o.camera}`);
  }
  if (o.mic && mode !== 'preview') {
    args.push('-thread_queue_size', '512', '-f', 'dshow', '-i', `audio=${o.mic}`);
  }

  let graph = g.filters.join(';');

  if (mode === 'preview') {
    // Skip the first ~0.8s so a warming-up camera has produced a real frame.
    graph +=
      `;${g.wideLabel}trim=start=0.8,setpts=PTS-STARTPTS[pw]` +
      `;${g.tallLabel}trim=start=0.8,setpts=PTS-STARTPTS[pt]`;
    args.push('-filter_complex', graph);
    args.push(
      '-map', '[pw]', '-frames:v', '1', '-update', '1', '-y', o.previewWidePath,
      '-map', '[pt]', '-frames:v', '1', '-update', '1', '-y', o.previewTallPath
    );
    return args;
  }

  const wideTargets = o.wideTargets || [];
  const tallTargets = o.tallTargets || [];
  const hasWideTee = wideTargets.length > 0;
  const hasWideRec = !!o.recordPath;

  args.push('-filter_complex', graph);

  const codec = pickEncoder(caps, o.encoder);
  const vArgs = videoEncoderArgs(codec, o.bitrate || 6000);
  const aArgs = audioEncoderArgs();

  // One encode per canvas. The tee muxer fans the encoded stream out to every
  // RTMP target and (when recording) to the MP4 file, so streaming + recording
  // costs the same CPU as streaming alone. `-c:v copy` is not an option here:
  // ffmpeg refuses streamcopy on a complex-filtergraph output.
  if (hasWideTee || hasWideRec) {
    args.push('-map', g.wideLabel, '-map', g.micLabel);
    if (hasWideTee && hasWideRec) {
      const slaves = wideTargets.map((u) => `[f=flv:onfail=ignore]${u}`);
      // The tee slave URL parser trips over "C:\"; forward slashes are safe.
      slaves.push(`[f=mp4]${o.recordPath.replace(/\\/g, '/')}`);
      args.push(...vArgs, ...aArgs, '-f', 'tee', slaves.join('|'));
    } else if (hasWideTee) {
      args.push(...vArgs, ...aArgs, '-f', 'tee',
        wideTargets.map((u) => `[f=flv:onfail=ignore]${u}`).join('|'));
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        ...aArgs, '-f', 'mp4', o.recordPath);
    }
  }
  if (tallTargets.length) {
    args.push('-map', g.tallLabel, '-map', g.micLabel, ...vArgs, ...aArgs,
      '-f', 'tee', tallTargets.map((u) => `[f=flv:onfail=ignore]${u}`).join('|'));
  }
  return args;
}

module.exports = {
  LAYOUTS,
  RESOLUTIONS,
  canvasDims,
  pickEncoder,
  videoEncoderArgs,
  audioEncoderArgs,
  buildGraph,
  buildFfmpegArgs,
};
