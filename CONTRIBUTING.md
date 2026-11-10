# Contributing

Thanks for taking the time to improve RTSP Player.

## Getting started

```bash
npm install
npm run watch      # rebuild on change (extension + webview bundle)
npm run typecheck
npm test
```

Press **F5** in VS Code to launch an Extension Development Host (the `Run Extension` launch
configuration builds first).

## Project layout

| Path | Purpose |
|---|---|
| `src/extension.ts` | activation, commands, URI handler |
| `src/panel.ts` | webview panel, HTML/CSP, message bridge |
| `src/session.ts` | one ffmpeg process per stream: lifecycle, watchdog, reconnect |
| `src/streamServer.ts` | loopback HLS server, playlist synthesis, access control |
| `src/ffmpeg.ts` | ffmpeg discovery and argument construction |
| `src/config.ts` | workspace settings → typed configuration |
| `src/log.ts` | output channel + file log with credential redaction |
| `src/selfTest.ts` | headless ffmpeg → server check |
| `media/player.js` | hls.js based player running inside the webview |
| `test/` | Node test runner suite for the HLS server |

## Guidelines

* Keep comments in English and only where the code is not self-explanatory.
* No network access other than the camera and `127.0.0.1`; no telemetry.
* Never log credentials — run URLs through `redact()` from `src/log.ts`.
* Add or update tests in `test/` for server behaviour changes (playlist synthesis, access control,
  CORS, segment serving).
* Run `npm run typecheck`, `npm test` and `npm run package` before opening a pull request.

## Commit messages

Conventional Commits are appreciated, e.g. `fix(server): synthesise playlist from segments`.

## Repository metadata

Before publishing, replace the placeholders:

* `"publisher": "local"` in `package.json` with your Marketplace publisher id,
* the `repository.url` placeholder with your real repository URL,
* `## [Unreleased]` entries in `CHANGELOG.md` as needed.

## Security

Please do not open public issues for security problems — see [SECURITY.md](SECURITY.md).
