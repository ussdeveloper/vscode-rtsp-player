import * as fs from 'fs';
import * as vscode from 'vscode';

const HISTORY_KEY = 'rtspPlayer.recentUrls';
const HISTORY_LIMIT = 12;
const ALLOWED_PROTOCOLS = ['rtsp:', 'rtsps:', 'http:', 'https:', 'file:'];

const changed = new vscode.EventEmitter<void>();

/** Fires whenever the recent-stream list is modified. */
export const onDidChangeRecent = changed.event;

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

/**
 * Human readable name for a stream that never exposes credentials,
 * e.g. `10.0.0.5:554/stream2`.
 */
export function describeStreamLabel(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const tail = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    return tail ? `${host}/${tail}` : host;
  } catch {
    return rawUrl;
  }
}

/** Panel title, e.g. `RTSP 10.0.0.5:554/stream2`. */
export function describeStream(rawUrl: string): string {
  return `RTSP ${describeStreamLabel(rawUrl)}`.slice(0, 48);
}

export function getRecentUrls(context: vscode.ExtensionContext): string[] {
  const stored = context.globalState.get<unknown>(HISTORY_KEY, []);
  if (!Array.isArray(stored)) {
    return [];
  }
  return stored.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** A failing listener (e.g. an unregistered tree view) must never break playback. */
function notifyChanged(): void {
  try {
    changed.fire();
  } catch {
    // Listeners are independent of the caller.
  }
}

export async function rememberUrl(context: vscode.ExtensionContext, url: string): Promise<void> {
  const recent = getRecentUrls(context).filter((entry) => entry !== url);
  recent.unshift(url);
  await context.globalState.update(HISTORY_KEY, recent.slice(0, HISTORY_LIMIT));
  notifyChanged();
}

export async function removeRecentUrl(context: vscode.ExtensionContext, url: string): Promise<void> {
  const next = getRecentUrls(context).filter((entry) => entry !== url);
  await context.globalState.update(HISTORY_KEY, next);
  notifyChanged();
}

export async function clearRecentUrls(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(HISTORY_KEY, []);
  notifyChanged();
}

/**
 * `globalState` is namespaced by extension id, so renaming the publisher starts
 * an empty list. A `history-import.json` file in this extension's global storage
 * (array of URLs) seeds the list once and is then removed.
 */
export async function importLegacyHistory(context: vscode.ExtensionContext): Promise<number> {
  if (getRecentUrls(context).length > 0) {
    return 0;
  }
  const file = vscode.Uri.joinPath(context.globalStorageUri, 'history-import.json');
  let raw: string;
  try {
    raw = await fs.promises.readFile(file.fsPath, 'utf8');
  } catch {
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) {
    return 0;
  }
  const urls: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') {
      continue;
    }
    try {
      urls.push(normalizeStreamUrl(entry));
    } catch {
      // Skip anything that is not a valid stream URL.
    }
  }
  if (urls.length === 0) {
    return 0;
  }
  await context.globalState.update(HISTORY_KEY, urls.slice(0, HISTORY_LIMIT));
  await fs.promises.rm(file.fsPath, { force: true }).catch(() => undefined);
  notifyChanged();
  return urls.length;
}
