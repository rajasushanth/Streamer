# Mac → TV Movie Streamer

Stream any movie from your Mac to a TV or phone over HTTP. Browse your files in a web
control page, pick a video, press **Start**, then scan a QR code or type a short URL into
VLC on the TV. Nothing is copied — the player pulls the bytes directly, with full range
support (seeking works) and no 4 GB file-size limit.

Node + Express backend, a single-page vanilla-JS control UI (no framework, no build step).

## Features

- **Filesystem browser** — navigate folders (Up / Home / breadcrumbs), filter per folder.
  Lists folders and video files only; hides dotfiles and generated files.
- **HTTP range streaming** — correct `206 Partial Content`, suffix (`bytes=-N`) and open-ended
  (`bytes=start-`) ranges, plus `Last-Modified` / `ETag` / `If-Range`. Handles files well past 4 GB.
- **Short numeric links** — each file is served from `/<id>.<ext>` at the root (e.g.
  `/95145570.mkv`). The id is a 5–8 digit number derived from the file path, so it's stable per
  file and easy to type on a TV remote. `/<id>` without an extension works too.
- **Start / Stop per file** — a file is reachable only while its stream is started (requests
  return `409` otherwise). Stop also drops the player's live connection so playback halts.
- **Live status** — uptime, bytes sent, and connected-device count, updated while streaming.
- **Pinned control panel** — once a stream starts, its controls stay visible while you keep
  browsing; it also survives a page reload.
- **Subtitles** — sidecar subtitle files (`.srt/.ass/.vtt/.sub`) that share a video's name are
  detected and served; embedded subtitles are preserved when a file is optimized (below).
- **QR codes** — every file shows a scannable QR for its URL.
- **Lossless "optimize"** — one click losslessly remuxes a file to a seek-friendly MP4 so VLC can
  seek and resume reliably (see below). No re-encode, no quality loss.
- **Keep-awake** — prevents the Mac from sleeping while the server runs (via `caffeinate`).
- **Auto-cleanup** — generated files are removed on Stop and shutdown, leaving only your originals.
- **Logging** — a structured app log plus a per-request access log; graceful shutdown that never hangs.

## Requirements

- macOS with **Node.js 18+**.
- **ffmpeg** (optional) — only needed for the lossless "optimize" feature. The app runs fine
  without it; the Optimize button is simply disabled.
- A TV (or phone) with **VLC**, on the same Wi-Fi/LAN as the Mac.

## Install & run

```sh
npm install
npm start               # or: node server.js   (optional: PORT=8090 node server.js)
```

A `streamer` CLI wraps the lifecycle (start/stop, open the page, tail logs):

```
streamer --start      # start (or restart) the server + open the control page
streamer --stop       # stop the server (cleans up generated files)
streamer --restart
streamer --status     # running state, URLs, active streams
streamer --logs       # follow the app log
streamer --open       # open the control page
```

Bare words (`streamer start`, …) work too. To put it on your `PATH`, symlink it into a bin
directory already on `PATH`, e.g.:

```sh
ln -s "$PWD/streamer" ~/.local/bin/streamer
```

The server listens on port **8090** by default (override with `PORT`). Open
`http://localhost:8090/` on the Mac, or `http://<MAC_IP>:8090/` from a phone. The LAN IP is
auto-detected and used to build the URLs and QR codes.

## Using it

1. **Browse** to a movie and select it.
2. (Optional) Click **Make seek-friendly (lossless)** to prepare it for reliable seeking on the TV.
3. Press **Start streaming**.
4. On the TV, open **VLC → New stream**, enter the URL shown (or scan the QR on your phone), and
   **Play**. Seeking works.
5. Press **Stop** when done.

Keep the Mac and TV on the same Wi-Fi; prefer 5 GHz or a wired Mac for 4K. Make sure the macOS
firewall allows incoming connections so the TV can reach the server.

**Tip — a permanent URL for the TV:** URLs use the Mac's LAN IP, which your router can change
over time. To make it stick, add a **DHCP reservation** on the router (bind the Mac's Wi-Fi MAC
address — `networksetup -getmacaddress en0` — to a fixed IP). The stream URL then never changes.

## Lossless "optimize" (seek & resume)

VLC seeks and resumes unreliably when playing an MKV over HTTP — it can fall back to reading the
file from the start to reach a position, which looks like endless buffering. The fix is to remux
the file to **MP4 with `faststart`** (the index at the front), a container VLC seeks reliably over
HTTP.

- It's a **stream copy** — the audio and video are copied bit-for-bit, so there is **no re-encode
  and no quality loss**; only the container changes.
- **Format-adaptive:** detects the video codec and tags it appropriately (e.g. HEVC → `hvc1`,
  AV1 → `av01`); carries subtitles across, falling back to dropping incompatible (image-based)
  subtitle tracks.
- The optimized file is served automatically in place of the original while streaming, and is
  cleaned up afterward so only your originals remain at rest.
- Requires ffmpeg.

For the non-optimized case, the server also tunes HTTP keep-alive and uses large read chunks with
`TCP_NODELAY` so the player's buffer fills quickly; the throughput ceiling is your Wi-Fi link.

## HTTP API

```
GET  /api/info                      { ip, port, home, root, ffmpeg }
GET  /api/browse?path=              { path, parent, dirs[], files[] }   files carry id, ext,
                                    streamExt, optimized, subs[]
GET  /api/qr?text=                  PNG QR code
GET|HEAD /<id>(.ext)                stream by numeric id (video: 409 until started; subtitle: always)
GET|HEAD /stream?path=  /subs?path= direct-path routes
POST /api/stream/start  {token}     activate a stream
POST /api/stream/stop   {token?}    deactivate (drops connection + cleanup); no token = stop all
GET  /api/stream/status             { active:[ {id/name/size/optimized/uptimeMs/bytesSent/
                                    connections/live …} ], count }
POST /api/optimize      {token}     start the lossless remux
GET  /api/optimize/status?token=    { optimized, state, percent, error, available }
```

## Project layout

```
server.js            Express backend
public/index.html    control UI (vanilla JS + CSS)
streamer             CLI wrapper
start.sh / stop.sh   lifecycle scripts used by the CLI
package.json
logs/                runtime logs (gitignored)
aliases.json         numeric-id → path map (generated at runtime, gitignored)
```

## Limitations & security

- **Full filesystem access:** the browse and stream endpoints can serve any path reachable by the
  server to anyone on the LAN. This is fine on a trusted home network; confine it to a root
  directory before exposing it to an untrusted network.
- For reliable seeking/resuming of MKV files in VLC, use **Optimize**. 4K over slower Wi-Fi is
  bandwidth-limited regardless.

## Roadmap / ideas

- **Android version** — the phone as the server (a native app, or a Termux + Node reuse of this code).
- On-the-fly **1080p transcode** fallback for TVs that can't decode 4K 10-bit HEVC.
- **DLNA/UPnP** discovery so it appears in VLC's "Local Network" with no URL typing.
- Option to confine browsing to a root directory; a "recent files" list; a clickable native app wrapper.
