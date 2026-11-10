import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RtspConfig } from './config';
import { readConfig } from './config';
import { buildFfmpegArgs, resolveFfmpegPath } from './ffmpeg';
import { log, redact } from './log';
import { ensureServer, getStreamUrl, hasReadySegment, mount, unmount } from './streamServer';

export type SessionState = 'connecting' | 'playing' | 'error' | 'stopped';

export interface SessionUpdate {
  state: SessionState;
  message?: string;
  detail?: string;
  streamUrl?: string;
  fallbackUrl?: string;
  attempt?: number;
}

const RETRY_DELAYS_MS = [3000, 8000, 20000];
const GRACEFUL_STOP_MS = 1500;
const FORCE_STOP_WAIT_MS = 2500;
const STABLE_UPTIME_MS = 15000;
const STDERR_TAIL_LINES = 30;
const SLOW_CONNECT_MS = 8000;

/**
 * Turns common ffmpeg errors into something the user can act on.
 */
export function explainFailure(stderr: string): string | undefined {
  const text = stderr.toLowerCase();
  if (text.includes('operation not permitted')) {
    return 'The camera refused the session. TP-Link/Tapo cameras keep a previous session for ~30 s after an abrupt disconnect — wait half a minute (or close other viewers) and press Play again.';
  }
  if (text.includes('invalid data found') || text.includes('-10054') || text.includes('connection reset')) {
    return 'The camera closed the RTSP handshake (connection reset). Check the stream path and credentials, or try `rtspPlayer.rtspTransport`: "udp".';
  }
  if (text.includes('401') || text.includes('unauthorized')) {
    return 'The camera rejected the credentials (401 Unauthorized).';
  }
  if (text.includes('connection refused')) {
    return 'The camera refused the TCP connection — check the host and port.';
  }
  if (text.includes('no route to host')) {
    return 'Host unreachable — check the camera address and your network.';
  }
  if (text.includes('timed out') || text.includes('timeout') || text.includes('end of file')) {
    return 'The camera stopped answering — check the network, the URL path and whether another client holds the only session.';
  }
  return undefined;
}

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Best effort: never leave a detached ffmpeg behind if the host dies. */
function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const running of liveChildren) {
        try {
          running.kill();
        } catch {
          // Already gone.
        }
      }
    });
  }
}

/**
 * One ffmpeg process producing live HLS output for one URL.
 * Every (re)start gets a fresh mount key so the webview always reloads its source.
 */
export class RtspSession {
  private readonly keyBase = randomBytes(8).toString('hex');
  private key = '';
  private dir = '';
  private attempt = 0;
  private failures = 0;
  private child?: ChildProcess;
  private pollTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private startedAt = 0;
  private stopped = true;
  private stderrTail: string[] = [];
  private slowNotice = false;

  constructor(
    private readonly inputUrl: string,
    private readonly audio: boolean,
    private readonly onUpdate: (update: SessionUpdate) => void,
  ) {}

  /** Directory ffmpeg writes into; also used for the resource-scheme fallback. */
  get outputDir(): string {
    return this.dir;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.failures = 0;
    this.attempt = 0;
    await this.launch();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clearTimers();
    const dir = this.detachAttempt();
    void this.killChild().then(() => removeDir(dir));
    this.emit({ state: 'stopped' });
  }

  private emit(update: SessionUpdate): void {
    const detail = update.message ? ` — ${update.message}` : '';
    log(`session ${this.key || '-'}: ${update.state}${detail}`);
    this.onUpdate(update);
  }

  private async launch(): Promise<void> {
    this.clearTimers();
    // A previous attempt may still be shutting down; only its mount key and
    // directory are released, never a directory ffmpeg is still writing to.
    this.releaseMount();

    this.attempt += 1;
    this.key = `${this.keyBase}${this.attempt.toString(16).padStart(2, '0')}`;
    this.dir = path.join(os.tmpdir(), 'rtsp-player', String(process.pid), this.key);
    this.stderrTail = [];
    this.slowNotice = false;

    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
    } catch (err) {
      this.fail('Could not create the temporary directory', String(err));
      return;
    }
    if (this.stopped) {
      return;
    }

    const config = readConfig();
    mount(this.key, this.dir, config.segmentDuration);
    this.emit({
      state: 'connecting',
      message: this.attempt > 1 ? `Reconnecting (attempt ${this.attempt})…` : 'Connecting to the stream…',
      attempt: this.attempt,
    });

    const exe = resolveFfmpegPath(config);
    const args = buildFfmpegArgs({ inputUrl: this.inputUrl, outDir: this.dir, config, audio: this.audio });
    log(`session ${this.key}: url=${redact(this.inputUrl)} mode=${config.videoMode} audio=${this.audio}`);
    log(`session ${this.key}: ffmpeg=${exe}`);
    log(`session ${this.key}: args=${redact(args.join(' '))}`);

