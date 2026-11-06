const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { IS_VERCEL, TEMP_DIR, BROWSER_UA, DEFAULT_AGE_COOKIES } = require('../config/constants');
const {
  snapToStandardResolution,
  formatBytes,
  formatDuration,
  humanizeUrlSlug
} = require('../utils/mediaFormatters');

const LOCAL_YTDLP_BIN = path.join(
  TEMP_DIR,
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

let resolvedYtDlpCmd = null;
let ytdlpDownloadPromise = null;
let resolvedFfmpegPath = null;

// resolve optional local ffmpeg binary without triggering Vercel's static file tracer
function getLocalFfmpegPath() {
  if (IS_VERCEL) return null;
  if (resolvedFfmpegPath) return resolvedFfmpegPath;
  try {
    const dynamicRequire = eval('require');
    const candidate = dynamicRequire('ffmpeg-static');
    if (candidate && fs.existsSync(candidate)) {
      resolvedFfmpegPath = candidate;
      return resolvedFfmpegPath;
    }
  } catch {}
  return null;
}

async function ensureYtDlpBinary() {
  if (IS_VERCEL) return null;

  if (resolvedYtDlpCmd && (resolvedYtDlpCmd === 'yt-dlp' || fs.existsSync(resolvedYtDlpCmd))) {
    return resolvedYtDlpCmd;
  }

  if (fs.existsSync(LOCAL_YTDLP_BIN) && fs.statSync(LOCAL_YTDLP_BIN).size > 1000000) {
    resolvedYtDlpCmd = LOCAL_YTDLP_BIN;
    return resolvedYtDlpCmd;
  }

  const hasGlobal = await new Promise(resolve => {
    try {
      const p = spawn('yt-dlp', ['--version']);
      p.on('error', () => resolve(false));
      p.on('close', code => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });

  if (hasGlobal) {
    resolvedYtDlpCmd = 'yt-dlp';
    return resolvedYtDlpCmd;
  }

  if (!ytdlpDownloadPromise) {
    ytdlpDownloadPromise = (async () => {
      const releaseUrl =
        process.platform === 'win32'
          ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
          : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

      console.log('Downloading standalone yt-dlp binary into temp/ folder...');
      const res = await fetch(releaseUrl, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(LOCAL_YTDLP_BIN, buffer);
      if (process.platform !== 'win32') {
        fs.chmodSync(LOCAL_YTDLP_BIN, 0o755);
      }
      resolvedYtDlpCmd = LOCAL_YTDLP_BIN;
      return resolvedYtDlpCmd;
    })().catch(() => {
      ytdlpDownloadPromise = null;
      return null;
    });
  }

  return ytdlpDownloadPromise;
}

function initLocalBinaries() {
  if (!IS_VERCEL) {
    getLocalFfmpegPath();
    ensureYtDlpBinary();
  }
}

async function runYtDlp(args, timeoutMs = 180000) {
  const cmd = await ensureYtDlpBinary();
  if (!cmd) throw new Error('yt-dlp binary unavailable');
  const ffmpegBin = getLocalFfmpegPath();

  return new Promise((resolve, reject) => {
    let settled = false;
    let proc;
    try {
      const fullArgs = ffmpegBin ? ['--ffmpeg-location', ffmpegBin, ...args] : args;
      proc = spawn(cmd, fullArgs);
    } catch (err) {
      return reject(err);
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill(); } catch {}
        reject(new Error('yt-dlp timeout'));
      }
    }, timeoutMs);

    proc.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));

    proc.on('close', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      }
    });
  });
}

