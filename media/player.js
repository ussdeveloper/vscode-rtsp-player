import Hls from 'hls.js';

window.__rtspAlive = true;
const vscode = window.acquireVsCodeApi();

const urlInput = document.getElementById('url');
const playBtn = document.getElementById('play');
const stopBtn = document.getElementById('stop');
const muteBtn = document.getElementById('mute');
const settingsBtn = document.getElementById('settings');
const statusEl = document.getElementById('status');
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const overlayText = document.getElementById('overlayText');
const details = document.getElementById('details');
const detailsText = document.getElementById('detailsText');
const historyList = document.getElementById('history');

let hls = null;
let recoveries = 0;
let audioAvailable = true;
let fallbackUrl = null;
let usedFallback = false;
let responseTimer = null;

const EXTENSION_TIMEOUT_MS = 25000;

function armResponseWatchdog() {
  clearResponseWatchdog();
  responseTimer = window.setTimeout(() => {
    report('no state received from the extension host within 25 s', 'error');
    setStatus('Error', 'error');
    showOverlay('No response from the extension host. Run “RTSP Player: Show Log” for details.', false);
  }, EXTENSION_TIMEOUT_MS);
}

function clearResponseWatchdog() {
  if (responseTimer !== null) {
    window.clearTimeout(responseTimer);
    responseTimer = null;
  }
}

function report(message, level) {
  try {
    vscode.postMessage({ type: 'log', level: level || 'info', message: String(message) });
  } catch {
    /* ignore */
  }
}

window.addEventListener('error', (event) => {
  report(`window error: ${event.message} @ ${event.filename}:${event.lineno}`, 'error');
});
window.addEventListener('unhandledrejection', (event) => {
  report(`unhandled rejection: ${event.reason}`, 'error');
});

/**
 * Some VS Code/Electron builds ship without the AAC decoder in MSE. The
 * extension asks for this before choosing ffmpeg audio settings.
 */
function supportsAac() {
  try {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"');
  } catch {
    return false;
  }
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind ? `status ${kind}` : 'status';
}

function showOverlay(text, spinning) {
  overlayText.textContent = text;
  overlay.classList.remove('hidden');
  overlay.classList.toggle('static', !spinning);
}

function hideOverlay() {
  overlay.classList.add('hidden');
}

function showDetails(text) {
  if (!text) {
    details.hidden = true;
    detailsText.textContent = '';
    return;
  }
  detailsText.textContent = text;
  details.hidden = false;
}

function destroyPlayer() {
  if (hls) {
    try {
      hls.destroy();
    } catch {
      /* ignore */
    }
    hls = null;
  }
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch {
    /* ignore */
  }
  recoveries = 0;
}

function ensurePlaying(attempt) {
  video.play().catch((err) => {
    report(`video.play failed (attempt ${attempt}): ${err && err.message ? err.message : err}`, 'warn');
    if (attempt < 3) {
      window.setTimeout(() => ensurePlaying(attempt + 1), 1000);
    }
  });
}

