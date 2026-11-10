import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const HISTORY_LIMIT = 800;
const FILE_LIMIT_BYTES = 2 * 1024 * 1024;

export const LOG_DIR = path.join(os.tmpdir(), 'rtsp-player-logs');
export const LOG_FILE = path.join(LOG_DIR, 'rtsp-player.log');

const history: string[] = [];
let channel: vscode.OutputChannel | undefined;
let fileReady = false;

/** Removes credentials from URLs before anything reaches a log sink. */
export function redact(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, '$1***@');
}

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('RTSP Player', { log: true });
  context.subscriptions.push(channel);
  fileReady = ensureLogDir();
  if (fileReady) {
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > FILE_LIMIT_BYTES) {
        fs.writeFileSync(LOG_FILE, '');
      }
    } catch {
      // Rotation is best effort.
    }
  }
  log(`log file: ${LOG_FILE}`);
}

/** The directory can disappear while the host is running; recreate it lazily. */
function ensureLogDir(): boolean {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes to the output channel and to a file, so users can attach a complete
 * log even when the webview itself is broken.
 */
export function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  history.push(line);
  if (history.length > HISTORY_LIMIT) {
    history.shift();
  }
  channel?.appendLine(line);
  if (!fileReady && !ensureLogDir()) {
    return;
  }
  try {
    fs.appendFileSync(LOG_FILE, `${line}${os.EOL}`);
    fileReady = true;
  } catch {
    fileReady = false;
  }
}

export function logHistory(): readonly string[] {
  return history;
}

export function showLog(): void {
  channel?.show(true);
}
