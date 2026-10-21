'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

/* --------------------------------------------------------------- constants */

const PLATFORMS = {
  youtube: { name: 'YouTube', color: '#ff0033', prefix: 'rtmp://a.rtmp.youtube.com/live2/' },
  twitch: { name: 'Twitch', color: '#9146ff', prefix: 'rtmp://live.twitch.tv/app/' },
  kick: { name: 'Kick', color: '#53fc18', prefix: 'rtmp://fa723fc1b171.global-contribute.live-video.net/app/' },
  x: { name: 'X', color: '#ffffff', prefix: 'rtmps://ingest.x.com:443/rtmp/' },
  custom: { name: 'Custom RTMP', color: '#8a8a94', prefix: '' },
};

/* 86x48 wireframes for the layout dock */
const R = (x, y, w, h, fill, rx = 2) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"/>`;
const SCR = (x, y, w, h) => R(x, y, w, h, '#33333c');
const CAM = (x, y, w, h) => {
  const cx = x + w / 2;
  const cy = y + h * 0.42;
  const r = Math.min(w, h) * 0.16;
  return (
    R(x, y, w, h, '#82828f') +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#101014" opacity=".5"/>` +
    `<path d="M${cx - r * 1.7} ${y + h * 0.95} q${r * 1.7} ${-r * 2} ${r * 3.4} 0" fill="#101014" opacity=".5"/>`
  );
};

const LAYOUTS = [
  { id: 'screen', name: 'Screen', thumb: SCR(3, 3, 80, 42) },
  { id: 'camera', name: 'Camera', thumb: CAM(3, 3, 80, 42) },
  { id: 'screen-cam', name: 'Screen + cam', thumb: SCR(3, 3, 80, 42) + CAM(58, 28, 22, 14) },
  { id: 'screen-cam-inv', name: 'Screen + cam inv', thumb: SCR(3, 3, 80, 42) + CAM(6, 6, 22, 14) },
  { id: 'screen-tile', name: 'Screen + tile', thumb: SCR(3, 3, 51, 42) + CAM(56, 3, 27, 42) },
  { id: 'screen-tile-inv', name: 'Screen + tile inv', thumb: CAM(3, 3, 27, 42) + SCR(32, 3, 51, 42) },
  { id: 'side', name: 'Side by side', thumb: SCR(3, 3, 39, 42) + CAM(44, 3, 39, 42) },
  { id: 'side-inv', name: 'Side by side inv', thumb: CAM(3, 3, 39, 42) + SCR(44, 3, 39, 42) },
  { id: 'screen-focus', name: 'Screen focus', thumb: SCR(3, 3, 80, 42) + CAM(6, 30, 18, 12) },
  { id: 'framed', name: 'Framed', thumb: R(3, 3, 80, 42, '#1b1b22') + CAM(19, 8, 48, 32) },
];

/* ------------------------------------------------------------------- state */

const state = {
  caps: null,
  videosDir: '',
  displays: [],
  devices: { video: [], audio: [] },
  layout: 'screen-cam',
  canvasMode: 'both',
  tab: 'program',
  destinations: [
    { id: 'd1', platform: 'youtube', canvas: 'wide', url: '', enabled: true },
    { id: 'd2', platform: 'twitch', canvas: 'tall', url: '', enabled: true },
  ],
  recordOn: true,
  recordPath: null,
  monitor: 0,
  engine: 'auto',
  camera: '',
  mic: '',
  encoder: 'auto',
  bitrate: 6000,
  resolution: '720p',
  camScale: 26,
  camFit: 'fill',
  live: false,
  startedAt: 0,
  timerId: null,
  applying: false,
  applyQueued: false,
  stopAfterApply: false,
  applyTimer: null,
  sessionRecordPath: null,
  previewBusy: false,
  previewQueued: false,
  sinkOn: false,
  ffmpegOk: true,
};

/* ------------------------------------------------------------------- utils */

function log(line) {
  const el = $('log');
  if (!el) return;
  el.textContent += line + '\n';
  const lines = el.textContent.split('\n');
  if (lines.length > 900) el.textContent = lines.slice(-800).join('\n');
  el.scrollTop = el.scrollHeight;
}

function openLog(open = true) {
  $('logDrawer').hidden = !open;
  if (open) $('log').scrollTop = $('log').scrollHeight;
  layoutStage();
}

