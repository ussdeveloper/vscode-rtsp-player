# Third-party notices

This project bundles the following third-party components.

## hls.js

* Version: see `package.json` (`dependencies`).
* License: Apache License 2.0.
* Usage: bundled into `media/player.bundle.js` and executed inside the VS Code webview.
* Project: <https://github.com/video-dev/hls.js>

## Roboto

* Files: `media/fonts/roboto-latin.woff2`, `media/fonts/roboto-latin-ext.woff2`.
* License: Apache License 2.0 (see <https://fonts.google.com/specimen/Roboto>).
* Usage: user interface font of the webview panel.

## ffmpeg

Not bundled. The extension expects an ffmpeg executable provided by the user
(see the README for installation instructions). ffmpeg is licensed under the
LGPL/GPL depending on the build; comply with the license of the build you use.
