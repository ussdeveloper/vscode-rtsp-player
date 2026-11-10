import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RtspConfig } from './config';

function isExecutableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function candidatePaths(): string[] {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const list: string[] = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    if (local) {
      list.push(path.join(local, 'Microsoft', 'WinGet', 'Links', exe));
      list.push(path.join(local, 'ffmpeg', 'bin', exe));
      list.push(path.join(local, 'Programs', 'ffmpeg', 'bin', exe));
      list.push(...wingetPackageCandidates(local, exe));
    }
    if (programFiles) {
      list.push(path.join(programFiles, 'ffmpeg', 'bin', exe));
    }
    if (programFilesX86) {
      list.push(path.join(programFilesX86, 'ffmpeg', 'bin', exe));
    }
    list.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  } else {
    list.push('/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg');
    list.push(path.join(os.homedir(), '.local', 'bin', 'ffmpeg'));
  }
  return list;
}

/**
 * `winget install Gyan.FFmpeg` extracts into Packages/Gyan.FFmpeg_<hash>/<build>/bin
 * and only creates the PATH link after a shell restart, so scan that layout too.
 */
function wingetPackageCandidates(localAppData: string, exe: string): string[] {
  const packagesRoot = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  let packages: string[];
  try {
    packages = fs.readdirSync(packagesRoot);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const pkg of packages) {
    if (!/^Gyan\.FFmpeg/i.test(pkg)) {
      continue;
    }
    const root = path.join(packagesRoot, pkg);
    found.push(path.join(root, 'bin', exe));
    let builds: string[];
    try {
      builds = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const build of builds) {
      found.push(path.join(root, build, 'bin', exe));
    }
  }
  return found;
}

let resolved: string | undefined;

/**
 * Resolution order: explicit setting -> well-known install locations -> PATH.
 */
export function resolveFfmpegPath(config: RtspConfig): string {
  if (resolved) {
    return resolved;
  }
  if (config.ffmpegPath !== 'ffmpeg' && isExecutableFile(config.ffmpegPath)) {
    resolved = config.ffmpegPath;
    return resolved;
  }
  for (const candidate of candidatePaths()) {
    if (isExecutableFile(candidate)) {
      resolved = candidate;
      return resolved;
    }
  }
  resolved = config.ffmpegPath;
  return resolved;
}

export function resetFfmpegCache(): void {
  resolved = undefined;
}

export interface BuildArgsOptions {
  inputUrl: string;
  outDir: string;
  config: RtspConfig;
  /** false adds `-an`, used when the webview cannot decode AAC. */
  audio: boolean;
}

export function buildFfmpegArgs({ inputUrl, outDir, config, audio }: BuildArgsOptions): string[] {
  // No `-nostdin`: the session writes `q` to stdin to stop ffmpeg cleanly, which
  // sends an RTSP TEARDOWN so the camera frees the session immediately.
  const args: string[] = ['-hide_banner', '-loglevel', 'warning'];

  if (/^rtsps?:\/\//i.test(inputUrl)) {
    args.push('-rtsp_transport', config.transport);
  }

  args.push('-i', inputUrl);

  if (config.videoMode === 'copy') {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-pix_fmt', 'yuv420p',
      '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${config.segmentDuration})`,
      '-crf', '23',
      '-b:v', '0',
    );
  }

  if (audio) {
    args.push(
      // Some cameras emit non-monotonic audio timestamps; async resampling repairs
      // them instead of letting the muxer warn and drift.
      '-af', 'aresample=async=1:first_pts=0',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ac', '2',
    );
  } else {
    args.push('-an');
  }

  args.push(
    '-f', 'hls',
    '-hls_time', String(config.segmentDuration),
    '-hls_list_size', '10',
    // `temp_file` publishes a segment only once it is fully written, so a reader
    // can never see a truncated segment.
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments+temp_file',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(outDir, 'seg%05d.ts'),
    ...config.extraArgs,
    path.join(outDir, 'stream.m3u8'),
  );

  return args;
}

export interface FfmpegProbe {
  path: string;
  version: string;
}

export async function probeFfmpeg(config: RtspConfig): Promise<FfmpegProbe> {
  resetFfmpegCache();
  const exePath = resolveFfmpegPath(config);
  const version = await new Promise<string>((resolve, reject) => {
    const child = spawn(exePath, ['-version'], { windowsHide: true });
    let out = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => reject(new Error(err.code === 'ENOENT' ? `Cannot find "${exePath}"` : err.message)));
    });
    child.on('close', (code) => {
      const firstLine = out.split(/\r?\n/)[0]?.trim();
      if (code === 0 && firstLine) {
        finish(() => resolve(firstLine));
      } else {
        finish(() => reject(new Error(`\`${exePath} -version\` exited with code ${code}.`)));
      }
    });
  });
  return { path: exePath, version };
}
