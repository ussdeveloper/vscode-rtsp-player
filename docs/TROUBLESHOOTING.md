# Troubleshooting

Start with the log: **RTSP Player: Show Log** (output channel) or
`%TEMP%\rtsp-player-logs\rtsp-player.log` (`$TMPDIR/rtsp-player-logs/rtsp-player.log` on
macOS/Linux). Credentials in URLs are redacted automatically.

## The panel opens but nothing happens

* The header should show a version marker (`v0.3.0`). If it is missing or older, VS Code is still
  running an older build — run **Developer: Reload Window**.
* If the panel shows “Failed to load the player (player.bundle.js)”, the webview bundle did not
  load. The log contains a `WARN: webview did not report ready in 5 s` line. Reinstall the
  extension (`.vsix`) and reload.

## Error immediately after Play

Run **RTSP Player: Run Self-test** with the same URL. It exercises ffmpeg and the HLS server
without the webview:

* self-test fails → the problem is ffmpeg/camera/credentials/network,
* self-test passes but the panel fails → the problem is on the webview side (attach the log; it
  contains `hls error …` entries).

## Self-test fails

| Log symptom | Cause / fix |
|---|---|
| `Cannot find "ffmpeg"` | ffmpeg missing: install it or set `rtspPlayer.ffmpegPath` |
| `401 Unauthorized`, `Operation not permitted` | wrong credentials, or the camera limits concurrent RTSP sessions — close other viewers/tabs |
| `Timed out waiting for data` with no stderr | camera unreachable, wrong port/path, firewall |
| `Non-monotonic DTS` warnings | camera timestamps are broken; use `rtspPlayer.videoMode: "transcode"` |
| `Connection reset by peer`, artefacts | UDP packet loss; switch `rtspPlayer.rtspTransport` from `udp` to `tcp` |

## Video plays but there is no sound

Most VS Code/Electron builds lack the AAC decoder in MSE. With the default
`rtspPlayer.audioMode: "auto"` the extension detects this and skips audio; the speaker button is
then disabled on purpose. Setting `audioMode: "on"` forces AAC but can break playback entirely in
those builds.

## Playback keeps buffering or drops

* Increase `rtspPlayer.segmentDuration` (e.g. 1.0) for unstable networks.
* `rtspPlayer.videoMode: "copy"` reduces CPU a lot, but requires H.264 video in the camera.
* High CPU with 4K cameras: lower the resolution with
  `rtspPlayer.extraFfmpegArgs: ["-vf","scale=1280:-2"]`.

## The camera refuses new connections

Many cameras allow only a few concurrent RTSP sessions. Each open tab keeps one ffmpeg session
alive, and the stream continues while the tab is hidden (`retainContextWhenHidden`). Close tabs
you do not need, and check the camera's session limit.

## I need the exact command line used

The log contains the full ffmpeg argument list (with the URL redacted) for every session attempt:

```
session <key>: args=-nostdin -hide_banner … -i rtsp://***@host:554/stream1 …
```

Copy it, put the real URL back, and run it in a terminal to reproduce outside VS Code.