function showToast(msg, ms = 2800) {
  const el = $('stageToast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

const layoutName = (id) => (LAYOUTS.find((l) => l.id === id) || LAYOUTS[0]).name;

const RES_DIMS = { '1080p': [1920, 1080], '720p': [1280, 720], '480p': [854, 480] };
const dimsFor = (r) => RES_DIMS[r] || RES_DIMS['720p'];

const ENC_ORDER = ['h264_nvenc', 'h264_amf', 'libx264'];
const ENC_NAMES = {
  h264_nvenc: 'NVIDIA NVENC',
  h264_amf: 'AMD AMF',
  h264_qsv: 'Intel Quick Sync',
  libx264: 'CPU x264',
};

function encoderChoice() {
  const e = state.caps && state.caps.encoders;
  if (!e) return null;
  if (state.encoder !== 'auto') return e[state.encoder] ? state.encoder : 'libx264';
  return ENC_ORDER.find((k) => e[k]) || 'libx264';
}

function encoderLabel() {
  const chosen = encoderChoice();
  if (!chosen) return 'Auto';
  const name = ENC_NAMES[chosen] || chosen;
  if (state.encoder !== 'auto') {
    return state.caps && state.caps.encoders[state.encoder] === false
      ? name + ' (not available — x264 fallback)'
      : name;
  }
  return 'Auto → ' + name;
}

const configuredDests = () => state.destinations.filter((d) => d.url.trim());
const activeDests = () => configuredDests().filter((d) => d.enabled);

function platformOf(url) {
  if (/youtube\.com/i.test(url)) return 'youtube';
  if (/twitch\.tv/i.test(url)) return 'twitch';
  if (/kick\.com|live-video\.net/i.test(url)) return 'kick';
  if (/x\.com|twitter\.com|pscp\.tv/i.test(url)) return 'x';
  return 'custom';
}

/* --------------------------------------------------------------- top bar */

function updateTop() {
  const dests = configuredDests();
  const on = dests.filter((d) => d.enabled).length;

  $('destDots').innerHTML = dests
    .map((d) => {
      const p = PLATFORMS[d.platform] || PLATFORMS.custom;
      return `<span class="dot ${d.enabled ? '' : 'off'}" style="background:${p.color}"></span>`;
    })
    .join('');

  $('onCount').textContent = `${on} of ${dests.length} on`;
  $('sceneSummary').textContent =
    layoutName(state.layout) +
    ' · ' +
    (state.canvasMode === 'both' ? 'Horizontal + Vertical' : state.canvasMode === 'wide' ? 'Horizontal 16:9' : 'Vertical 9:16');

  $('btnRecord').classList.toggle('on', state.recordOn);
  $('btnRecord').title = state.recordOn ? 'Recording is on — click to disable' : 'Recording is off — click to enable';

  const live = state.live;
  $('livePill').hidden = !live;
  if ($('livePill').lastChild) $('livePill').lastChild.nodeValue = state.applying ? 'APPLYING' : 'LIVE';
  $('livePill').classList.toggle('applying', state.applying);
  $('timer').hidden = !live;
  $('badgeWide').hidden = !live;
  $('badgeTall').hidden = !live;
  $('btnLive').classList.toggle('stop', live);
  $('btnLive').lastChild.textContent = live ? ' Stop' : ' Go Live';

  updateLabels();
  renderDockActive();
}

function updateLabels() {
  const wide = activeDests().filter((d) => d.canvas === 'wide').map((d) => PLATFORMS[d.platform].name);
  const tall = activeDests().filter((d) => d.canvas === 'tall').map((d) => PLATFORMS[d.platform].name);
  $('labelWide').textContent = wide.length ? wide.join(', ') : 'not assigned';
  $('labelTall').textContent = tall.length ? tall.join(', ') : 'not assigned';
  $('labelWide').style.color = wide.length ? '' : '#4f4f59';
  $('labelTall').style.color = tall.length ? '' : '#4f4f59';
}

/* -------------------------------------------------------------------- dock */

function renderDock() {
  $('dock').innerHTML = LAYOUTS.map(
    (l, i) => `
    <button class="dock-item ${l.id === state.layout ? 'active' : ''}" data-layout="${l.id}" title="${esc(l.name)}">
      <div class="thumb">
        <span class="num">${i + 1}</span>
        <svg viewBox="0 0 86 48">${l.thumb}</svg>
      </div>
      <span class="name">${esc(l.name)}</span>
    </button>`
  ).join('');

  $('dock').querySelectorAll('.dock-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.layout = btn.dataset.layout;
      renderDock();
      updateTop();
      renderPanel();
      settingsChanged(500);
    });
  });
}

function renderDockActive() {
  $('dock').querySelectorAll('.dock-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.layout === state.layout);
  });
}

/* ------------------------------------------------------------- side panels */

function renderPanel() {
  const titles = {
    program: ['Program', 'Session and canvas status'],
    destinations: ['Destinations', 'Where this take goes'],
    sources: ['Sources', 'Display, camera and microphone'],
    audio: ['Audio', 'Microphone and system sound'],
    settings: ['Settings', 'Encoder, quality and recording'],
  };
  const [title, sub] = titles[state.tab] || titles.program;

  const body =
    state.tab === 'program' ? programPanel() :
    state.tab === 'destinations' ? destinationsPanel() :
    state.tab === 'sources' ? sourcesPanel() :
    state.tab === 'audio' ? audioPanel() :
    settingsPanel();

  $('side').innerHTML = `
    <div class="side-head">
      <div class="side-title">${title}</div>
      <div class="side-sub">${sub}</div>
    </div>
    <div class="side-body">${body}</div>`;

  wirePanel();
  updateTop();
}