function attach(streamUrl) {
  destroyPlayer();
  showOverlay('Buffering…', true);
  report(`attach ${streamUrl}, Hls.isSupported=${Hls.isSupported()}`);

  if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: false,
      lowLatencyMode: false,
      liveSyncDurationCount: 2,
      maxLiveSyncPlaybackRate: 1.5,
      maxBufferLength: 8,
      maxMaxBufferLength: 12,
      backBufferLength: 0,
      manifestLoadingTimeOut: 10000,
      manifestLoadingMaxRetry: 10,
      levelLoadingMaxRetry: 10,
      fragLoadingMaxRetry: 10,
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data) {
        return;
      }
      const info = `hls error type=${data.type} details=${data.details} fatal=${data.fatal} url=${data.url || ''} status=${data.response ? data.response.code : ''} reason=${data.reason || ''}${data.err ? ` err=${data.err.message || data.err}` : ''}`;
      report(info, data.fatal ? 'error' : 'warn');
      if (!data.fatal) {
        return;
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (recoveries < 2) {
          recoveries += 1;
          setStatus('Connecting…', 'connecting');
          showOverlay('Retrying connection to the local server…', true);
          hls.startLoad();
          return;
        }
        if (fallbackUrl && !usedFallback) {
          usedFallback = true;
          report('primary HLS transport failed, switching to the webview resource URL', 'warn');
          attach(fallbackUrl);
          return;
        }
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries < 6) {
        recoveries += 1;
        hls.recoverMediaError();
        return;
      }
      setStatus('Error', 'error');
      showOverlay(`Playback error: ${data.details}`, false);
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      hideOverlay();
      setStatus('Live', 'playing');
      report(`manifest parsed, levels=${hls.levels ? hls.levels.length : '?'}`);
      ensurePlaying(0);
      window.setTimeout(() => {
        report(`playback t=${video.currentTime.toFixed(2)} readyState=${video.readyState} paused=${video.paused}`);
      }, 5000);
    });

    hls.attachMedia(video);
    hls.loadSource(streamUrl);
    return;
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = streamUrl;
    video.addEventListener(
      'loadedmetadata',
      () => {
        hideOverlay();
        setStatus('Live', 'playing');
        ensurePlaying(0);
      },
      { once: true },
    );
    return;
  }

  setStatus('Error', 'error');
  showOverlay('This webview does not support HLS playback.', false);
}

function applyState(state) {
  clearResponseWatchdog();
  if (typeof state.audio === 'boolean') {
    audioAvailable = state.audio;
    refreshMuteButton();
  }
  switch (state.state) {
    case 'connecting':
      setStatus(state.attempt > 1 ? 'Reconnecting…' : 'Connecting…', 'connecting');
      showOverlay(state.message || 'Connecting…', true);
      showDetails('');
      break;
    case 'playing':
      fallbackUrl = typeof state.fallbackUrl === 'string' ? state.fallbackUrl : null;
      usedFallback = false;
      if (state.streamUrl) {
        attach(state.streamUrl);
      }
      break;
    case 'stopped':
      destroyPlayer();
      setStatus('Stopped', '');
      showOverlay('Stream stopped', false);
      showDetails('');
      break;
    case 'error':
      destroyPlayer();
      setStatus('Error', 'error');
      showOverlay(state.message || 'Error', false);
      showDetails(state.detail || '');
      break;
    default:
      break;
  }
}

function refreshMuteButton() {
  muteBtn.disabled = !audioAvailable;
  muteBtn.textContent = video.muted || !audioAvailable ? '🔇' : '🔊';
  muteBtn.title = audioAvailable
    ? video.muted
      ? 'Enable sound'
      : 'Disable sound'
    : 'This stream has no audio';
}

function setMuted(muted) {
  video.muted = muted;
  refreshMuteButton();
  if (!muted) {
    ensurePlaying(0);
  }
}

function requestPlay() {
  const url = urlInput.value.trim();
  if (!url) {
    urlInput.focus();
    return;
  }
  setStatus('Connecting…', 'connecting');
  showOverlay('Connecting to the stream…', true);
  showDetails('');
  armResponseWatchdog();
  vscode.postMessage({ type: 'play', url });
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'init') {
    if (Array.isArray(message.history)) {
      historyList.innerHTML = '';
      for (const url of message.history) {
        const option = document.createElement('option');
        option.value = url;
        historyList.appendChild(option);
      }
    }
    if (message.lastUrl && !urlInput.value) {
      urlInput.value = message.lastUrl;
    }
    return;
  }
  if (message.type === 'state') {
    applyState(message);
  }
});

playBtn.addEventListener('click', requestPlay);
stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
settingsBtn.addEventListener('click', () => vscode.postMessage({ type: 'settings' }));
muteBtn.addEventListener('click', () => setMuted(!video.muted));

urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    requestPlay();
  }
});

video.addEventListener('error', () => {
  const err = video.error;
  report(`media element error: code=${err ? err.code : '?'} message=${err && err.message ? err.message : ''}`, 'error');
});

video.addEventListener('dblclick', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => undefined);
  } else {
    video.requestFullscreen().catch(() => undefined);
  }
});

vscode.postMessage({ type: 'ready', caps: { aac: supportsAac() } });
refreshMuteButton();
