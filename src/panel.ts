import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { readConfig } from './config';
import { log, redact } from './log';
import type { SessionUpdate } from './session';
import { RtspSession } from './session';

const HISTORY_KEY = 'rtspPlayer.recentUrls';
const HISTORY_LIMIT = 12;
const ALLOWED_PROTOCOLS = ['rtsp:', 'rtsps:', 'http:', 'https:', 'file:'];

/** Root of all ffmpeg output; also whitelisted as a webview resource root. */
function globalTmpRoot(): string {
  const root = path.join(os.tmpdir(), 'rtsp-player');
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    // Best effort; the panel still works without the resource-scheme fallback.
  }
  return root;
}

export function normalizeStreamUrl(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new Error('The URL is empty.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('This does not look like a valid URL.');
  }
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol "${parsed.protocol}".`);
  }
  return parsed.toString();
}

export function getRecentUrls(context: vscode.ExtensionContext): string[] {
  return context.globalState.get<string[]>(HISTORY_KEY, []);
}

async function rememberUrl(context: vscode.ExtensionContext, url: string): Promise<void> {
  const recent = getRecentUrls(context).filter((entry) => entry !== url);
  recent.unshift(url);
  await context.globalState.update(HISTORY_KEY, recent.slice(0, HISTORY_LIMIT));
}

export function describeStream(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const tail = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    return `RTSP ${tail ? `${host}/${tail}` : host}`.slice(0, 48);
  } catch {
    return 'RTSP Player';
  }
}

interface IncomingMessage {
  type?: string;
  url?: string;
  caps?: { aac?: boolean };
  level?: string;
  message?: string;
}

export class RtspPlayerPanel {
  private static readonly panels = new Set<RtspPlayerPanel>();
  private static active: RtspPlayerPanel | undefined;

  static createOrShow(context: vscode.ExtensionContext, url?: string): void {
    if (url) {
      for (const existing of RtspPlayerPanel.panels) {
        if (existing.currentUrl === url) {
          existing.panel.reveal();
          void existing.play(url);
          return;
        }
      }
    } else if (RtspPlayerPanel.active) {
      RtspPlayerPanel.active.panel.reveal();
      return;
    }
    new RtspPlayerPanel(context, url);
  }

  /**
   * State seam for automated checks and the self-test command.
   */
  static debugSnapshot(): { url?: string; state: string; webviewReady: boolean; audio: boolean } | undefined {
    return RtspPlayerPanel.active?.debugInfo;
  }

  static stopActive(): void {
    RtspPlayerPanel.active?.stopStream();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private session?: RtspSession;
  private currentUrl?: string;
  private webviewReady = false;
  private webviewCaps: { aac: boolean } = { aac: false };
  private readyWaiters: Array<() => void> = [];
  private audioEnabled = true;
  private playToken = 0;
  private lastUpdate: SessionUpdate = { state: 'stopped' };

  private constructor(
    private readonly context: vscode.ExtensionContext,
    url?: string,
  ) {
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const tmpRoot = vscode.Uri.file(globalTmpRoot());
    this.panel = vscode.window.createWebviewPanel(
      'rtspPlayer.panel',
      'RTSP Player',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot, tmpRoot],
      },
    );
    this.panel.iconPath = new vscode.ThemeIcon('device-camera-video');
    this.panel.webview.html = this.renderHtml(mediaRoot);
    log(`panel created (html=${this.panel.webview.html.length} chars)`);

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => void this.onMessage(message),
      null,
      this.disposables,
    );
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.active) {
          RtspPlayerPanel.active = this;
        }
      },
      null,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    RtspPlayerPanel.panels.add(this);
    RtspPlayerPanel.active = this;

    const readyWatchdog = setTimeout(() => {
      if (!this.webviewReady) {
        log('WARN: webview did not report ready in 5 s — bundle may not have loaded (CSP/localResourceRoots?)');
      }
    }, 5000);
    this.disposables.push(new vscode.Disposable(() => clearTimeout(readyWatchdog)));

    if (url) {
      void this.play(url);
    }
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }
    const msg = message as IncomingMessage;
    switch (msg.type) {
      case 'log':
        log(`[webview ${msg.level ?? 'info'}] ${msg.message ?? ''}`);
        break;
      case 'ready': {
        this.webviewReady = true;
        this.webviewCaps = { aac: message && typeof msg.caps?.aac === 'boolean' ? msg.caps.aac : false };
        log(`webview ready, caps.aac=${this.webviewCaps.aac}`);
        for (const resolve of this.readyWaiters.splice(0)) {
          resolve();
        }
        const recent = getRecentUrls(this.context);
        void this.panel.webview.postMessage({
          type: 'init',
          history: recent,
          lastUrl: this.currentUrl ?? recent[0] ?? '',
        });
        this.postUpdate(this.lastUpdate);
        break;
      }
      case 'play':
        if (typeof msg.url === 'string') {
          log(`play requested: ${redact(msg.url)}`);
          await this.play(msg.url);
        }
        break;
      case 'stop':
        this.stopStream();
        break;
      case 'settings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'rtspPlayer');
        break;
      default:
        break;
    }
  }

  private async play(rawUrl: string): Promise<void> {
    let url: string;
    try {
      url = normalizeStreamUrl(rawUrl);
    } catch (err) {
      this.postUpdate({
        state: 'error',
        message: 'Invalid URL',
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.stopSession();
    this.currentUrl = url;
    this.panel.title = describeStream(url);
    const playToken = ++this.playToken;
    await rememberUrl(this.context, url);

    // The webview reports which codecs it can decode; give it a moment so the
    // first attempt already picks the right audio mode.
    await this.waitForWebview(1500);
    if (this.playToken !== playToken) {
      return;
    }
    const config = readConfig();
    const audio = config.audioMode === 'on' || (config.audioMode === 'auto' && this.webviewCaps.aac);
    this.audioEnabled = audio;
    log(`audio=${audio} (mode=${config.audioMode}, webviewAac=${this.webviewCaps.aac})`);

    if (!this.webviewReady) {
      void this.panel.webview.postMessage({ type: 'init', history: getRecentUrls(this.context), lastUrl: url });
    }

    const session = new RtspSession(url, audio, (update) => {
      if (this.session !== session) {
        return;
      }
      if (update.state === 'playing' && update.streamUrl) {
        // Secondary transport: the webview's own resource scheme. It works even
        // when the webview is not allowed to reach 127.0.0.1.
        let fallbackUrl: string | undefined;
        try {
          fallbackUrl = this.panel.webview
            .asWebviewUri(vscode.Uri.file(path.join(session.outputDir, 'stream.m3u8')))
            .toString();
        } catch {
          fallbackUrl = undefined;
        }
        this.postUpdate({ ...update, fallbackUrl });
        return;
      }
      this.postUpdate(update);
    });
    this.session = session;
    void session.start();
  }

  private waitForWebview(timeoutMs: number): Promise<void> {
    if (this.webviewReady) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private stopStream(): void {
    this.playToken += 1;
    this.stopSession();
    this.postUpdate({ state: 'stopped' });
  }

  private stopSession(): void {
    const session = this.session;
    this.session = undefined;
    session?.stop();
  }

  private postUpdate(update: SessionUpdate): void {
    this.lastUpdate = update;
    if (!this.webviewReady) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'state', audio: this.audioEnabled, ...update });
  }

  /** For automated checks: current panel state and where the stream points. */
  get debugInfo(): { url?: string; state: string; webviewReady: boolean; audio: boolean } {
    return {
      url: this.currentUrl ? redact(this.currentUrl) : undefined,
      state: this.lastUpdate.state,
      webviewReady: this.webviewReady,
      audio: this.audioEnabled,
    };
  }

  private dispose(): void {
    this.stopSession();
    RtspPlayerPanel.panels.delete(this);
    if (RtspPlayerPanel.active === this) {
      RtspPlayerPanel.active = undefined;
    }
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private renderHtml(mediaRoot: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const version = (this.context.extension?.packageJSON?.version as string | undefined) ?? 'dev';
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'player.bundle.js'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `media-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource} http://127.0.0.1:*`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const fontsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'fonts.css'));

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>RTSP Player</title>
<link rel="stylesheet" href="${fontsUri}" />
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: 'Roboto', var(--vscode-font-family, system-ui), system-ui, sans-serif;
    font-size: 13px;
  }
  header {
    display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
    padding: 8px; border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
  }
  #url {
    flex: 1 1 240px; min-width: 140px; padding: 4px 6px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
    font-family: inherit; font-size: 12px;
  }
  #url:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button {
    padding: 4px 12px; border: none; border-radius: 2px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    font-family: inherit; font-size: 12px; font-weight: 500;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.icon { background: transparent; color: inherit; padding: 4px 6px; font-size: 14px; }
  button.icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  button:disabled, button.icon:disabled { opacity: .4; cursor: default; background: transparent; }
  .status {
    padding: 2px 10px; border-radius: 10px; font-size: 11px; letter-spacing: .02em;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .status.connecting { background: #8a6d1f; color: #fff; }
  .status.playing { background: #1f6f3f; color: #fff; }
  .status.error { background: var(--vscode-errorForeground); color: #fff; }
  .version { font-size: 10px; opacity: .55; align-self: center; }
  main { position: relative; flex: 1 1 auto; min-height: 0; background: #000; display: flex; }
  video { width: 100%; height: 100%; object-fit: contain; background: #000; }
  .overlay {
    position: absolute; inset: 0; display: flex; flex-direction: column; gap: 12px;
    align-items: center; justify-content: center; pointer-events: none;
    color: #d0d0d0; text-align: center; padding: 24px;
  }
  .overlay.hidden { display: none; }
  .spinner {
    width: 28px; height: 28px; border-radius: 50%;
    border: 3px solid rgba(255,255,255,.25); border-top-color: #4da3ff;
    animation: spin 1s linear infinite;
  }
  .overlay.hidden .spinner, .overlay.static .spinner { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  footer {
    max-height: 35%; overflow: auto; padding: 6px 8px; border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-textCodeBlock-background);
  }
  footer pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font-family: var(--vscode-editor-font-family); font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
</style>
</head>
<body>
  <header>
    <input id="url" type="text" list="history" spellcheck="false" autocomplete="off"
      placeholder="rtsp://user:password@192.168.1.10:554/stream1" />
    <datalist id="history"></datalist>
    <button id="play">Play</button>
    <button id="stop" class="secondary">Stop</button>
    <button id="mute" class="icon" title="Toggle audio">🔇</button>
    <span id="status" class="status">Idle</span>
    <span class="version">v${version}</span>
    <button id="settings" class="icon" title="RTSP Player settings">⚙</button>
  </header>
  <main>
    <video id="video" muted playsinline></video>
    <div id="overlay" class="overlay static">
      <div class="spinner"></div>
      <div id="overlayText">Enter a stream URL and press Play</div>
    </div>
    <div id="boot" class="overlay hidden">
      <div>Failed to load the player (player.bundle.js).</div>
      <div>Run the “RTSP Player: Show Log” command for details.</div>
    </div>
  </main>
  <footer id="details" hidden><pre id="detailsText"></pre></footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}">
    setTimeout(function () {
      if (!window.__rtspAlive) {
        var boot = document.getElementById('boot');
        if (boot) {
          boot.classList.remove('hidden');
          boot.classList.remove('static');
        }
      }
    }, 3000);
  </script>
</body>
</html>`;
  }
}