    let child: ChildProcess;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      this.fail('Failed to start ffmpeg', String(err));
      return;
    }

    this.child = child;
    this.startedAt = Date.now();
    trackChild(child);
    child.once('exit', () => liveChildren.delete(child));

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const raw of chunk.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) {
          continue;
        }
        this.stderrTail.push(redact(line));
        log(`session ${this.key}: ffmpeg: ${redact(line)}`);
        if (this.stderrTail.length > STDERR_TAIL_LINES) {
          this.stderrTail.shift();
        }
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      this.child = undefined;
      const detail =
        err.code === 'ENOENT'
          ? `Cannot find \`${exe}\`. Install ffmpeg and add it to PATH, or set \`rtspPlayer.ffmpegPath\`.`
          : err.message;
      this.fail('ffmpeg did not start', detail);
    });

    child.on('exit', (code, signal) => this.onExit(code, signal, config));

    this.waitForPlaylist(config.connectTimeoutMs);
  }

  private waitForPlaylist(timeoutMs: number): void {
    const deadline = Date.now() + timeoutMs;

    const tick = async (): Promise<void> => {
      if (this.stopped || !this.child) {
        return;
      }
      if (await hasReadySegment(this.dir)) {
        const serverPort = await ensureServer();
        if (this.stopped) {
          return;
        }
        this.emit({
          state: 'playing',
          message: 'Live',
          streamUrl: getStreamUrl(this.key, serverPort),
          attempt: this.attempt,
        });
        return;
      }
      if (this.stopped) {
        return;
      }
      if (!this.slowNotice && Date.now() - this.startedAt > SLOW_CONNECT_MS) {
        this.slowNotice = true;
        this.emit({
          state: 'connecting',
          message: 'Still connecting… the camera may be busy with another viewer.',
          attempt: this.attempt,
        });
      }
      if (Date.now() > deadline) {
        this.fail(
          'Timed out waiting for data',
          this.stderrTail.join('\n') ||
            'ffmpeg produced no first segment. Check the URL, the credentials and the transport setting.',
        );
        return;
      }
      this.pollTimer = setTimeout(() => void tick(), 250);
    };

    this.pollTimer = setTimeout(() => void tick(), 250);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, config: RtspConfig): void {
    if (this.stopped) {
      return;
    }
    this.child = undefined;
    this.clearTimers();

    if (Date.now() - this.startedAt >= STABLE_UPTIME_MS) {
      this.failures = 0;
    }
    const detail = this.stderrTail.join('\n') || undefined;

    if (this.failures < config.maxReconnects) {
      const delay = RETRY_DELAYS_MS[Math.min(this.failures, RETRY_DELAYS_MS.length - 1)];
      this.failures += 1;
      this.emit({
        state: 'connecting',
        message: `Stream ended (${code ?? signal ?? 'no code'}) — retrying in ${Math.round(delay / 1000)} s…`,
        detail,
        attempt: this.attempt + 1,
      });
      this.retryTimer = setTimeout(() => {
        if (!this.stopped) {
          void this.launch();
        }
      }, delay);
      return;
    }

    this.fail('Could not keep the stream alive', detail);
  }

  private fail(message: string, detail?: string): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clearTimers();
    const dir = this.detachAttempt();
    void this.killChild().then(() => removeDir(dir));
    const tail = detail || this.stderrTail.join('\n') || undefined;
    const hint = tail ? explainFailure(tail) : undefined;
    this.emit({
      state: 'error',
      message: hint ?? message,
      detail: tail,
      attempt: this.attempt,
    });
  }

  private clearTimers(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private killChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

    // `q` makes ffmpeg shut down in an orderly way (RTSP TEARDOWN). Killing it
    // hard leaves the session open on the camera for ~30 s, which then rejects
    // every new connection with "Operation not permitted".
    try {
      child.stdin?.end('q\n');
    } catch {
      // stdin may already be closed.
    }

    const force = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          }).on('error', () => {
            try {
              child.kill();
            } catch {
              // Already gone.
            }
          });
          return;
        } catch {
          // Fall through to the cross-platform kill.
        }
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    };

    setTimeout(force, GRACEFUL_STOP_MS);
    const giveUp = new Promise<void>((resolve) => setTimeout(resolve, GRACEFUL_STOP_MS + FORCE_STOP_WAIT_MS));
    return Promise.race([exited, giveUp]);
  }

  /** Unmounts the current key and hands back its directory (or ''). */
  private detachAttempt(): string {
    const dir = this.dir;
    this.releaseMount();
    return dir;
  }

  private releaseMount(): void {
    if (!this.key) {
      return;
    }
    unmount(this.key);
    this.key = '';
    this.dir = '';
  }
}

/** Removes a session directory once ffmpeg has definitely stopped writing. */
function removeDir(dir: string): void {
  if (!dir) {
    return;
  }
  void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
