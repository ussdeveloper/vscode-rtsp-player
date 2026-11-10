# Architecture

## Goal

Show a live RTSP stream inside a VS Code tab. The VS Code webview (Electron) cannot open RTSP
streams, so the extension converts each stream to HLS on the fly and plays it with `hls.js`.

## Data path

```
          ┌──────────────────────── extension host (Node) ────────────────────────┐
 camera   │                                                                      │
   │  RTSP │   ffmpeg ──► seg00001.ts … segNNNNN.ts   (temp dir, temp_file flag)  │
   └──────►│      │                                                              │
           │      └──► stream.m3u8 (ffmpeg's own playlist — intentionally ignored)│
           │                                                                      │
           │   HLS server (127.0.0.1:<random port>)                               │
           │     GET /s/<key>/stream.m3u8  → synthesised from the *.ts listing     │
           │     GET /s/<key>/segNNNNN.ts  → served from disk                      │
           └──────────────────────────────────┬───────────────────────────────────┘
                                              │ HTTP (loopback)
          ┌───────────────────────────────────▼──────────────────────────────────┐
          │ webview (browser)                                                     │
          │   hls.js ──► MSE SourceBuffer ──► <video>                             │
          └───────────────────────────────────────────────────────────────────────┘
```

## Why the playlist is synthesised

ffmpeg writes its playlist atomically: `stream.m3u8.tmp` → `stream.m3u8`. On Windows, renaming over
a file that another process holds open fails with `ERROR_ACCESS_DENIED`; Node's `fs.readFile` opens
files without `FILE_SHARE_DELETE`, so a concurrent read made ffmpeg's rename fail
(`failed to rename file … Operation not permitted`) and no playlist was published.

Instead of reading that file:

1. ffmpeg runs with `+temp_file`, so an `*.ts` file only appears after it is complete,
2. the server lists the directory (`readdir`, which opens no file) and sorts `seg<digits>.ts`,
3. the response is a fresh playlist: `#EXT-X-MEDIA-SEQUENCE` = oldest retained segment,
   `#EXTINF` per segment, `#EXT-X-INDEPENDENT-SEGMENTS`.

This removes the race completely, never serves a truncated segment, and keeps the window aligned
with what ffmpeg's `delete_segments` keeps (10 segments ≈ 5 s at `segmentDuration = 0.5`).

## Session lifecycle (`src/session.ts`)

`RtspSession` owns exactly one ffmpeg process:

* every (re)start gets a new mount key, so the webview always reloads its source and stale
  segment requests cannot collide with a previous attempt,
* a 250 ms poll waits for the first complete segment; on timeout (default 20 s) the session fails
  with the tail of ffmpeg's stderr,
* ffmpeg's stderr is mirrored into the log (credentials redacted),
* unexpected exit triggers an automatic reconnect (`rtspPlayer.maxReconnects`, 2 s delay);
  the counter resets after 15 s of stable playback,
* stop/dispose kills the process tree (`taskkill /T /F` on Windows), unmounts the key and removes
  the temp directory; a `process.once('exit')` hook is a last-resort cleanup,
* state changes are reported to the panel: `connecting | playing | error | stopped`.

## Webview (`src/panel.ts`, `media/player.js`)

* Strict CSP: `default-src 'none'`, scripts only with a per-load nonce, `connect-src` limited to
  the webview resource host and `http://127.0.0.1:*`.
* `localResourceRoots` contains `media/` and the ffmpeg output root, which is what makes the
  resource-scheme fallback possible.
* The webview reports its capabilities on load (`MediaSource.isTypeSupported` for AAC), so the
  extension can decide between `-c:a aac` and `-an` before spawning ffmpeg.
* `hls.js` runs with `enableWorker: false` (no `worker-src` in the CSP) and a short live window
  (`liveSyncDurationCount: 2`).
* If the primary HTTP transport fails with a fatal network error, the player retries once with the
  resource-scheme URL (`fallbackUrl`), which bypasses CORS/PNA restrictions entirely.
* A watchdog in the HTML shows a banner if `player.bundle.js` never executes, and the panel logs a
  warning if the webview does not report `ready` within 5 s.

## HTTP server (`src/streamServer.ts`)

* Binds `127.0.0.1` on port 0 (random), one server per extension host, shared by all sessions.
* Rejects requests whose `Host` header is not loopback (DNS rebinding).
* Reflects `Origin` only for `vscode-webview://…`, `null`, and loopback origins; approves
  Private Network Access in `OPTIONS`.
* Serves only `stream.m3u8` and `seg<digits>.ts` inside the mounted directory.

## Logging (`src/log.ts`)

Writes to the “RTSP Player” output channel and appends to
`<tmp>/rtsp-player-logs/rtsp-player.log` (rotated at 2 MB). Every URL passes through `redact()`
before it is logged, so credentials never reach disk.

## Build

`esbuild` produces two artifacts:

* `dist/extension.js` — CommonJS, Node target, `vscode` external,
* `media/player.bundle.js` — IIFE for the webview with `hls.js` bundled in.

`npm run package` runs the production build (minified, no source maps) and creates the `.vsix`
with `@vscode/vsce`.
