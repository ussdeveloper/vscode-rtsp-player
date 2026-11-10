# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
