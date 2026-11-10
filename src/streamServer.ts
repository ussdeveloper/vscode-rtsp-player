import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';

/**
 * Loopback HLS server.
 *
 * The playlist is *synthesised* from the segment files ffmpeg already finished,
 * instead of reading ffmpeg's own .m3u8. On Windows a Node read handle blocks
 * ffmpeg's atomic rename (ERROR_ACCESS_DENIED), which made ffmpeg fail to
 * publish playlists. Listing a directory never opens the playlist, so that race
 * cannot happen; the `temp_file` HLS flag guarantees only complete segments are
 * visible.
 */

interface Mount {
  dir: string;
  segmentDuration: number;
  listSize: number;
}

const mounts = new Map<string, Mount>();

let server: http.Server | undefined;
let port = 0;

const KEY_RE = /^[a-f0-9]{12,64}$/;
const SEGMENT_RE = /^seg(\d+)\.ts$/;
const HOST_RE = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const PLAYLIST_NAME = 'stream.m3u8';

export function isValidMountKey(key: string): boolean {
  return KEY_RE.test(key);
}

/**
 * The server only listens on loopback and every mount key is random, so a
 * permissive origin policy is safe here and avoids webview environments that
 * send an opaque (`null`) origin.
 */
function isAllowedOrigin(origin: string): boolean {
  const value = origin.toLowerCase();
  return (
    value === 'null' ||
    value.startsWith('vscode-webview://') ||
    value.startsWith('vscode-webview-resource://') ||
    /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(value)
  );
}

export async function ensureServer(): Promise<number> {
  if (server && port) {
    return port;
  }
  const srv = http.createServer((req, res) => void handle(req, res));
  srv.on('clientError', (_err, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve());
  });
  server = srv;
  port = (srv.address() as AddressInfo).port;
  return port;
}

export function mount(key: string, dir: string, segmentDuration: number, listSize = 10): void {
  mounts.set(key, { dir, segmentDuration, listSize });
}

export function unmount(key: string): void {
  mounts.delete(key);
}

export function getStreamUrl(key: string, serverPort: number): string {
  return `http://127.0.0.1:${serverPort}/s/${key}/${PLAYLIST_NAME}`;
}

export function disposeServer(): void {
  mounts.clear();
  server?.close();
  server = undefined;
  port = 0;
}

/** Segment numbers already completed by ffmpeg, oldest first. */
async function segmentNumbers(dir: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const numbers: number[] = [];
  for (const entry of entries) {
    const match = SEGMENT_RE.exec(entry);
    if (match) {
      numbers.push(Number(match[1]));
    }
  }
  return numbers.sort((a, b) => a - b);
}

export async function hasReadySegment(dir: string): Promise<boolean> {
  const numbers = await segmentNumbers(dir);
  return numbers.length > 0;
}

function segmentName(index: number): string {
  return `seg${String(index).padStart(5, '0')}.ts`;
}

export function buildPlaylist(numbers: number[], segmentDuration: number, listSize: number): string {
  const window = numbers.slice(Math.max(0, numbers.length - listSize));
  const targetDuration = Math.max(1, Math.ceil(segmentDuration));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${window[0]}`,
  ];
  for (const index of window) {
    lines.push(`#EXTINF:${segmentDuration.toFixed(3)},`, segmentName(index));
  }
  lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
  return `${lines.join('\n')}\n`;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const host = req.headers.host ?? '';
  if (!HOST_RE.test(host)) {
    // Guards against DNS-rebinding style access from remote origins.
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      // Chrome's Private Network Access check: without this the webview can be
      // denied when fetching 127.0.0.1 from a custom scheme.
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/health') {
    const body = JSON.stringify({ ok: true, streams: mounts.size });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 's' || parts.length !== 3) {
    notFound(res);
    return;
  }

  const key = parts[1];
  const file = parts[2];
  if (!KEY_RE.test(key)) {
    notFound(res);
    return;
  }

  const entry = mounts.get(key);
  if (!entry) {
    notFound(res);
    return;
  }

  if (file === PLAYLIST_NAME) {
    const numbers = await segmentNumbers(entry.dir);
    if (numbers.length === 0) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Retry-After': '1', 'Cache-Control': 'no-store' });
      res.end('Playlist not ready');
      return;
    }
    const playlist = buildPlaylist(numbers, entry.segmentDuration, entry.listSize);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
      'Content-Length': String(Buffer.byteLength(playlist)),
    });
    res.end(req.method === 'HEAD' ? undefined : playlist);
    return;
  }

  if (!SEGMENT_RE.test(file)) {
    notFound(res);
    return;
  }

  const root = path.resolve(entry.dir);
  const full = path.resolve(root, file);
  if (path.dirname(full) !== root) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(full);
  } catch {
    notFound(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Content-Length': String(stat.size),
    'Cache-Control': 'private, max-age=60',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(full)
    .on('error', () => res.destroy())
    .pipe(res);
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end('Not found');
}
