import * as vscode from 'vscode';
import { readConfig } from './config';
import { probeFfmpeg } from './ffmpeg';
import { initLog, log, logHistory, showLog } from './log';
import { getRecentUrls, normalizeStreamUrl, RtspPlayerPanel } from './panel';
import { showSelfTest } from './selfTest';
import { disposeServer } from './streamServer';

async function promptForUrl(preset?: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: 'RTSP Player',
    prompt: 'Stream URL',
    placeHolder: 'rtsp://user:password@192.168.1.10:554/stream1',
    value: preset,
    ignoreFocusOut: true,
    validateInput: (input) => {
      if (!input.trim()) {
        return undefined;
      }
      try {
        normalizeStreamUrl(input);
        return undefined;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
  });
  if (!value || !value.trim()) {
    return undefined;
  }
  return value.trim();
}

async function pickStreamUrl(context: vscode.ExtensionContext): Promise<string | undefined> {
  const recent = getRecentUrls(context);
  if (recent.length === 0) {
    return promptForUrl();
  }

  const NEW_STREAM = '$(add) New stream…';
  const picked = await vscode.window.showQuickPick(
    [
      { label: NEW_STREAM, description: 'enter an RTSP URL' },
      ...recent.map((url) => ({ label: url, description: 'recent' })),
    ],
    { title: 'RTSP Player', placeHolder: 'Pick a stream or add a new one' },
  );
  if (!picked) {
    return undefined;
  }
  return picked.label === NEW_STREAM ? promptForUrl() : picked.label;
}

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  log(`activate (vscode ${vscode.version}, platform ${process.platform}, ffmpeg=${readConfig().ffmpegPath})`);

  context.subscriptions.push(
    vscode.commands.registerCommand('rtspPlayer.open', async (argument?: unknown) => {
      const url = typeof argument === 'string' ? argument : await pickStreamUrl(context);
      if (url) {
        RtspPlayerPanel.createOrShow(context, url);
      }
    }),

    vscode.commands.registerCommand('rtspPlayer.openUrl', async () => {
      const text = (await vscode.env.clipboard.readText()).trim();
      if (!text) {
        void vscode.window.showInformationMessage('The clipboard is empty.');
        return;
      }
      try {
        RtspPlayerPanel.createOrShow(context, normalizeStreamUrl(text));
      } catch (err) {
        void vscode.window.showErrorMessage(
          `The clipboard does not contain a valid URL: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand('rtspPlayer.stopActive', () => {
      RtspPlayerPanel.stopActive();
    }),

    vscode.commands.registerCommand('rtspPlayer.checkFfmpeg', async () => {
      try {
        const probe = await probeFfmpeg(readConfig());
        void vscode.window.showInformationMessage(`ffmpeg works: ${probe.version} — ${probe.path}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const choice = await vscode.window.showErrorMessage(
          `No working ffmpeg found: ${message}`,
          'Set path',
          'Download page',
        );
        if (choice === 'Set path') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'rtspPlayer.ffmpegPath');
        } else if (choice === 'Download page') {
          await vscode.env.openExternal(vscode.Uri.parse('https://ffmpeg.org/download.html'));
        }
      }
    }),

    vscode.commands.registerCommand('rtspPlayer.showLog', () => {
      showLog();
    }),

    vscode.commands.registerCommand('rtspPlayer.selfTest', async () => {
      const url = await pickStreamUrl(context);
      if (url) {
        await showSelfTest(url);
      }
    }),

    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        if (uri.path.replace(/\/+$/, '') !== '/play') {
          return;
        }
        const param = new URLSearchParams(uri.query).get('url');
        if (!param) {
          return;
        }
        try {
          RtspPlayerPanel.createOrShow(context, normalizeStreamUrl(param));
        } catch {
          // Ignore malformed external links.
        }
      },
    }),

    { dispose: disposeServer },
  );
}

export function deactivate(): void {
  disposeServer();
}

/** Used by automated integration checks. */
export function getDiagnostics(): {
  log: string[];
  panel?: ReturnType<(typeof RtspPlayerPanel)['debugSnapshot']>;
} {
  return { log: [...logHistory()], panel: RtspPlayerPanel.debugSnapshot() };
}
