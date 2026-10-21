# Vidyst Win Port

A Windows take on Vidyst's core loop: **capture once, compose two canvases, record and simulcast.**

Built from scratch — Vidyst ships as an arm64-only macOS app (Swift + AppKit + a CoreMediaIO
camera extension), so there is no code to port. This is a behavioural reimplementation of the
part that matters: multi-destination live output with a wide and a tall canvas from one take.

---

## Quick start

1. Double-click **`VidystWinPort.exe`** (portable, nothing to install).
2. Pick your camera and microphone in **Sources** / **Audio**.
3. Choose a layout in the dock and a **canvas resolution** in **Settings** (720p is the default).
4. Add RTMP destinations (paste the full URL **including the stream key**).
5. **Go Live.** Recording is on by default and writes to `Videos\Vidyst`.

## Changing things while live

Layout, camera ratio, camera fit, capture engine, display, camera, microphone,
resolution, bitrate, encoder, destinations and the record toggle all stay
editable during a session. Applying one rebuilds the ffmpeg graph and
reconnects the RTMP outputs, so expect a **~2–4 second gap** on the platform
(the timer keeps running). Recording continues in a new part and the parts are
merged back into one MP4 when you stop, as long as the resolution did not
change. The stage keeps the last preview frame while live — the stream itself
uses the new settings.

The **Camera ratio** slider controls the picture-in-picture size and the
screen/camera split in the tile and side-by-side layouts. **Fill** crops the
camera to its tile; **Fit** letterboxes it so nothing is cut off.

## What works

| Feature | Status |
| --- | --- |
| Screen capture (full display) | ✅ DXGI Desktop Duplication (`ddagrab`), GDI fallback |
| Camera capture | ✅ DirectShow |
| Microphone | ✅ DirectShow |
| Wide 16:9 canvas | ✅ 1280×720 by default, 1920×1080 optional |
| Tall 9:16 canvas | ✅ 720×1280 by default, 1080×1920 optional |
| 10 layouts | ✅ screen, camera, PiP (±), tile (±), side-by-side (±), focus, framed |
| Simultaneous multi-destination RTMP | ✅ one encode per canvas, fanned out with `tee` |
| Per-destination canvas (wide or tall) | ✅ |
| Local recording (MP4) | ✅ same encode as the stream, muxed by `tee` |
| Hardware encoding | ✅ NVENC / AMF auto-detected, Quick Sync selectable |
| Frame preview | ✅ renders real frames through the live graph |
| Change layout / camera ratio / sources while live | ✅ rebuilds the graph, reconnects RTMP in ~2–4 s, recording parts merge on stop |
| Local RTMP test sink | ✅ verify the whole pipeline without a stream key |

## What does not work (and why)

| Vidyst feature | Why it's absent |
| --- | --- |
| Virtual camera | Requires a signed DirectShow/Media Foundation camera filter — a separate C++ project with driver signing |
| Browser guest links | Requires a LiveKit server, TURN relay and a hosted join page |
| Unified multi-platform chat | Requires OAuth apps and API credentials per platform |
| Remote control from iPhone/iPad | Requires the Bonjour service and a companion app |
| Stream Deck integration | Requires the Stream Deck host software |
| System audio capture | Windows exposes no loopback device by default; enable "Stereo Mix" or install VB-CABLE and pick it as the microphone |
| Crash-safe chunked recording | Recording is one MP4, finalized when you press Stop. A hard kill/blue screen truncates it. (A file left at ~0 bytes by a failed start is deleted automatically.) |
| Live preview while streaming | The camera can only be opened once; the stage keeps showing the last rendered frame during a live session. Changes still reach the stream (with a reconnect). |

---

## Requirements

- Windows 10/11 x64
- A camera and/or a display
- Stream keys from your platform (YouTube, Twitch, Kick, or any RTMP endpoint)

Nothing else — ffmpeg 9.0.2 is bundled inside the exe.

## Running from source

ffmpeg is **not** committed (the Windows build is ~100 MB). Put a build at
`vendor/ffmpeg/ffmpeg.exe` before running or packaging; a
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/) "essentials" build is what the
shipped exe uses (9.0.2).

```powershell
npm install
npm start
```

## Building the portable exe

```powershell
npm run dist
# -> dist\VidystWinPort.exe
```

## Tests

```powershell
# end-to-end UI + live stream + recording (drives the real Electron app)
node test/ui.test.js

# the packaged build (catches blank-window / missing-ffmpeg packaging bugs)
node test/packaged.test.js

# ffmpeg graph only: preview | record | tee | all
$env:CAM="Integrated Camera"; $env:MIC="Microphone Array (...)"
node test/verify.js all
```

Screenshots and the ffmpeg log from the UI run are written to
`%USERPROFILE%\Downloads\final vidyst win port exe\test screenshots`
(override with the `VIDYST_OUT` environment variable).

---

## Using it