function programPanel() {
  const wide = activeDests().filter((d) => d.canvas === 'wide');
  const tall = activeDests().filter((d) => d.canvas === 'tall');
  const status = state.live
    ? `<div class="big-status live"><i></i>Live · ${fmtTime(Date.now() - state.startedAt)}</div>`
    : `<div class="big-status ready"><i></i>Studio ready</div>`;

  return `
    ${status}
    <div class="hint" style="margin-top:8px">
      ${state.live
        ? 'Streaming now. The stage keeps the last rendered frame while the camera is busy.'
        : 'Render a preview to see exactly what each canvas will send.'}
    </div>

    <div class="divider"></div>
    <div class="kv"><span>Layout</span><span>${esc(layoutName(state.layout))}</span></div>
    <div class="kv"><span>Canvas</span><span>${dimsFor(state.resolution)[0]}×${dimsFor(state.resolution)[1]} / ${dimsFor(state.resolution)[1]}×${dimsFor(state.resolution)[0]}</span></div>
    <div class="kv"><span>Horizontal 16:9</span><span>${wide.length ? esc(wide.map((d) => PLATFORMS[d.platform].name).join(', ')) : '—'}</span></div>
    <div class="kv"><span>Vertical 9:16</span><span>${tall.length ? esc(tall.map((d) => PLATFORMS[d.platform].name).join(', ')) : '—'}</span></div>
    <div class="kv"><span>Record</span><span>${state.recordOn ? 'On' : 'Off'}</span></div>
    <div class="kv"><span>Encoder</span><span>${esc(encoderLabel())}</span></div>
    <div class="kv"><span>Bitrate</span><span>${state.bitrate} kbps</span></div>

    <div class="divider"></div>
    <button class="btn wide" id="btnRender" ${state.live ? 'disabled' : ''}>Render preview</button>
    <div class="hint" style="margin-top:8px" id="previewHint">
      ${state.live ? 'Preview is paused while live.' : 'Previews re-render automatically when you change a layout or source.'}
    </div>

    <div class="divider"></div>
    <div class="col-label">Recording file</div>
    <div class="hint ellipsis" style="margin-bottom:8px">${esc(state.recordPath || 'Videos folder · automatic name')}</div>
    <div class="row">
      <button class="btn sm" id="btnRecPath">Choose…</button>
      <button class="btn sm" id="btnOpenRec" ${state.recordPath ? '' : 'disabled'}>Open folder</button>
    </div>`;
}

function destinationsPanel() {
  const cards = state.destinations
    .map((d) => {
      const p = PLATFORMS[d.platform];
      return `
      <div class="dest-card" data-dest="${d.id}">
        <div class="dest-top">
          <button class="toggle ${d.enabled ? 'on' : ''}" data-act="toggle" title="Enable"></button>
          <span class="dest-plat"><i class="pdot" style="background:${p.color}"></i>
            <select class="dest-canvas" data-act="platform" style="width:auto;padding:2px 4px;font-size:9px">
              ${Object.entries(PLATFORMS).map(([k, v]) => `<option value="${k}" ${k === d.platform ? 'selected' : ''}>${v.name}</option>`).join('')}
            </select>
          </span>
          <select class="dest-canvas" data-act="canvas">
            <option value="wide" ${d.canvas === 'wide' ? 'selected' : ''}>16:9</option>
            <option value="tall" ${d.canvas === 'tall' ? 'selected' : ''}>9:16</option>
          </select>
          <button class="dest-x" data-act="remove" title="Remove">✕</button>
        </div>
        <input class="dest-url" data-act="url" spellcheck="false"
               placeholder="${esc(p.prefix || 'rtmp://server/app/STREAM_KEY')}"
               value="${esc(d.url)}" />
      </div>`;
    })
    .join('');

  return `
    <div class="dest-list">${cards}</div>
    <div class="row" style="margin-top:10px">
      <button class="btn sm" id="btnAddDest">+ Add destination</button>
      <button class="btn sm" id="btnSink">${state.sinkOn ? 'Stop test sink' : 'Local test sink'}</button>
    </div>
    <div class="hint" style="margin-top:10px">
      Paste the full RTMP URL including the stream key. Pick 16:9 for YouTube, 9:16 for Shorts, Reels and TikTok.
      One dead endpoint never stops the others.
    </div>`;
}

