# RTSP Player for VS Code

Watch **RTSP** streams (IP cameras, NVRs, DVRs) inside a VS Code tab — no external player,
no browser plug-in. The UI uses the bundled **Roboto** font.

The extension adds its own **icon in the Activity Bar** with a *Recent streams* view: click an entry
to play it, use the inline trash icon to forget it.

## How it works

VS Code webviews cannot play RTSP directly, so the extension does what any player does:

```
RTSP ──► ffmpeg ──► finished *.ts segments (temp) ──► local server 127.0.0.1:<random port> ──► hls.js ──► <video>
```

* ffmpeg pulls the stream (`-rtsp_transport tcp|udp`) and cuts it into 0.5 s HLS segments
  (`-hls_flags …+temp_file`, so a segment appears only after it is fully written),
* a loopback HTTP server (random port + random path key) **synthesises the playlist from the list of
  finished segments** instead of reading ffmpeg's own `stream.m3u8`. This is deliberate: on Windows an
  open read handle blocks ffmpeg's atomic rename (`Operation not permitted`) and the stream died,
* the webview plays HLS through `hls.js` + MSE. If the webview cannot reach `127.0.0.1`
  (CORS / Private Network Access), the player automatically falls back to a URL served through
  the VS Code resource scheme.

When the stream drops, ffmpeg is restarted automatically (`rtspPlayer.maxReconnects`).
Stopping a stream sends ffmpeg an orderly shutdown (`q` → RTSP `TEARDOWN`), so the camera frees its
session immediately — TP-Link/Tapo cameras otherwise refuse new connections for ~30 s after a hard kill.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Requirements

* **ffmpeg** in `PATH` — or point `rtspPlayer.ffmpegPath` at it.
  Windows: `winget install Gyan.FFmpeg` · macOS: `brew install ffmpeg` · Linux: `apt install ffmpeg`.
  Well-known install locations are detected, including the WinGet package directory.
  Verify with the **RTSP Player: Check ffmpeg** command.

## Usage

1. `Ctrl+Shift+P` → **RTSP Player: Open Stream…** (or click the camera icon in the Activity Bar → **Open Stream…**)
2. Paste a URL such as `rtsp://user:password@192.168.1.10:554/stream1` and confirm.
3. In the tab: **Play / Stop**, audio toggle, ⚙ opens settings. Double-click the video for fullscreen.

The **Recent streams** view lists the last 12 URLs. Labels never show credentials —
only `host:port/path`; clicking an item opens the stream, the trash icon removes it from history.
Quick actions (open stream, open from clipboard, refresh) are buttons in the view title, so an empty
history shows an explicit “No streams yet” panel instead of an empty list.

> History is stored per extension id in VS Code's `globalState`. Renaming the publisher starts a fresh
> list; the previous entries stay in the old id's state and are not migrated.

| Command | Action |
|---|---|
| `rtspPlayer.open` | Pick a recent stream or enter a new URL |
| `rtspPlayer.openUrl` | Open the URL from the clipboard |
| `rtspPlayer.stopActive` | Stop the active tab |
| `rtspPlayer.checkFfmpeg` | Verify that ffmpeg is available |
| `rtspPlayer.selfTest` | Headless check: ffmpeg → HLS server → fetch playlist and segment |
| `rtspPlayer.showLog` | Open the “RTSP Player” output channel |
| `rtspPlayer.refreshRecent` | Refresh the Recent streams view |
| `rtspPlayer.removeRecent` | Remove one entry from history |
| `rtspPlayer.clearRecent` | Clear the whole history (asks for confirmation) |

External links (activate the extension through `onUri`):
`vscode://ussdeveloper.rtsp-player/play?url=rtsp%3A%2F%2F...`

> The URI scheme follows `<publisher>.<name>` from `package.json`; it changes if you rename the publisher.

## Settings

| Setting | Default | Description |
|---|---|---|
| `rtspPlayer.ffmpegPath` | `ffmpeg` | Path to the ffmpeg executable |
| `rtspPlayer.rtspTransport` | `tcp` | `tcp` = reliable, `udp` = lower latency |
| `rtspPlayer.videoMode` | `transcode` | `transcode` = H.264 baseline (works everywhere), `copy` = no re-encode |
| `rtspPlayer.audioMode` | `auto` | `auto` = audio only when the webview decodes AAC, `on` = always AAC, `off` = `-an` |
| `rtspPlayer.segmentDuration` | `0.5` | HLS segment length in seconds |
| `rtspPlayer.connectTimeout` | `20` | Seconds to wait for the first segment |
| `rtspPlayer.maxReconnects` | `3` | Automatic reconnect attempts |
| `rtspPlayer.extraFfmpegArgs` | `[]` | Extra ffmpeg arguments, e.g. `["-vf","scale=1280:-2"]` |

**Latency:** shorter `segmentDuration` means lower latency but more CPU. Expect roughly 1–2 s
with 0.5 s segments.

## Diagnostics

* **RTSP Player: Show Log** — the “RTSP Player” output channel (session state, ffmpeg arguments,
  ffmpeg stderr, webview logs),
* the same log is always appended to `%TEMP%\rtsp-player-logs\rtsp-player.log`
  (`$TMPDIR/rtsp-player-logs/rtsp-player.log` on macOS/Linux); credentials in URLs are redacted (`***@`),
* **RTSP Player: Run Self-test** exercises ffmpeg and the HLS server without the webview,
* if `player.bundle.js` fails to load, the panel shows an explicit message instead of a dead UI,
* the panel header shows the running version (e.g. `v0.4.5`) — useful to confirm VS Code loaded
  the new build after an update.

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for common failures.

## Privacy and security

* Credentials embedded in a stream URL are kept in the recent-streams history (VS Code
  `globalState`) so the list is convenient. Use a camera account with minimal permissions.
* Nothing is sent anywhere: the extension only talks to the camera and to `127.0.0.1`.
* The HLS server listens on loopback only, mount keys are random, and the `Host` header is validated.
* Logs redact URL credentials before they reach any sink.

## Development

```bash
npm install
npm run watch         # esbuild in watch mode
# F5 → "Run Extension" (launch.json runs the build first)
npm run typecheck
npm test              # 9 HLS server tests (Node test runner + esbuild)
npm run package       # builds dist/ and media/player.bundle.js, then a .vsix
code --install-extension rtsp-player-0.4.5.vsix
```

Layout: `src/extension.ts` – activation and commands, `src/panel.ts` – webview,
`src/session.ts` – ffmpeg lifecycle, `src/streamServer.ts` – HLS server and playlist synthesis,
`src/streams.ts` – URL validation and the recent-stream store, `src/recentView.ts` – Activity Bar
tree view, `src/log.ts` – logging, `src/selfTest.ts` – self-test, `media/player.js` – player,
`media/fonts.css` + `media/fonts/` – Roboto, `media/rtsp.svg` – Activity Bar icon.

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: see [SECURITY.md](SECURITY.md).
Third-party notices: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Limitations

* H.265/HEVC in `copy` mode will not play in most webviews — use `transcode`.
* `transcode` uses CPU (about 10–25 % of one core for 1080p).
* Audio starts muted (autoplay policy). Some VS Code/Electron builds have no AAC decoder in MSE;
  audio is then skipped and the speaker button stays disabled while video keeps playing.
* `copy` mode inherits the camera timestamps; on `Non-monotonic DTS` warnings switch to `transcode`.
* The stream keeps running while the tab is hidden (`retainContextWhenHidden`). Close the tab to
  release ffmpeg.
* Cameras often limit concurrent RTSP sessions — close tabs you do not use.