1. **Canvas resolution** (Settings): 720p is the default because a single CPU encode has to keep
   up in real time. 1080p is available but needs a working hardware encoder or a fast CPU.
2. **Encoder** (Settings): *Auto* tries NVENC, then AMF, then CPU x264. Each hardware encoder is
   smoke-tested at startup with a real encode, so a codec that ffmpeg merely lists (but the GPU
   cannot run) is never selected. Quick Sync is deliberately **not** auto-selected — see
   Troubleshooting.
3. **Layout**: *Screen + cam* is the default. The dock has 10 layouts; changing one re-renders the
   preview automatically.
4. **Destinations**: set the canvas per row — *Wide 16:9* for YouTube, *Tall 9:16* for
   Shorts/Reels/TikTok. One dead endpoint does not stop the others (`onfail=ignore`).
5. **Recording**: on by default, wide canvas, `Videos\Vidyst\rec-<timestamp>.mp4`. The file is
   written by the same encoder that feeds the stream, so recording costs no extra CPU.
6. **Go Live**: starts one ffmpeg process; Stop sends `q` so both the MP4 and the RTMP streams are
   finalized cleanly.

### Verifying without stream keys

Click **Local test sink** in Destinations. It starts an RTMP listener on `127.0.0.1:1935` and adds
a destination pointing at it. Go Live and the log shows ffmpeg receiving the stream — proof the
whole pipeline works before you touch a real platform.

---

## Performance notes (measured on the reference laptop)

Reference machine: i7-1165G7, 4 cores / 8 threads, 16 GB, 1920×1080 display, Windows 11.

| Stage | Measured |
| --- | --- |
| DXGI capture at 720p | 30 fps, ~0.6 s CPU per 6 s |
| Pure x264 encode, 720p30 | ~36 fps (1.2× realtime) |
| Pure x264 encode, 1080p30 | ~22 fps (0.74× — cannot hold realtime) |
| Full 720p graph + encode | ~24–30 fps |
| Recording + RTMP | same cost as RTMP alone (single encode, `tee`) |

Consequences:

- **720p is the default for a reason.** On a CPU-only machine 1080p cannot sustain 30 fps.
- On this laptop NVENC and AMF are absent, and Quick Sync encodes at ~3 fps (it opens
  successfully but does not keep up), so *Auto* resolves to CPU x264.
- Compositing is done with `overlay` on the screen clock rather than `hstack`, so a slow camera
  cannot stall the stream. DirectShow timestamps (system uptime, ~10⁵ s) are rebased before
  compositing — without that the graph collapses to a few fps.

---

## Troubleshooting

**"ffmpeg.exe not found"** — `vendor/ffmpeg/ffmpeg.exe` is missing from the source tree. Re-run the
build, or drop a Windows ffmpeg build there.

**Black screen with DXGI** — switch *Capture engine* to **GDI**. Some remote-desktop / VM sessions
do not expose a usable D3D11 device.

**Quick Sync is very slow** — on some Intel laptops `h264_qsv` initialises but only manages a few
frames per second. Pick **CPU — libx264** in Settings; Auto already avoids QSV.

**Camera in use** — close other apps using it. Windows allows one DirectShow reader per device,
which is also why previews are paused while live.

**The preview shows the app itself** — display capture records the whole desktop, including this
window. Move the window to another monitor or minimize it if you do not want it in the stream (the
same behaviour as OBS display capture).

**Dropped frames** — use 720p, lower the bitrate, or select a hardware encoder. Each canvas that
has its own destinations costs one extra encode.

**Recording file is 0 bytes** — the previous run failed before the encoder opened; the app now
deletes unusable files on a failed start and logs why.

---

## Architecture

```
Electron main  ──  builds the ffmpeg argument list, owns the process
      │
      ├─ ddagrab / gdigrab ─┐
      ├─ dshow camera      ─┼─ filter_complex ─┬─ [wide] ─▶ encode ─▶ tee ─┬─▶ RTMP ×N
      └─ dshow mic         ─┘                  │                          └─▶ MP4 (record)
                                               └─ [tall] ─▶ encode ─▶ tee ───▶ RTMP ×N
```

One capture graph, two composed canvases, one encode per canvas. The `tee` muxer fans each encoded
stream out to every destination **and** the recorder, so streaming and recording share a single
encode. No cloud, no accounts, nothing leaves the machine except the streams you configure.

Key implementation details:

- `src/pipeline.js` — pure argument construction (layouts, resolutions, encoder choice, tee slaves).
- `src/main.js` — encoder probing with real smoke encodes, ffmpeg lifecycle, preview serialization,
  RTMP sink, IPC.
- `src/app.js` — renderer state, dock, panels, preview scheduling, Go Live.
- Filter outputs are consumed once; the geometry is expressed as `overlay` on a black canvas.
- Tee slave URLs must use forward slashes on Windows (`C:/...`), otherwise the tee parser chokes.
- `-c:v copy` cannot consume a complex-filtergraph output, hence the tee-based recorder.