function sourcesPanel() {
  const displays = state.displays
    .map((d) => `<option value="${d.index}" ${d.index === state.monitor ? 'selected' : ''}>Display ${d.index + 1} — ${d.width}×${d.height}${d.primary ? ' (primary)' : ''}</option>`)
    .join('');
  const cams = [`<option value="">No camera</option>`]
    .concat(state.devices.video.map((n) => `<option value="${esc(n)}" ${n === state.camera ? 'selected' : ''}>${esc(n)}</option>`))
    .join('');
  const mics = [`<option value="">No microphone</option>`]
    .concat(state.devices.audio.map((n) => `<option value="${esc(n)}" ${n === state.mic ? 'selected' : ''}>${esc(n)}</option>`))
    .join('');

  return `
    <div class="field"><label>Display</label><select id="selMonitor">${displays || '<option>No display</option>'}</select></div>
    <div class="field"><label>Capture engine</label>
      <select id="selEngine">
        <option value="auto" ${state.engine === 'auto' ? 'selected' : ''}>Auto (DXGI when available)</option>
        <option value="ddagrab" ${state.engine === 'ddagrab' ? 'selected' : ''}>DXGI — GPU, fastest</option>
        <option value="gdigrab" ${state.engine === 'gdigrab' ? 'selected' : ''}>GDI — maximum compatibility</option>
      </select>
    </div>
    <div class="field"><label>Camera</label><select id="selCamera">${cams}</select></div>
    <div class="field">
      <label>Camera ratio <span class="dim" id="camPctVal">${state.camScale}%</span></label>
      <input type="range" id="rngCam" min="12" max="50" step="1" value="${state.camScale}">
      <div class="hint">Overlay size, and the camera share in side-by-side layouts.</div>
    </div>
    <div class="field"><label>Camera fit</label>
      <div class="chips" id="camFitChips">
        <button class="chip ${state.camFit === 'fill' ? 'active' : ''}" data-fit="fill"><span class="box"></span>Fill</button>
        <button class="chip ${state.camFit === 'fit' ? 'active' : ''}" data-fit="fit"><span class="box"></span>Fit</button>
      </div>
    </div>
    <div class="field"><label>Microphone</label><select id="selMic">${mics}</select></div>
    <button class="btn sm" id="btnRefresh">Refresh devices</button>
    <div class="hint" style="margin-top:10px">
      Auto picks DXGI when the build supports it and falls back to GDI. Windows allows one camera reader at a time,
      which is why preview pauses while live.
    </div>`;
}

function audioPanel() {
  const mics = [`<option value="">No microphone</option>`]
    .concat(state.devices.audio.map((n) => `<option value="${esc(n)}" ${n === state.mic ? 'selected' : ''}>${esc(n)}</option>`))
    .join('');
  return `
    <div class="field"><label>Microphone</label><select id="selMic">${mics}</select></div>
    <div class="hint">Encoded as 48 kHz stereo AAC at 160 kbps.</div>
    <div class="divider"></div>
    <div class="col-label">System audio</div>
    <div class="hint">
      Windows has no loopback capture device by default. Enable “Stereo Mix” in Sound settings, or install
      VB-CABLE, then pick that device as the microphone.
    </div>
    <div class="divider"></div>
    <div class="col-label">Not in this build</div>
    <div class="hint">
      Per-source volume, mute and noise suppression are not implemented. Vidyst gets those from Apple Silicon
      audio processing; this build records the microphone as-is.
    </div>`;
}

function settingsPanel() {
  const enc = state.caps && state.caps.encoders;
  const [W, H] = dimsFor(state.resolution);
  const opt = (value, label) => {
    const missing = value !== 'auto' && enc && !enc[value];
    return `<option value="${value}" ${state.encoder === value ? 'selected' : ''}>${label}${missing ? ' — not available' : ''}</option>`;
  };
  return `
    <div class="field"><label>Canvas resolution</label>
      <select id="selResolution">
        <option value="720p" ${state.resolution === '720p' ? 'selected' : ''}>720p — 1280×720 / 720×1280</option>
        <option value="1080p" ${state.resolution === '1080p' ? 'selected' : ''}>1080p — 1920×1080 / 1080×1920</option>
        <option value="480p" ${state.resolution === '480p' ? 'selected' : ''}>480p — 854×480 / 480×854</option>
      </select>
    </div>
    <div class="hint" style="margin-top:-4px;margin-bottom:12px">
      ${W}×${H} horizontal and ${H}×${W} vertical. 720p is the default because one CPU encode has to
      keep up in real time; 1080p needs a working hardware encoder.
    </div>
    <div class="field"><label>Encoder</label>
      <select id="selEncoder">
        ${opt('auto', 'Auto (hardware first)')}
        ${opt('h264_nvenc', 'NVIDIA NVENC')}
        ${opt('h264_amf', 'AMD AMF')}
        ${opt('h264_qsv', 'Intel Quick Sync')}
        ${opt('libx264', 'CPU — libx264')}
      </select>
    </div>
    <div class="hint" style="margin-top:-4px">
      Active: ${esc(encoderLabel())}. Hardware encoders are tested with a real encode at startup —
      a codec built into ffmpeg still fails if the machine has no matching GPU or driver.
    </div>
    <div class="field"><label>Bitrate per canvas (kbps)</label>
      <input id="inpBitrate" type="number" min="1000" max="40000" step="500" value="${state.bitrate}" />
    </div>
    <div class="kv"><span>Horizontal canvas</span><span>${W} × ${H} · 30 fps</span></div>
    <div class="kv"><span>Vertical canvas</span><span>${H} × ${W} · 30 fps</span></div>
    <div class="kv"><span>Recording</span><span>Same encode as the stream · MP4</span></div>

    <div class="divider"></div>
    <div class="col-label">Recording file</div>
    <div class="hint ellipsis" style="margin-bottom:8px">${esc(state.recordPath || 'Videos folder · automatic name')}</div>
    <div class="row">
      <button class="btn sm" id="btnRecPath">Choose…</button>
      <button class="btn sm" id="btnOpenRec" ${state.recordPath ? '' : 'disabled'}>Open folder</button>
    </div>

    <div class="divider"></div>
    <div class="col-label">Not in this build</div>
    <div class="hint">
      Guest links, unified chat, animated elements, backgrounds, 4K recording, crash-safe chunking,
      custom layouts and the virtual camera. The core loop — capture once, compose wide and tall,
      simulcast and record — is fully working.
    </div>`;
}

