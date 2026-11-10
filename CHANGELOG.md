# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] - 2026-11-10

### Fixed

- **Recent streams view did not pick up new URLs in a second window.** The change event only exists inside
  one extension host while `globalState` is shared, so the view now also re-reads the list whenever the
  window gains focus.
- `getRecentUrls()` tolerates a corrupted or non-array stored value instead of throwing.

### Added

- The tree provider logs `recent view: getChildren -> N recent + 2 actions` and every refresh, so
  `RTSP Player: Show Log` shows exactly what the view was asked to render.

## [0.4.2] - 2026-11-10

### Fixed

- **Recent URLs were only loaded once**, so a URL that was just played never showed up in the panel's
  autocomplete list. The extension now pushes a `history` message after every play and whenever the
  sidebar changes the list.
- **Temporary session directory was deleted while ffmpeg was still writing** (`failed to rename file …
  Operation not permitted`, `Error muxing a packet`). Cleanup now runs after ffmpeg has actually exited,
  so shutdown stays orderly and the camera session is still released with an RTSP `TEARDOWN`.
- Pressing Play gives immediate `Connecting…` feedback instead of waiting for the first async step.
- Connection resets (`Error number -10054`, "Invalid data found") now explain that the handshake was
  closed and suggest `rtspPlayer.rtspTransport: "udp"`.

### Changed

- Publisher set to `ussdeveloper`, repository URL points at the GitHub project.

## [0.4.1] - 2026-11-10

### Fixed

- **"Connecting…" forever / camera refusing the session.** ffmpeg was killed with `taskkill /F`, which leaves the
  RTSP session open on the camera; TP-Link/Tapo cameras then reject every new connection with
  `Operation not permitted` for 20–40 s. Measured: hard kill → new session refused for ~40 s;
  graceful quit → new session accepted immediately. ffmpeg now receives `q` on stdin (orderly shutdown with
  RTSP TEARDOWN) and is force-killed only after 1.5 s, so the camera is free right after Stop.
- Pressing **Play** on a stream that is already running reuses the session instead of restarting ffmpeg.
- Reconnect delays are now 3 s / 8 s / 20 s instead of a fixed 2 s, so a camera that is still releasing its
  previous session has time to recover.
- Errors from the camera are translated into actionable messages (`Operation not permitted`, 401, connection
  refused, timeouts); a slow connection reports "Still connecting… the camera may be busy".
- The log directory is re-created if it disappears while the host is running (logging no longer stops
  permanently after a failed write), and an exception in `play()` now surfaces as an error instead of
  leaving the panel on "Connecting…".
- The webview shows "No response from the extension host" if no state arrives within 25 s.

## [0.4.0] - 2026-11-10

### Added

- Activity Bar icon and a **Recent streams** view: quick actions (open stream, open from clipboard)
  and the last 12 URLs; click to play, inline trash icon to remove, refresh/clear in the view title.
- Tree labels show `host:port/path` only — credentials never appear in the view; tooltips are redacted.
- Commands `rtspPlayer.refreshRecent`, `rtspPlayer.removeRecent`, `rtspPlayer.clearRecent`.
- Shared recent-stream store (`src/streams.ts`) that notifies the view and the panel input history.

## [0.3.0] - 2026-11-10

### Changed

- All documentation, code comments, UI strings and log messages are now English.
- Neutral metadata: publisher set to the placeholder `local`, copyright held by
  "RTSP Player contributors".
- `rtspPlayer.open` accepts an optional URL argument (useful for automation and integration tests).

### Added

- `docs/ARCHITECTURE.md`, `docs/TROUBLESHOOTING.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `THIRD-PARTY-NOTICES.md`, editor/CI configuration.

## [0.2.0] - 2026-11-10

### Fixed

- **Streams failed to start on Windows.** The HLS server read ffmpeg's `stream.m3u8`; on Windows an
  open Node read handle blocks ffmpeg's atomic rename (`Operation not permitted`), so ffmpeg never
  published a playlist. The server now synthesises the playlist from completed segment files and
  never opens ffmpeg's playlist.
- Segments are written with `+temp_file`, so partially written segments are never served.
- External `vscode://…/play?url=` links did not activate the extension (`onUri` was missing).
- Playback failed with `bufferAppendError` in webviews without an AAC decoder; audio is now
  negotiated from the webview (`rtspPlayer.audioMode`, default `auto`).
- CORS/Private Network Access: preflight requests are answered, opaque (`null`) and loopback
  origins are reflected.

### Added

- Resource-scheme fallback URL when a webview cannot reach `127.0.0.1`.
- Watchdog and visible banner when `player.bundle.js` fails to load.
- `retry` for `video.play()` (autoplay can be interrupted).
- Logging to the “RTSP Player” output channel and to `%TEMP%\rtsp-player-logs\rtsp-player.log`,
  with credential redaction.
- Commands `rtspPlayer.selfTest` and `rtspPlayer.showLog`; version marker in the panel header.
- Bundled Roboto font (Apache-2.0) for the panel UI.

## [0.1.0] - 2026-11-10

### Added

- Initial version: RTSP → ffmpeg → HLS → loopback server → `hls.js` webview panel.
- Commands: open stream, open from clipboard, stop active stream, check ffmpeg.
- Settings: ffmpeg path, RTP transport, video mode, segment duration, connect timeout,
  reconnect count, extra ffmpeg arguments.
- Automatic reconnect and HLS server test suite.
