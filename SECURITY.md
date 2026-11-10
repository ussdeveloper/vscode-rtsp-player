# Security Policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's *Security* tab
(“Report a vulnerability”) instead of opening a public issue. Include:

* affected version,
* a minimal reproduction (configuration, camera/URL shape with credentials removed),
* the log excerpt from `%TEMP%\rtsp-player-logs\rtsp-player.log` (credential redacted by the extension).

You can expect an initial response within a few days.

## Threat model

RTSP Player runs locally and talks only to two places: the configured camera/NVR and a loopback
HTTP server it starts itself.

Implemented protections:

* **Loopback only** — the HLS server binds `127.0.0.1` on a random port.
* **Unguessable paths** — every stream session uses a random mount key (`/s/<key>/…`) that is
  removed when the session stops.
* **`Host` validation** — requests whose `Host` header is not `127.0.0.1`/`localhost` are rejected
  (DNS-rebinding protection).
* **Path hardening** — only `seg<digits>.ts` and `stream.m3u8` under the mount directory are served;
  path traversal is rejected.
* **CORS** — origins are reflected only for `vscode-webview://`, `null` (opaque webview origin) and
  loopback origins. A preflight response approves Private Network Access for those origins.
* **Credential redaction** — URLs are redacted (`***@`) before they reach the output channel or the
  log file. Note that recent stream URLs (including embedded credentials) are stored in the VS Code
  extension global state so the history is usable; use a camera account with minimal privileges.

Out of scope: a local attacker who can already read your user profile or memory.