function wirePanel() {
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

  on('btnRender', 'click', () => renderPreview());
  on('btnRecPath', 'click', pickRecordPath);
  on('btnOpenRec', 'click', () => state.recordPath && window.api.openFolder(state.recordPath));
  on('btnRefresh', 'click', refreshDevices);
  on('btnAddDest', 'click', addDestination);
  on('btnSink', 'click', toggleSink);

  on('selMonitor', 'change', (e) => { state.monitor = Number(e.target.value); settingsChanged(); });
  on('selEngine', 'change', (e) => { state.engine = e.target.value; settingsChanged(); });
  on('selCamera', 'change', (e) => { state.camera = e.target.value; settingsChanged(); });
  on('selMic', 'change', (e) => { state.mic = e.target.value; settingsChanged(); });
  on('rngCam', 'input', (e) => {
    state.camScale = Math.max(12, Math.min(50, Number(e.target.value) || 26));
    const v = $('camPctVal');
    if (v) v.textContent = state.camScale + '%';
  });
  on('rngCam', 'change', () => settingsChanged(300));
  const fitChips = $('camFitChips');
  if (fitChips) {
    fitChips.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        state.camFit = chip.dataset.fit;
        renderPanel();
        settingsChanged(300);
      });
    });
  }
  on('selResolution', 'change', (e) => {
    state.resolution = e.target.value;
    renderPanel();
    settingsChanged(300);
  });
  on('selEncoder', 'change', (e) => {
    state.encoder = e.target.value;
    const enc = state.caps && state.caps.encoders;
    if (state.encoder !== 'auto' && enc && !enc[state.encoder]) {
      log(`${ENC_NAMES[state.encoder] || state.encoder} is not available on this machine; the pipeline will use CPU x264.`);
    }
    renderPanel();
    settingsChanged(300);
  });
  on('inpBitrate', 'change', (e) => {
    state.bitrate = Math.max(1000, Math.min(40000, Number(e.target.value) || 6000));
    e.target.value = state.bitrate;
    updateTop();
    renderPanel();
    settingsChanged(300);
  });

  document.querySelectorAll('[data-dest]').forEach((card) => {
    const d = state.destinations.find((x) => x.id === card.dataset.dest);
    if (!d) return;
    card.querySelectorAll('[data-act]').forEach((el) => {
      const act = el.dataset.act;
      if (act === 'toggle') {
        el.addEventListener('click', () => { d.enabled = !d.enabled; renderPanel(); settingsChanged(600); });
      } else if (act === 'platform') {
        el.addEventListener('change', () => {
          d.platform = el.value;
          const prefix = PLATFORMS[d.platform].prefix;
          if (prefix && !d.url.trim()) d.url = prefix;
          renderPanel();
          settingsChanged(600);
        });
      } else if (act === 'canvas') {
        el.addEventListener('change', () => { d.canvas = el.value; renderPanel(); settingsChanged(600); });
      } else if (act === 'remove') {
        el.addEventListener('click', () => {
          state.destinations = state.destinations.filter((x) => x.id !== d.id);
          renderPanel();
          settingsChanged(600);
        });
      } else if (act === 'url') {
        el.addEventListener('change', () => { d.url = el.value; renderPanel(); settingsChanged(600); });
        el.addEventListener('blur', () => { d.url = el.value; updateTop(); });
      }
    });
  });
}

/* ---------------------------------------------------------------- preview */

function schedulePreview(delay = 800) {
  clearTimeout(schedulePreview.t);
  schedulePreview.t = setTimeout(() => renderPreview(), delay);
}

