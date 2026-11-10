import * as vscode from 'vscode';

export interface RtspConfig {
  ffmpegPath: string;
  transport: 'tcp' | 'udp';
  videoMode: 'transcode' | 'copy';
  audioMode: 'auto' | 'on' | 'off';
  segmentDuration: number;
  connectTimeoutMs: number;
  maxReconnects: number;
  extraArgs: string[];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function readConfig(): RtspConfig {
  const cfg = vscode.workspace.getConfiguration('rtspPlayer');
  const transport = cfg.get<string>('rtspTransport', 'tcp') === 'udp' ? 'udp' : 'tcp';
  const videoMode = cfg.get<string>('videoMode', 'transcode') === 'copy' ? 'copy' : 'transcode';
  const audioSetting = cfg.get<string>('audioMode', 'auto');
  const audioMode: 'auto' | 'on' | 'off' = audioSetting === 'on' || audioSetting === 'off' ? audioSetting : 'auto';
  return {
    ffmpegPath: (cfg.get<string>('ffmpegPath', 'ffmpeg') || '').trim() || 'ffmpeg',
    transport,
    videoMode,
    audioMode,
    segmentDuration: clamp(cfg.get<number>('segmentDuration', 0.5), 0.25, 6),
    connectTimeoutMs: clamp(cfg.get<number>('connectTimeout', 20), 5, 120) * 1000,
    maxReconnects: clamp(cfg.get<number>('maxReconnects', 3), 0, 20),
    extraArgs: cfg.get<string[]>('extraFfmpegArgs', []) ?? [],
  };
}