async function inspectViaYtDlp(targetUrl) {
  if (IS_VERCEL) return null;
  const parsed = new URL(targetUrl);

  const rawJson = await runYtDlp(
    [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--referer',
      parsed.origin + '/',
      '--user-agent',
      BROWSER_UA,
      '--add-header',
      `Cookie:${DEFAULT_AGE_COOKIES}`,
      targetUrl
    ],
    22000
  );

  const info = JSON.parse(rawJson);
  const durationSec = Number(info.duration) || null;
  const resolutionMap = new Map();
  const audioBitratesSet = new Set();
  const directStreams = {};
  const hlsStreams = [];

  (info.formats || []).forEach(f => {
    if (f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')) {
      if (f.abr) {
        const roundedAbr = f.abr >= 250 ? 320 : f.abr >= 150 ? 192 : 128;
        audioBitratesSet.add(roundedAbr);
      }
    }

    if (f.vcodec && f.vcodec !== 'none' && (f.height || f.format_note)) {
      const noteMatch = String(f.format_note || '').match(/^(\d{3,4})p/);
      const rawDim = noteMatch
        ? Number(noteMatch[1])
        : f.width && f.height
        ? Math.min(f.width, f.height)
        : f.height;

      const res = snapToStandardResolution(rawDim);
      if (!res) return;

      const sizeBytes =
        f.filesize ||
        f.filesize_approx ||
        (f.tbr && durationSec ? Math.round(((f.tbr * 1000) / 8) * durationSec) : null);

      const isH264 = /^avc1|h264/i.test(f.vcodec || '');
      const existing = resolutionMap.get(res);

      if (!existing || (isH264 && !existing.isH264) || (sizeBytes && !existing.sizeBytes)) {
        resolutionMap.set(res, {
          resolution: res,
          ext: 'mp4',
          isH264,
          codec: 'Video (H.264 + AAC)',
          sizeBytes,
          sizeText: formatBytes(sizeBytes)
        });
      }

      if (f.url && /^https?:\/\//i.test(f.url)) {
        if (/\.m3u8(\?|$)/i.test(f.url)) {
          hlsStreams.push(f.url);
        } else if (f.acodec && f.acodec !== 'none') {
          directStreams[res] = { url: f.url, filesize: sizeBytes };
        }
      }
    }
  });

  if (resolutionMap.size === 0 && info.url) {
    const res = snapToStandardResolution(info.height) || 720;
    resolutionMap.set(res, {
      resolution: res,
      ext: 'mp4',
      codec: 'Video (H.264 + AAC)',
      sizeText: formatBytes(info.filesize || info.filesize_approx)
    });
    if (/\.m3u8(\?|$)/i.test(info.url)) {
      hlsStreams.push(info.url);
    } else {
      directStreams[res] = { url: info.url, filesize: info.filesize || null };
    }
  }

  const videoFormats = Array.from(resolutionMap.values()).sort((a, b) => b.resolution - a.resolution);
  if (videoFormats.length === 0) return null;

  const sortedAudioRates =
    audioBitratesSet.size > 0
      ? Array.from(audioBitratesSet).sort((a, b) => b - a)
      : [320, 192, 128];

  const audioFormats = sortedAudioRates.map(rate => ({
    bitrate: rate,
    label: `${rate} kbps`,
    desc: rate >= 256 ? 'MP3 High Bitrate Audio' : rate >= 160 ? 'MP3 Standard Stereo Audio' : 'MP3 Compact Audio'
  }));

  return {
    title: info.title || humanizeUrlSlug(targetUrl),
    extractor: info.extractor_key || info.extractor || parsed.hostname.replace(/^www\./, ''),
    uploader: info.uploader || info.channel || null,
    duration: formatDuration(durationSec) || 'Video',
    thumbnail: info.thumbnail || '',
    resolutions: videoFormats.map(v => v.resolution),
    videoFormats,
    audioFormats,
    verifiedDirectMap: directStreams,
    hlsVariantsByRes: {},
    hlsStreams,
    childPages: [],
    finalPageUrl: info.webpage_url || targetUrl,
    cookieHeader: DEFAULT_AGE_COOKIES
  };
}

module.exports = {
  initLocalBinaries,
  getLocalFfmpegPath,
  runYtDlp,
  inspectViaYtDlp
};