function setSpinners(show) {
  ['spinWide', 'spinTall'].forEach((id) => { const el = $(id); if (el) el.hidden = !show; });
  ['emptyWide', 'emptyTall'].forEach((id) => {
    const el = $(id);
    if (el) el.querySelector('span').textContent = show ? 'Rendering the live graph…' : 'Render a preview to see this canvas';
  });
}

async function renderPreview() {
  if (state.live) return;
  // Boot renders panels before caps/devices arrive; a preview built then has no
  // capture engine or microphone and only produces a confusing ffmpeg error.
  if (!state.caps) return;
  if (state.previewBusy) { state.previewQueued = true; return; }

  state.previewBusy = true;
  setSpinners(true);
  try {
    const r = await window.api.preview(collect());
    if (!r.ok) {
      log('preview failed: ' + (r.error || 'unknown error'));
      openLog(true);
      return;
    }
    $('prevWide').src = r.wide;
    $('prevWide').hidden = false;
    $('prevTall').src = r.tall;
    $('prevTall').hidden = false;
    $('emptyWide').hidden = true;
    $('emptyTall').hidden = true;
  } catch (err) {
    log('preview error: ' + err.message);
    openLog(true);
  } finally {
    state.previewBusy = false;
    setSpinners(false);
    if (state.previewQueued) {
      state.previewQueued = false;
      renderPreview();
    }
  }
}

/* ------------------------------------------------------------- stage sizing */

function layoutStage() {
  const stage = $('stage');
  if (!stage) return;

  const availW = stage.clientWidth - 36;
  const availH = stage.clientHeight - 28;
  if (availW <= 0 || availH <= 0) return;

  const both = state.canvasMode === 'both';
  const gap = both ? 18 : 0;
  let cardH;

  if (both) cardH = Math.min(availH, (availW - gap) / (16 / 9 + 9 / 16));
  else if (state.canvasMode === 'wide') cardH = Math.min(availH, (availW * 9) / 16);
  else cardH = Math.min(availH, (availW * 16) / 9);

  cardH = Math.max(140, Math.floor(cardH));

  const wideW = Math.round((cardH * 16) / 9);
  const tallW = Math.round((cardH * 9) / 16);

  $('colWide').style.display = state.canvasMode === 'tall' ? 'none' : 'flex';
  $('colTall').style.display = state.canvasMode === 'wide' ? 'none' : 'flex';

  const setCard = (cardId, w) => {
    const el = $(cardId);
    el.style.width = w + 'px';
    el.style.height = cardH + 'px';
  };
  setCard('cardWide', wideW);
  setCard('cardTall', tallW);
}

/* -------------------------------------------------------------------- live */

function collect() {
  const engine = state.engine === 'auto' ? (state.caps && state.caps.ddagrab ? 'ddagrab' : 'gdigrab') : state.engine;
  const wide = activeDests().filter((d) => d.canvas === 'wide').map((d) => d.url.trim());
  const tall = activeDests().filter((d) => d.canvas === 'tall').map((d) => d.url.trim());

  return {
    layout: state.layout,
    monitor: state.monitor,
    engine,
    camera: state.camera || null,
    mic: state.mic || null,
    encoder: state.encoder,
    bitrate: state.bitrate,
    resolution: state.resolution,
    camScale: state.camScale,
    camFit: state.camFit,
    fps: 30,
    wideTargets: wide,
    tallTargets: tall,
    recordPath: state.recordOn ? state.sessionRecordPath || state.recordPath || defaultRecordPath() : null,
  };
}

function defaultRecordPath() {
  // Local time, not toISOString(): a UTC stamp makes recordings look hours old.
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return `${state.videosDir}\\Vidyst\\rec-${ts}.mp4`;
}

function openSheet() {
  const dests = configuredDests();
  $('sheetDests').innerHTML = dests.length
    ? dests.map((d) => {
        const p = PLATFORMS[d.platform];
        return `
        <div class="sheet-dest" data-sheet="${d.id}">
          <button class="toggle ${d.enabled ? 'on' : ''}"></button>
          <span class="pdot" style="background:${p.color}"></span>
          <span class="name">${esc(p.name)}</span>
          <span class="kind">${d.canvas === 'wide' ? '16:9' : '9:16'}</span>
        </div>`;
      }).join('')
    : '';

  $('sheetEmptyHint').hidden = dests.length > 0;
  $('sheetSummary').innerHTML = summaryHtml();
  $('sheetLayout').innerHTML =
    `<div class="kv"><span>Layout</span><span>${esc(layoutName(state.layout))}</span></div>` +
    `<div class="kv"><span>Canvas</span><span>${state.canvasMode === 'both' ? 'Horizontal + Vertical' : state.canvasMode === 'wide' ? 'Horizontal' : 'Vertical'}</span></div>`;

  const wide = activeDests().filter((d) => d.canvas === 'wide').length;
  const tall = activeDests().filter((d) => d.canvas === 'tall').length;
  const encodes = (wide ? 1 : 0) + (tall ? 1 : 0) + (state.recordOn ? 1 : 0);
  const mbps = (((wide ? 1 : 0) + (tall ? 1 : 0)) * state.bitrate) / 1000;
  $('sheetNote').textContent = `${dests.length} destination${dests.length === 1 ? '' : 's'} · ${encodes} encode${encodes === 1 ? '' : 's'} · ${mbps.toFixed(0)} Mbps`;
  $('sheetGo').disabled = !(wide + tall) && !state.recordOn;

  $('sheetDests').querySelectorAll('[data-sheet]').forEach((row) => {
    const d = state.destinations.find((x) => x.id === row.dataset.sheet);
    row.querySelector('.toggle').addEventListener('click', () => {
      d.enabled = !d.enabled;
      row.querySelector('.toggle').classList.toggle('on', d.enabled);
      $('sheetSummary').innerHTML = summaryHtml();
      updateTop();
      renderPanel();
    });
  });

  $('modal').hidden = false;
}

