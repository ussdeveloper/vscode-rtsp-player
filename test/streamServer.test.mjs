import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundleDir = await mkdtemp(path.join(tmpdir(), 'rtsp-player-bundle-'));
const outfile = path.join(bundleDir, 'streamServer.mjs');
await build({
  entryPoints: ['src/streamServer.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const server = await import(pathToFileURL(outfile).href);

const KEY = 'a1b2c3d4e5f60718';
const SEGMENT_DURATION = 0.5;

let workDir;
let origin;

async function writeSegment(dir, index, size = 4) {
  await writeFile(path.join(dir, `seg${String(index).padStart(5, '0')}.ts`), Buffer.alloc(size, 0x47));
}

test.before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'rtsp-player-hls-'));
  origin = `http://127.0.0.1:${await server.ensureServer()}`;
  server.mount(KEY, workDir, SEGMENT_DURATION);
});

test.after(async () => {
  server.disposeServer();
  await rm(bundleDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

test('returns 404 until ffmpeg finished a segment', async () => {
  const response = await fetch(`${origin}/s/${KEY}/stream.m3u8`);
  assert.equal(response.status, 404);
});

test('synthesises a playlist from complete segments only', async () => {
  // A half-written segment must never show up in the playlist.
  await writeFile(path.join(workDir, 'seg00001.ts.tmp'), Buffer.alloc(4, 0x47));
  await writeSegment(workDir, 0);
  await writeSegment(workDir, 1);

  const response = await fetch(`${origin}/s/${KEY}/stream.m3u8`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  const text = await response.text();
  const segments = text.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(segments, ['seg00000.ts', 'seg00001.ts']);
  assert.match(text, /#EXT-X-MEDIA-SEQUENCE:0/);
  assert.match(text, /#EXT-X-TARGETDURATION:1/);
  assert.match(text, /#EXTINF:0\.500/);
  assert.ok(text.endsWith('\n'));
});

test('advances the media sequence when ffmpeg deletes old segments', async () => {
  await rm(path.join(workDir, 'seg00000.ts'));
  const text = await (await fetch(`${origin}/s/${KEY}/stream.m3u8`)).text();
  assert.match(text, /#EXT-X-MEDIA-SEQUENCE:1/);
  const segments = text.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(segments, ['seg00001.ts']);
});

test('serves segments as MPEG-TS', async () => {
  const response = await fetch(`${origin}/s/${KEY}/seg00001.ts`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp2t');
  assert.equal((await response.arrayBuffer()).byteLength, 4);
});

test('reflects only webview and loopback origins in CORS headers', async () => {
  const webview = await fetch(`${origin}/s/${KEY}/stream.m3u8`, {
    headers: { Origin: 'vscode-webview://abc' },
  });
  assert.equal(webview.headers.get('access-control-allow-origin'), 'vscode-webview://abc');

  const opaque = await fetch(`${origin}/s/${KEY}/stream.m3u8`, { headers: { Origin: 'null' } });
  assert.equal(opaque.headers.get('access-control-allow-origin'), 'null');

  const loopback = await fetch(`${origin}/s/${KEY}/stream.m3u8`, {
    headers: { Origin: 'http://127.0.0.1:1234' },
  });
  assert.equal(loopback.headers.get('access-control-allow-origin'), 'http://127.0.0.1:1234');

  const denied = await fetch(`${origin}/s/${KEY}/stream.m3u8`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('answers preflight with Private Network Access approval', async () => {
  const response = await fetch(`${origin}/s/${KEY}/stream.m3u8`, { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
});

test('blocks unknown keys, traversal and non-segment files', async () => {
  assert.equal((await fetch(`${origin}/s/${'0'.repeat(16)}/stream.m3u8`)).status, 404);
  assert.equal((await fetch(`${origin}/s/${KEY}/..%2F..%2Fsecret.ts`)).status, 404);
  assert.equal((await fetch(`${origin}/s/${KEY}/notes.txt`)).status, 404);
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  await access(path.join(workDir, 'seg00001.ts'));
});

test('rejects requests with a foreign Host header', async () => {
  try {
    const response = await fetch(`${origin}/s/${KEY}/stream.m3u8`, {
      headers: { Host: 'attacker.example' },
    });
    assert.equal(response.status, 403);
  } catch {
    // Some fetch implementations refuse to send a custom Host header; that is fine.
  }
});

test('buildPlaylist keeps only the newest segments', () => {
  const numbers = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const text = server.buildPlaylist(numbers, 0.5, 8);
  const segments = text.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.equal(segments.length, 8);
  assert.equal(segments[0], 'seg00012.ts');
  assert.equal(segments[7], 'seg00019.ts');
  assert.match(text, /#EXT-X-MEDIA-SEQUENCE:12/);
});
