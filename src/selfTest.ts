import * as vscode from 'vscode';
import { log, redact } from './log';
import { RtspSession } from './session';

export interface SelfTestReport {
  ok: boolean;
  lines: string[];
}

/**
 * Runs ffmpeg and the local HLS server without the webview and verifies that a
 * playlist and a segment can be fetched. It separates "extension side" problems
 * from "webview side" problems.
 */
export async function runSelfTest(url: string): Promise<SelfTestReport> {
  const lines: string[] = [];
  const record = (line: string) => {
    lines.push(line);
    log(`[self-test] ${redact(line)}`);
  };

  const started = Date.now();
  let playlistUrl: string | undefined;
  const session = new RtspSession(url, true, (update) => {
    record(`state=${update.state}${update.message ? ` message="${update.message}"` : ''}`);
    if (update.detail) {
      record(`detail: ${update.detail}`);
    }
    if (update.state === 'playing' && update.streamUrl) {
      playlistUrl = update.streamUrl;
    }
  });

  const finished = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (playlistUrl || Date.now() - started > 40000) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
  });

  await session.start();
  await finished;

  if (!playlistUrl) {
    session.stop();
    record('FAIL: no playlist within 40 s');
    return { ok: false, lines };
  }

  record(`playlist: ${playlistUrl} (after ${Date.now() - started} ms)`);
  try {
    const playlistResponse = await fetch(playlistUrl, {
      headers: { Origin: 'vscode-webview://self-test' },
    });
    const text = await playlistResponse.text();
    const segments = text.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
    record(
      `GET playlist -> ${playlistResponse.status}, CORS=${playlistResponse.headers.get('access-control-allow-origin')}, segments=${segments.length}`,
    );
    const base = playlistUrl.slice(0, playlistUrl.lastIndexOf('/'));
    const newest = segments[segments.length - 1];
    if (!newest) {
      session.stop();
      record('FAIL: playlist contains no segments');
      return { ok: false, lines };
    }
    const segmentResponse = await fetch(`${base}/${newest}`);
    const bytes = (await segmentResponse.arrayBuffer()).byteLength;
    record(`GET ${newest} -> ${segmentResponse.status}, ${bytes} B`);
    session.stop();
    const ok = playlistResponse.ok && segmentResponse.ok && bytes > 0;
    record(ok ? 'OK' : 'FAIL: playlist or segment is invalid');
    return { ok, lines };
  } catch (err) {
    session.stop();
    record(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, lines };
  }
}

export async function showSelfTest(url: string): Promise<void> {
  const report = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'RTSP Player: self-test' },
    () => runSelfTest(url),
  );
  const preview = report.lines.slice(-6).join('\n');
  if (report.ok) {
    void vscode.window
      .showInformationMessage('Self-test OK — ffmpeg and the local HLS server work.', 'Show log')
      .then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand('rtspPlayer.showLog');
        }
      });
  } else {
    void vscode.window.showErrorMessage(`Self-test failed.\n${preview}`, 'Show log').then((choice) => {
      if (choice) {
        void vscode.commands.executeCommand('rtspPlayer.showLog');
      }
    });
  }
}