function summaryHtml() {
  const wide = activeDests().filter((d) => d.canvas === 'wide').map((d) => PLATFORMS[d.platform].name);
  const tall = activeDests().filter((d) => d.canvas === 'tall').map((d) => PLATFORMS[d.platform].name);
  return `
    <div class="kv"><span>Horizontal</span><span>${wide.length ? esc(wide.join(', ')) : '—'}</span></div>
    <div class="kv"><span>Vertical</span><span>${tall.length ? esc(tall.join(', ')) : '—'}</span></div>
    <div class="kv"><span>Record</span><span>${state.recordOn ? 'On' : 'Off'}</span></div>
    <div class="kv"><span>Encoder</span><span>${esc(encoderLabel())}</span></div>
    <div class="kv"><span>Bitrate</span><span>${state.bitrate} kbps</span></div>`;
}

function settingsChanged(delay = 600) {
  // While live, rebuild the ffmpeg graph with the new settings. That reconnects
  // the RTMP outputs for a few seconds, so coalesce rapid edits.
  if (state.live) {
    scheduleApply(900);
    return;
  }
  schedulePreview(delay);
}

function scheduleApply(delay = 900) {
  clearTimeout(state.applyTimer);
  state.applyTimer = setTimeout(applyLive, delay);
}

async function applyLive() {
  if (!state.live) return;
  if (state.applying) {
    state.applyQueued = true;
    return;
  }
  state.applying = true;
  updateTop();
  log('[apply] applying the new settings to the live session…');

  let r;
  try {
    r = await window.api.apply(collect());
  } catch (err) {
    r = { ok: false, error: err.message || String(err) };
  }

  state.applying = false;
  if (r && r.ok) {
    state.startedAt = r.startedAt || state.startedAt;
    log(`[apply] live stream reconnected (pid ${r.pid})`);
    showToast('Live settings applied — stream reconnected');
  } else if (r && r.busy) {
    state.applyQueued = true;
  } else {
    log('ERROR: ' + ((r && r.error) || 'could not apply the live settings'));
    openLog(true);
  }
  updateTop();

  if (state.applyQueued) {
    state.applyQueued = false;
    applyLive();
  } else if (state.stopAfterApply) {
    state.stopAfterApply = false;
    stopLive();
  }
}

async function startLive() {
  const opts = collect();
  if (!opts.wideTargets.length && !opts.tallTargets.length && !opts.recordPath) {
    log('Nothing to do: add a destination or enable recording.');
    openLog(true);
    return;
  }
  // Pin the auto-generated filename for this session so every live re-apply
  // keeps writing to the same take instead of creating a new one per change.
  if (opts.recordPath) state.sessionRecordPath = opts.recordPath;
  // Do not let a queued preview start after this point; it would grab the
  // camera while the live graph is opening it.
  clearTimeout(schedulePreview.t);
  for (const u of [...opts.wideTargets, ...opts.tallTargets]) {
    if (!/^rtmps?:\/\//i.test(u)) {
      log('Not an RTMP URL: ' + u);
      openLog(true);
      return;
    }
  }

  $('sheetGo').disabled = true;
  const r = await window.api.start(opts);
  if (!r.ok) {
    log('ERROR: ' + r.error);
    openLog(true);
    $('sheetGo').disabled = false;
    return;
  }
  $('modal').hidden = true;
  state.applying = false;
  state.applyQueued = false;
  state.stopAfterApply = false;
  clearTimeout(state.applyTimer);
  log(`session started (pid ${r.pid})`);
}

async function stopLive() {
  clearTimeout(state.applyTimer);
  if (state.applying) {
    state.stopAfterApply = true;
    return;
  }
  state.stopAfterApply = false;
  await window.api.stop();
  state.sessionRecordPath = null;
}

/* ------------------------------------------------------------------ events */

function wireGlobal() {
  $('btnRecord').addEventListener('click', () => {
    state.recordOn = !state.recordOn;
    updateTop();
    if (state.tab === 'program' || state.tab === 'settings') renderPanel();
    settingsChanged(600);
  });

  $('btnLive').addEventListener('click', () => {
    if (state.live) stopLive();
    else openSheet();
  });

  $('canvasChips').querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.canvasMode = chip.dataset.mode;
      $('canvasChips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      layoutStage();
      updateTop();
    });
  });

  document.querySelectorAll('.tool[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      document.querySelectorAll('.tool[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      renderPanel();
    });
  });

  $('btnLog').addEventListener('click', () => openLog($('logDrawer').hidden));
  $('btnClearLog').addEventListener('click', () => { $('log').textContent = ''; });
  const newLayoutBtn = $('btnNewLayout');
  if (newLayoutBtn) {
    newLayoutBtn.addEventListener('click', () => {
      log('Custom layouts are not part of this build. Ten built-in compositions are available in the dock.');
      openLog(true);
    });
  }

  $('sheetClose').addEventListener('click', () => { $('modal').hidden = true; });
  $('sheetCancel').addEventListener('click', () => { $('modal').hidden = true; });
  $('sheetGo').addEventListener('click', startLive);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').hidden = true; });

  window.addEventListener('resize', layoutStage);
  if (window.ResizeObserver) new ResizeObserver(() => layoutStage()).observe($('stage'));

  window.api.onLog((line) => log(line));
  window.api.onState((s) => {
    state.live = !!s.live;
    state.applying = !!s.applying;
    if (s.live) {
      state.startedAt = s.startedAt || state.startedAt || Date.now();
      if (!state.timerId) {
        state.timerId = setInterval(() => { $('timer').textContent = fmtTime(Date.now() - state.startedAt); }, 1000);
      }
      $('timer').textContent = fmtTime(Date.now() - state.startedAt);
    } else {
      clearInterval(state.timerId);
      state.timerId = null;
      if (s.exitCode !== undefined && s.exitCode !== null) $('timer').textContent = '00:00:00';
    }
    updateTop();
    renderPanel();
  });
}

/* -------------------------------------------------------------------- boot */

async function refreshDevices() {
  const d = await window.api.devices();
  state.devices = d;
  if (!state.camera && d.video[0]) state.camera = d.video[0];
  if (!state.mic && d.audio[0]) state.mic = d.audio[0];
  log(`devices: ${d.video.length} camera(s), ${d.audio.length} microphone(s)`);
  renderPanel();
}

async function pickRecordPath() {
  const p = await window.api.pickRecordPath();
  if (p) {
    state.recordPath = p;
    if (state.live) state.sessionRecordPath = p;
    renderPanel();
    settingsChanged(400);
  }
  return p;
}

function addDestination() {
  state.destinations.push({
    id: 'd' + Date.now(),
    platform: 'custom',
    canvas: 'wide',
    url: '',
    enabled: true,
  });
  renderPanel();
}

async function toggleSink() {
  if (!state.sinkOn) {
    const r = await window.api.sinkStart();
    if (!r.ok) {
      log('test sink failed: ' + r.error);
      openLog(true);
      return;
    }
    state.sinkOn = true;
    state.destinations.push({ id: 'sink', platform: 'custom', canvas: 'wide', url: r.url, enabled: true });
    log('local test sink listening at ' + r.url);
    renderPanel();
    settingsChanged(600);
  } else {
    await window.api.sinkStop();
    state.sinkOn = false;
    state.destinations = state.destinations.filter((d) => d.id !== 'sink');
    renderPanel();
    settingsChanged(600);
  }
}

async function boot() {
  renderDock();
  renderPanel();
  layoutStage();

  const info = await window.api.info();
  state.caps = info.caps;
  state.videosDir = info.videos || '';
  state.ffmpegOk = !!info.ffmpegPath;

  if (!state.ffmpegOk) {
    $('healthy').classList.add('bad');
    $('healthy').lastChild.textContent = ' No ffmpeg';
    log('FATAL: ffmpeg.exe not found. Expected vendor/ffmpeg/ffmpeg.exe');
    openLog(true);
    return;
  }

  log(`ffmpeg: ${info.ffmpegPath}`);
  if (info.caps) {
    const e = info.caps.encoders;
    log(
      'encoders: ' +
        Object.entries(e).map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`).join(' ') +
        ` ddagrab=${info.caps.ddagrab ? 'yes' : 'no'}`
    );
  }

  state.displays = await window.api.displays();
  await refreshDevices();
  renderPanel();
  layoutStage();

  schedulePreview(150);
}

wireGlobal();
// Diagnostics hook for the Playwright suite: lets tests assert on real state
// instead of only on pixels.
window.__vidyst = { state, collect, layoutName };
boot().catch((err) => {
  log('boot failed: ' + err.message);
  openLog(true);
});
