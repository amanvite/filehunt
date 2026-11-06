const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { Readable } = require('stream');

// allow connecting to video hosts with self-signed or incomplete SSL certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const app = express();
const PORT = process.env.PORT || 3000;

const IS_VERCEL = Boolean(process.env.VERCEL || process.env.NOW_REGION);
const TEMP_DIR = IS_VERCEL ? path.join(os.tmpdir(), 'filehunt_temp') : path.join(__dirname, 'temp');

try {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
} catch {}

// check if bundled ffmpeg binary exists on disk
let ffmpegPath = null;
try {
  const candidate = require('ffmpeg-static');
  if (candidate && fs.existsSync(candidate)) {
    ffmpegPath = candidate;
  }
} catch {}

const LOCAL_YTDLP_BIN = path.join(
  TEMP_DIR,
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

let resolvedYtDlpCmd = null;
let ytdlpDownloadPromise = null;

// make sure standalone yt-dlp binary is available locally
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

if (!IS_VERCEL) {
  ensureYtDlpBinary();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/src/components', express.static(path.join(__dirname, 'public', 'components')));

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// universal age-gate bypass cookies so adult sites don't block the scraper with an 18+ splash screen
const DEFAULT_AGE_COOKIES =
  'age_verified=1; over18=1; splash=1; disclaimer=1; verified=1; consented=1; kt_tcookie=1; platform=pc; accessAgeDisclaimerPH=1; expiredEnterModalShown=1';

// standard video heights we bucket streams into
const STANDARD_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144];

function snapToStandardResolution(rawHeight) {
  const n = Number(rawHeight);
  if (!n || isNaN(n) || n < 100) return null;
  if (STANDARD_HEIGHTS.includes(n)) return n;
  // snap close dimensions (e.g. 1072 -> 1080, 540 -> 480, 352 -> 360)
  return STANDARD_HEIGHTS.reduce((prev, curr) =>
    Math.abs(curr - n) < Math.abs(prev - n) ? curr : prev
  );
}

function formatBytes(bytes) {
  const b = Number(bytes);
  if (!b || isNaN(b) || b <= 0) return null;
  const mb = b / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function formatDuration(sec) {
  if (!sec || isNaN(sec) || sec <= 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .trim();
}

function humanizeUrlSlug(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const segments = parsed.pathname
      .split('/')
      .map(s => s.trim())
      .filter(s => s && !/^(video|videos|watch|look|out|go|v|embed|en|de|fr|es|\d+)$/i.test(s));

    const bestSegment = segments.sort((a, b) => b.length - a.length)[0];
    if (bestSegment && bestSegment.length > 2) {
      return decodeURIComponent(bestSegment)
        .replace(/\.(html|php|htm|mp4)$/i, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
    }
    return `Video on ${parsed.hostname.replace(/^www\./, '')}`;
  } catch {
    return 'Video Stream';
  }
}

function sanitizeFilename(rawTitle, suffix = '', ext = 'mp4') {
  const cleaned = decodeHtmlEntities(rawTitle || 'Video')
    .replace(/[\u0000-\u001f"<>|:*?\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 85);

  const base = cleaned || 'Video_Stream';
  const tag = suffix ? `_${suffix}` : '';
  return `${base}${tag}.${ext}`;
}

function resolveAbsoluteUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return '';
  try {
    return new URL(maybeRelative, baseUrl).href;
  } catch {
    return '';
  }
}

// caches for inspected sessions and prepared downloads
const pageSessionCache = new Map();
const preparedDownloadMap = new Map();

const BUILTIN_EXTRACTORS = [
  '1News', '9GAG', 'Abebony', 'ABC', 'AcademicEarth', 'AcFun', 'Archive.org', 'ARD', 'ArteTV',
  'Audiomack', 'Bandcamp', 'BBC', 'Beeg', 'Behance', 'Bilibili', 'BitChute', 'Bloomberg', 'Bluesky',
  'BuzzFeed', 'Camwhores', 'CBC', 'CBS', 'CloudflareStream', 'CNBC', 'CNN', 'ColliderPorn',
  'ComedyCentral', 'Coub', 'Coursera', 'Crunchyroll', 'DaftSex', 'Dailymotion', 'Deezer',
  'Discovery', 'Douyin', 'Dropbox', 'DeutscheWelle', 'edX', 'Eporner', 'ESPN', 'Euronews',
  'Facebook', 'Flickr', 'FoxNews', 'FranceTV', 'Freesound', 'GameSpot', 'Giphy', 'GitHub',
  'GoogleDrive', 'Guardian', 'HClips', 'HotMovs', 'Hotstar', 'HQPorner', 'HuffPost', 'IGN', 'Imdb',
  'Imgur', 'Instagram', 'InternetArchive', 'ITV', 'Ixigua', 'Jamendo', 'JWPlatform', 'Kaltura',
  'KhanAcademy', 'Kick', 'Kickstarter', 'Kuaishou', 'LastFM', 'LBRY', 'LetsPorn', 'LinkedIn',
  'Loom', 'MailRu', 'Mastodon', 'Medaltv', 'Medium', 'Metacafe', 'Mixcloud', 'Motherless', 'MTV',
  'NationalGeographic', 'Naver', 'NBA', 'NBC', 'NDTV', 'NetEaseMusic', 'Newgrounds', 'NextCloud',
  'NFL', 'NHK', 'Niconico', 'NPR', 'NewYorkTimes', 'Odysee', 'Odnoklassniki', 'Panopto', 'Patreon',
  'PBS', 'PeerTube', 'Pinterest', 'Pixiv', 'PlutoTV', 'Podbean', 'Polygon', 'Pornhat', 'Pornhub',
  'Porntrex', 'QQMusic', 'Quora', 'RaiPlay', 'RedBullTV', 'Reddit', 'RedGifs', 'RedTube',
  'Rule34Video', 'Rumble', 'Rutube', 'SharePoint', 'Simplecast', 'SkyNews', 'Slideshare',
  'SmugMug', 'Snapchat', 'SonyLIV', 'SoundCloud', 'SpankBang', 'Spotify', 'Spreaker', 'Steam',
  'Streamable', 'Streamtape', 'Substack', 'SxyPrn', 'TED', 'Telegram', 'TencentVideo',
  'TheGuardian', 'TheVerge', 'ThisVid', 'Threads', 'TikTok', 'TMZ', 'TradingView', 'Triller',
  'Trovo', 'Tube8', 'Tubepornclassic', 'Tumblr', 'TuneIn', 'Twitch', 'Twitter', 'Txxx', 'Udemy',
  'Unity', 'Upornia', 'Ustream', 'Vbox7', 'Vice', 'Vidyard', 'Viki', 'Vimeo', 'Vjav', 'VK',
  'Vocaroo', 'VoxMedia', 'VoyeurHit', 'WashingtonPost', 'WaybackMachine', 'Webex', 'Weibo',
  'Wikimedia', 'Wikipedia', 'Wistia', 'WordPress', 'WSJ', 'WWE', 'X.com', 'XboxClips', 'XHamster',
  'XNXX', 'XVideos', 'Yahoo', 'YandexVideo', 'Youku', 'YouPorn', 'YouTube', 'ZDF', 'Zoom'
];

// unpack Dean Edwards packed JS: eval(function(p,a,c,k,e,d){...})
function unpackDeanEdwards(html) {
  let unpackedChunks = '';
  const packedRegex = /eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]*?\}\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\.split\('\|'\)/gi;
  let match;
  while ((match = packedRegex.exec(html)) !== null) {
    try {
      let payload = match[1];
      const radix = parseInt(match[2], 10);
      let count = parseInt(match[3], 10);
      const symtab = match[4].split('|');

      const encodeBase = (num) => {
        const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        if (num < radix) {
          return num < 36 ? num.toString(36) : chars[num];
        }
        return encodeBase(Math.floor(num / radix)) + encodeBase(num % radix);
      };

      while (count--) {
        if (symtab[count]) {
          const token = encodeBase(count);
          payload = payload.replace(new RegExp(`\\b${token}\\b`, 'g'), symtab[count]);
        }
      }
      unpackedChunks += '\n' + payload;
    } catch {}
  }
  return unpackedChunks;
}

// decode Base64 strings inside atob("...") or base64_decode("...")
function decodeInlineBase64Urls(text) {
  let decodedExtras = '';
  const b64Regex = /(?:atob|base64_decode)\(\s*['"]([A-Za-z0-9+/=]{20,})['"]\s*\)/gi;
  let m;
  while ((m = b64Regex.exec(text)) !== null) {
    try {
      const dec = Buffer.from(m[1], 'base64').toString('utf8');
      if (/https?:\/\/|\.mp4|\.m3u8|\/get_file\//i.test(dec)) {
        decodedExtras += '\n' + dec;
      }
    } catch {}
  }
  return decodedExtras;
}

// decode KVS (kt_player) function/0/ obfuscated URLs
function decodeKvsUrl(rawUrl, licenseCode) {
  if (!rawUrl) return '';
  if (!rawUrl.startsWith('function/0/')) return rawUrl;

  const realUrl = rawUrl.slice('function/0/'.length);
  if (!licenseCode) return realUrl;

  try {
    const cleanLicense = String(licenseCode).replace(/^\$/, '');
    let c = '';
    for (let i = 0; i < cleanLicense.length; i++) {
      c += cleanLicense[i] === '0' ? '1' : cleanLicense[i];
    }

    const s = Math.floor(c.length / 2);
    const k1 = parseInt(c.substring(0, s + 1), 10);
    const k2 = parseInt(c.substring(s), 10);
    const diff = Math.abs(k2 - k1) * 4;
    const diffStr = String(diff);
    const iLen = s + 1;

    const swapTable = [];
    for (let g = 0; g < iLen; g++) {
      for (let h = 1; h <= 4; h++) {
        const d1 = parseInt(cleanLicense[g + h - 1], 10) || 0;
        const d2 = parseInt(diffStr[g % diffStr.length], 10) || 0;
        let sum = d1 + d2;
        if (sum >= 10) sum -= 10;
        swapTable.push(sum);
      }
    }

    const urlParts = realUrl.split('/');
    const tokenIdx = urlParts.findIndex(seg => /^[0-9a-f]{32}/i.test(seg));
    if (tokenIdx === -1) return realUrl;

    const origSeg = urlParts[tokenIdx];
    const hashChars = origSeg.slice(0, 32).split('');
    for (let k = 31; k >= 0; k--) {
      const swapPos = (k + (swapTable[k] || 0)) % 32;
      const tmp = hashChars[k];
      hashChars[k] = hashChars[swapPos];
      hashChars[swapPos] = tmp;
    }

    urlParts[tokenIdx] = hashChars.join('') + origSeg.slice(32);
    return urlParts.join('/');
  } catch {
    return realUrl;
  }
}

async function runYtDlp(args, timeoutMs = 180000) {
  const cmd = await ensureYtDlpBinary();
  if (!cmd) throw new Error('yt-dlp binary unavailable');

  return new Promise((resolve, reject) => {
    let settled = false;
    let proc;
    try {
      const fullArgs = ffmpegPath ? ['--ffmpeg-location', ffmpegPath, ...args] : args;
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

// direct ffmpeg remuxer for HLS (.m3u8) or raw streams when yt-dlp doesn't support a brand-new site
function runFfmpegDirectMux(streamUrl, refererUrl, cookieHeader, outFilePath, isMp3 = false, bitrate = '192') {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg binary not found'));

    let headersStr = `User-Agent: ${BROWSER_UA}\r\n`;
    if (refererUrl) headersStr += `Referer: ${refererUrl}\r\n`;
    if (cookieHeader) headersStr += `Cookie: ${cookieHeader}\r\n`;

    const args = ['-y', '-headers', headersStr, '-i', streamUrl];

    if (isMp3) {
      args.push('-vn', '-acodec', 'libmp3lame', '-b:a', `${bitrate}k`, outFilePath);
    } else {
      args.push('-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', outFilePath);
    }

    let settled = false;
    const proc = spawn(ffmpegPath, args);
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill(); } catch {}
        reject(new Error('ffmpeg mux timeout'));
      }
    }, 180000);

    proc.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    proc.on('close', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outFilePath) && fs.statSync(outFilePath).size > 25000) {
          resolve(outFilePath);
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      }
    });
  });
}

// parse an HLS (.m3u8) master playlist to discover the EXACT resolutions available inside the stream
async function parseHlsMasterManifest(m3u8Url, refererUrl, cookieHeader) {
  const variants = {};
  try {
    const res = await fetch(m3u8Url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': refererUrl,
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return variants;
    const text = await res.text();
    if (!text.includes('#EXTM3U')) return variants;

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
        const nameMatch = line.match(/NAME="?(2160|1440|1080|720|480|360|240|144)p?"?/i);
        const bwMatch = line.match(/BANDWIDTH=(\d+)/i);

        let height = null;
        if (resMatch) {
          const w = parseInt(resMatch[1], 10);
          const h = parseInt(resMatch[2], 10);
          height = snapToStandardResolution(Math.min(w, h));
        } else if (nameMatch) {
          height = snapToStandardResolution(parseInt(nameMatch[1], 10));
        }

        // find the next non-comment line which is the variant URI
        let nextUri = null;
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].startsWith('#')) {
            nextUri = lines[j];
            break;
          }
        }

        if (height && nextUri) {
          const absVariantUrl = resolveAbsoluteUrl(nextUri, res.url || m3u8Url);
          if (absVariantUrl && !variants[height]) {
            variants[height] = {
              url: absVariantUrl,
              bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : null
            };
          }
        }
      }
    }

    // if it's a single-stream media playlist (#EXTINF segments directly), record it as a single resolution
    if (Object.keys(variants).length === 0 && text.includes('#EXTINF:')) {
      const resFromUrl = m3u8Url.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
      const h = resFromUrl ? Number(resFromUrl[1]) : 720;
      variants[h] = { url: m3u8Url, bandwidth: null };
    }
  } catch {}
  return variants;
}

// locate installed Chrome or Edge binary on the machine for the headless browser fallback
function findLocalBrowserExecutable() {
  if (IS_VERCEL) return null;
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        ];

  return candidates.find(p => p && fs.existsSync(p)) || null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Tier 3 Fallback: Headless Chrome/Edge DOM & Network Inspector for sites that build players dynamically via JS
async function inspectViaHeadlessBrowser(targetUrl) {
  const browserBin = findLocalBrowserExecutable();
  if (!browserBin) return null;

  let proc = null;
  const profileDir = path.join(TEMP_DIR, `chrome_prof_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);

  try {
    const port = await getFreePort();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--headless=new',
      '--disable-gpu',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      `--user-agent=${BROWSER_UA}`,
      targetUrl
    ];

    proc = spawn(browserBin, args, { stdio: 'ignore' });

    // wait for DevTools HTTP endpoint to come up
    let wsUrl = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, 300));
      try {
        const listRes = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) });
        if (listRes.ok) {
          const targets = await listRes.json();
          const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
          if (pageTarget) {
            wsUrl = pageTarget.webSocketDebuggerUrl;
            break;
          }
        }
      } catch {}
    }

    if (!wsUrl || typeof WebSocket === 'undefined') {
      return null;
    }

    const capturedUrls = new Set();
    let domResult = null;

    await new Promise(resolve => {
      const ws = new WebSocket(wsUrl);
      let msgId = 1;

      const sendCmd = (method, params = {}) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: msgId++, method, params }));
        }
      };

      const finish = () => {
        try { ws.close(); } catch {}
        resolve();
      };

      const timeout = setTimeout(finish, 6500);

      ws.addEventListener('open', () => {
        sendCmd('Network.enable');
        sendCmd('Page.enable');
        // after 2.8 seconds of JS execution, click any play/age-gate button and harvest all video & network resources
        setTimeout(() => {
          const jsExpr = `(() => {
            try {
              document.querySelectorAll('.vjs-big-play-button, .fp-play, .kt-play, [class*="play"], button').forEach(b => {
                if (/play|watch|enter|agree|18|yes/i.test(b.innerText || b.className || '')) b.click();
              });
            } catch {}
            const vids = Array.from(document.querySelectorAll('video, source')).map(v => ({
              src: v.currentSrc || v.src || v.getAttribute('data-src') || '',
              label: v.getAttribute('label') || v.getAttribute('title') || v.getAttribute('res') || ''
            })).filter(v => v.src);
            const resPerf = performance.getEntriesByType('resource').map(r => r.name);
            return JSON.stringify({
              title: document.title,
              cookie: document.cookie,
              html: document.documentElement.outerHTML.slice(0, 250000),
              vids,
              resPerf
            });
          })()`;
          sendCmd('Runtime.evaluate', { expression: jsExpr, returnByValue: true });
        }, 2800);
      });

      ws.addEventListener('message', event => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.method === 'Network.requestWillBeSent') {
            const reqUrl = msg.params?.request?.url || '';
            if (/\.(mp4|m3u8|webm|m4v)(\?|$)|\/get_file\/|videoplayback|master\.m3u8/i.test(reqUrl)) {
              capturedUrls.add(reqUrl);
            }
          }
          if (msg.result?.result?.value) {
            domResult = JSON.parse(msg.result.result.value);
            clearTimeout(timeout);
            finish();
          }
        } catch {}
      });

      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        finish();
      });
    });

    if (!domResult && capturedUrls.size === 0) return null;

    const directStreams = {};
    const hlsStreams = [];

    if (domResult?.html) {
      extractStreamsFromHtml(domResult.html, targetUrl, directStreams, hlsStreams);
    }

    (domResult?.vids || []).forEach(v => {
      if (!v.src || v.src.startsWith('blob:')) return;
      const abs = resolveAbsoluteUrl(v.src, targetUrl);
      if (/\.m3u8(\?|$)/i.test(abs)) {
        hlsStreams.push(abs);
      } else if (/^https?:\/\//i.test(abs)) {
        const resHit = (v.label || abs).match(/(2160|1440|1080|720|480|360|240|144)/);
        const r = resHit ? Number(resHit[1]) : 720;
        directStreams[r] = abs;
      }
    });

    [...capturedUrls, ...(domResult?.resPerf || [])].forEach(u => {
      if (!u || /^blob:/i.test(u)) return;
      if (/preview|thumb|sprite|banner|logo|ads/i.test(u)) return;
      if (/\.m3u8(\?|$)/i.test(u)) {
        hlsStreams.push(u);
      } else if (/\.(mp4|webm|m4v)(\?|$)|\/get_file\//i.test(u)) {
        const resHit = u.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
        const r = resHit ? Number(resHit[1]) : !directStreams[720] ? 720 : 480;
        if (!directStreams[r]) directStreams[r] = u;
      }
    });

    return {
      title: domResult?.title || null,
      cookieHeader: domResult?.cookie || '',
      directStreams,
      hlsStreams: [...new Set(hlsStreams)]
    };
  } catch {
    return null;
  } finally {
    if (proc) {
      try { proc.kill('SIGKILL'); } catch {}
    }
    setTimeout(() => {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
    }, 2000);
  }
}

// extract streams from raw HTML covering KVS, XVideos, Pornhub, xHamster, SpankBang, SxyPrn, Eporner, JWPlayer, packed JS, etc.
function extractStreamsFromHtml(rawHtml, baseUrl, directStreams = {}, hlsStreams = []) {
  const unpacked = unpackDeanEdwards(rawHtml);
  const b64Decoded = decodeInlineBase64Urls(rawHtml + '\n' + unpacked);
  const combined = rawHtml + '\n' + unpacked + '\n' + b64Decoded;

  const unescaped = combined
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');

  let urlDecodedExtras = '';
  const encodedUrlRegex = /https?%3A%2F%2F[^\s"'<>\\&]+/gi;
  let encMatch;
  while ((encMatch = encodedUrlRegex.exec(unescaped)) !== null) {
    try {
      urlDecodedExtras += '\n' + decodeURIComponent(encMatch[0]);
    } catch {}
  }

  const fullText = unescaped + '\n' + urlDecodedExtras;

  // 1. XVideos / XNXX (html5player.setVideoUrlHigh / Low / HLS)
  const xvHigh = fullText.match(/setVideoUrlHigh\(\s*['"]([^'"]+)['"]\s*\)/i);
  const xvLow = fullText.match(/setVideoUrlLow\(\s*['"]([^'"]+)['"]\s*\)/i);
  const xvHls = fullText.match(/setVideoHLS\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (xvHigh?.[1]) directStreams[720] = resolveAbsoluteUrl(xvHigh[1], baseUrl);
  if (xvLow?.[1]) directStreams[360] = resolveAbsoluteUrl(xvLow[1], baseUrl);
  if (xvHls?.[1]) hlsStreams.push(resolveAbsoluteUrl(xvHls[1], baseUrl));

  // 2. Pornhub / RedTube / YouPorn / Tube8 mediaDefinitions
  const mediaDefRegex = /"videoUrl"\s*:\s*"([^"]+)"\s*,\s*"quality"\s*:\s*"?(\d{3,4})"?/gi;
  let mdMatch;
  while ((mdMatch = mediaDefRegex.exec(fullText)) !== null) {
    const vUrl = mdMatch[1];
    const q = snapToStandardResolution(mdMatch[2]);
    if (vUrl && q && /^https?:\/\//i.test(vUrl)) {
      if (/\.m3u8/i.test(vUrl)) hlsStreams.push(vUrl);
      else directStreams[q] = vUrl;
    }
  }

  // 3. SpankBang stream_data object
  const sbQualities = ['2160p', '1440p', '1080p', '720p', '480p', '360p', '240p'];
  sbQualities.forEach(qKey => {
    const sbMatch = fullText.match(new RegExp(`['"]?${qKey}['"]?\\s*:\\s*\\[\\s*['"](https?:\\/\\/[^'"]+)['"]`, 'i'));
    if (sbMatch?.[1]) {
      const h = parseInt(qKey, 10);
      if (/\.m3u8/i.test(sbMatch[1])) hlsStreams.push(sbMatch[1]);
      else directStreams[h] = sbMatch[1];
    }
  });

  // 4. xHamster & mirror domains window.initials
  const initialsMatch = fullText.match(/window\.initials\s*=\s*(\{[\s\S]*?\});\s*<\/script>/i);
  if (initialsMatch) {
    try {
      const initials = JSON.parse(initialsMatch[1]);
      const mp4Sources =
        initials?.xplayerSettings?.sources?.standard?.h264 ||
        initials?.xplayerSettings?.sources?.standard?.mp4 ||
        initials?.videoModel?.sources?.mp4 ||
        [];

      if (Array.isArray(mp4Sources)) {
        mp4Sources.forEach(item => {
          const u = item?.url || item?.fallback;
          const q = snapToStandardResolution(parseInt(String(item?.quality || item?.label || '720'), 10));
          if (u && q && !/\.m3u8(\?|$)/i.test(u)) {
            directStreams[q] = resolveAbsoluteUrl(u, baseUrl);
          } else if (u && /\.m3u8(\?|$)/i.test(u)) {
            hlsStreams.push(resolveAbsoluteUrl(u, baseUrl));
          }
        });
      }

      const hlsObj = initials?.xplayerSettings?.sources?.hls;
      if (hlsObj) {
        Object.values(hlsObj).forEach(entry => {
          if (entry?.url) hlsStreams.push(resolveAbsoluteUrl(entry.url, baseUrl));
        });
      }
    } catch {}
  }

  // 5. KVS (kt_player) flashvars
  const licenseMatch = fullText.match(/license_code\s*:\s*['"]([^'"]+)['"]/i);
  const licenseCode = licenseMatch ? licenseMatch[1] : '';

  const kvsKeys = [
    { key: 'video_url', defaultRes: 720, textKey: 'video_url_text' },
    { key: 'video_alt_url', defaultRes: 1080, textKey: 'video_alt_url_text' },
    { key: 'video_alt_url2', defaultRes: 1080, textKey: 'video_alt_url2_text' },
    { key: 'video_alt_url3', defaultRes: 2160, textKey: 'video_alt_url3_text' }
  ];

  kvsKeys.forEach(({ key, defaultRes, textKey }) => {
    const valMatch = fullText.match(new RegExp(`${key}\\s*:\\s*['"]([^'"]+)['"]`, 'i'));
    if (valMatch && valMatch[1]) {
      const decoded = decodeKvsUrl(valMatch[1], licenseCode);
      const absUrl = resolveAbsoluteUrl(decoded, baseUrl);
      if (absUrl && /^https?:\/\//i.test(absUrl)) {
        const textMatch = fullText.match(new RegExp(`${textKey}\\s*:\\s*['"]([^'"]+)['"]`, 'i'));
        const resMatch =
          (textMatch && textMatch[1].match(/(2160|1440|1080|720|480|360|240)/)) ||
          absUrl.match(/[_/-](2160|1440|1080|720|480|360|240)p?\b/i);
        const res = resMatch ? Number(resMatch[1]) : defaultRes;
        directStreams[res] = absUrl;
      }
    }
  });

  // 6. Generic JWPlayer / FluidPlayer / Plyr / VideoJS / Motherless (__fileurl) properties
  const playerPropRegex = /(?:__fileurl|file|src|video_url|mp4_url|stream_url|contentUrl|hq_video_file|normal_video_file)\s*[:=]\s*['"](https?:\/\/[^'"\s<>]+)['"]/gi;
  let pMatch;
  while ((pMatch = playerPropRegex.exec(fullText)) !== null) {
    const candidate = pMatch[1];
    if (/\.(jpg|jpeg|png|webp|gif|svg|css|js|vtt|srt|xml|html|php)(\?|$)/i.test(candidate)) continue;
    if (/preview|thumb|sprite|banner|logo|ads/i.test(candidate)) continue;

    if (/\.m3u8(\?|$)/i.test(candidate)) {
      hlsStreams.push(candidate);
    } else if (/\.(mp4|webm|m4v|mov)(\?|$)|\/get_file\/|\/stream\/|\/mp4\//i.test(candidate)) {
      const resHit = candidate.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
      const resKey = resHit ? Number(resHit[1]) : 720;
      if (!directStreams[resKey]) {
        directStreams[resKey] = candidate;
      }
    }
  }

  // 7. <source>, <video>, and data-video / data-mp4 attributes
  const mediaTagRegex = /<(?:source|video|div|a)[^>]+(?:src|data-src|data-video|data-mp4|data-url)=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = mediaTagRegex.exec(fullText)) !== null) {
    const rawSrc = m[1].trim();
    if (!rawSrc || rawSrc.startsWith('blob:') || rawSrc.startsWith('#')) continue;
    const srcUrl = resolveAbsoluteUrl(rawSrc, baseUrl);
    if (!/^https?:\/\//i.test(srcUrl)) continue;
    if (/\.(jpg|jpeg|png|webp|gif|svg|css|js|html|php)(\?|$)/i.test(srcUrl)) continue;

    if (/\.m3u8(\?|$)/i.test(srcUrl)) {
      hlsStreams.push(srcUrl);
      continue;
    }

    if (/\.(mp4|webm|m4v)(\?|$)|\/get_file\//i.test(srcUrl)) {
      const labelMatch =
        m[0].match(/(?:label|title|res|data-res|size)=["']?(2160|1440|1080|720|480|360|240|144)p?/i) ||
        srcUrl.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
      const res = labelMatch ? Number(labelMatch[1]) : 720;
      if (!directStreams[res]) {
        directStreams[res] = srcUrl;
      }
    }
  }

  // 8. Scan for any remaining .m3u8 manifests or direct .mp4 / get_file URLs
  const m3u8Regex = /https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]+)?/gi;
  let hMatch;
  while ((hMatch = m3u8Regex.exec(fullText)) !== null) {
    hlsStreams.push(hMatch[0]);
  }

  const directUrlRegex = /https?:\/\/[^\s"'<>\\]+?(?:\.(?:mp4|webm|m4v)(?:\?[^\s"'<>\\]*)?|\/get_file\/\d+\/[0-9a-f]{32}\/[^\s"'<>\\]+)/gi;
  let uMatch;
  while ((uMatch = directUrlRegex.exec(fullText)) !== null) {
    const candidate = uMatch[0].replace(/['",;)+]+$/, '');
    if (/\.m3u8|preview|thumb|sprite|banner|logo|trailer|_TPL_/i.test(candidate)) continue;
    const resHit = candidate.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
    const resKey = resHit ? Number(resHit[1]) : 720;
    if (!directStreams[resKey]) {
      directStreams[resKey] = candidate;
    }
  }

  return { directStreams, hlsStreams };
}

function findChildMediaPages(html, baseUrl) {
  const candidates = [];

  const metaRefresh = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'\s>]+)/i);
  if (metaRefresh?.[1]) {
    candidates.push(resolveAbsoluteUrl(metaRefresh[1], baseUrl));
  }

  const locRedirect = html.match(/window\.location(?:\.href|\.replace)?\s*(?:=|\()\s*['"](https?:\/\/[^'"]+)['"]/i);
  if (locRedirect?.[1]) {
    candidates.push(locRedirect[1]);
  }

  const iframeRegex = /<(?:iframe|embed|frame)[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi;
  let iMatch;
  while ((iMatch = iframeRegex.exec(html)) !== null) {
    const src = iMatch[1];
    if (/ads|banner|doubleclick|exoclick|juicyads|traffic|chat|magsrv|realsrv|syndication|captcha/i.test(src)) {
      continue;
    }
    const abs = resolveAbsoluteUrl(src, baseUrl);
    if (abs && /^https?:\/\//i.test(abs)) {
      candidates.push(abs);
    }
  }

  return [...new Set(candidates)].slice(0, 4);
}

// probe direct MP4 streams to verify they are real video files and get their exact MB file size
async function verifyAndMeasureDirectStreams(directStreams, refererUrl, cookieHeader) {
  const verified = {};
  const entries = Object.entries(directStreams);

  await Promise.all(
    entries.map(async ([resKey, streamUrl]) => {
      try {
        const probe = await fetch(streamUrl, {
          method: 'GET',
          headers: {
            'User-Agent': BROWSER_UA,
            'Referer': refererUrl,
            'Range': 'bytes=0-16383',
            ...(cookieHeader ? { Cookie: cookieHeader } : {})
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(5000)
        });

        const contentType = (probe.headers.get('content-type') || '').toLowerCase();
        const contentRange = probe.headers.get('content-range') || '';
        const totalMatch = contentRange.match(/\/(\d+)/);
        const totalBytes = totalMatch
          ? Number(totalMatch[1])
          : Number(probe.headers.get('content-length') || 0);

        const chunk = Buffer.from(await probe.arrayBuffer());
        try { probe.body?.cancel?.(); } catch {}

        const headStr = chunk.slice(0, 32).toString('utf8');
        const isHtmlOrManifest =
          contentType.includes('text/html') ||
          contentType.includes('text/plain') ||
          contentType.includes('application/json') ||
          contentType.includes('mpegurl') ||
          headStr.includes('<!DOCTYPE') ||
          headStr.includes('<html') ||
          headStr.includes('#EXTM3U');

        if (probe.ok && !isHtmlOrManifest && (totalBytes > 40000 || chunk.length >= 8192)) {
          verified[Number(resKey)] = {
            url: streamUrl,
            filesize: totalBytes > 40000 ? totalBytes : null
          };
        }
      } catch {}
    })
  );

  return verified;
}

// deep page inspector: scrapes HTML, child iframes, HLS manifests, and headless browser if needed
async function inspectPageDeep(targetUrl) {
  if (pageSessionCache.has(targetUrl)) {
    const cached = pageSessionCache.get(targetUrl);
    if (Date.now() - cached.timestamp < 5 * 60 * 1000) {
      return cached.data;
    }
  }

  const parsed = new URL(targetUrl);
  const hostLabel = parsed.hostname.replace(/^www\./, '').toUpperCase();

  let html = '';
  let cookieHeader = DEFAULT_AGE_COOKIES;
  let finalPageUrl = targetUrl;

  try {
    const pageRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': parsed.origin + '/',
        'Cookie': DEFAULT_AGE_COOKIES
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(9000)
    });

    if (pageRes.url) finalPageUrl = pageRes.url;

    const rawCookies = pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : [];
    if (rawCookies.length > 0) {
      cookieHeader = DEFAULT_AGE_COOKIES + '; ' + rawCookies.map(c => c.split(';')[0]).join('; ');
    } else {
      const singleCookie = pageRes.headers.get('set-cookie');
      if (singleCookie) {
        const parsedSingle = singleCookie
          .split(/,(?=\s*[a-zA-Z0-9_-]+=)/)
          .map(c => c.split(';')[0].trim())
          .join('; ');
        cookieHeader = DEFAULT_AGE_COOKIES + '; ' + parsedSingle;
      }
    }

    html = await pageRes.text();
  } catch {}

  const getMeta = prop => {
    const r1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
    const r2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
    return (html.match(r1)?.[1] || html.match(r2)?.[1] || '').trim();
  };

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const kvsTitleMatch = html.match(/video_title\s*:\s*['"]([^'"]+)['"]/i);
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);

  let rawTitle = decodeHtmlEntities(
    getMeta('og:title') ||
      getMeta('twitter:title') ||
      (kvsTitleMatch ? kvsTitleMatch[1] : '') ||
      (h1Match ? h1Match[1] : '') ||
      (titleMatch ? titleMatch[1] : '') ||
      humanizeUrlSlug(finalPageUrl)
  );

  // parse duration from meta tags or JSON-LD if present
  const durMeta =
    getMeta('video:duration') ||
    getMeta('og:video:duration') ||
    html.match(/"duration"\s*:\s*"?PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"?/i);
  let durationSec = null;
  if (typeof durMeta === 'string' && /^\d+$/.test(durMeta)) {
    durationSec = Number(durMeta);
  } else if (Array.isArray(durMeta)) {
    durationSec =
      (Number(durMeta[1] || 0) * 3600) +
      (Number(durMeta[2] || 0) * 60) +
      Number(durMeta[3] || 0);
  }

  const kvsThumbMatch = html.match(/preview_url\s*:\s*['"]([^'"]+)['"]/i);
  const posterMatch = html.match(/poster=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i);

  const rawThumb =
    getMeta('og:image') ||
    getMeta('twitter:image') ||
    (kvsThumbMatch ? kvsThumbMatch[1].replace(/\\\//g, '/') : '') ||
    (posterMatch ? posterMatch[1] : '');

  const thumbnail = resolveAbsoluteUrl(rawThumb, finalPageUrl);
  const directStreams = {};
  const hlsStreams = [];

  if (html) {
    extractStreamsFromHtml(html, finalPageUrl, directStreams, hlsStreams);
  }

  // crawl child embed iframes if main page is a wrapper
  const childPages = html ? findChildMediaPages(html, finalPageUrl) : [];
  if (Object.keys(directStreams).length === 0 && hlsStreams.length === 0 && childPages.length > 0) {
    for (const childUrl of childPages) {
      try {
        const childRes = await fetch(childUrl, {
          headers: {
            'User-Agent': BROWSER_UA,
            'Referer': finalPageUrl,
            'Cookie': cookieHeader
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(6000)
        });
        if (childRes.ok) {
          const childHtml = await childRes.text();
          extractStreamsFromHtml(childHtml, childRes.url || childUrl, directStreams, hlsStreams);
          if (Object.keys(directStreams).length > 0 || hlsStreams.length > 0) break;
        }
      } catch {}
    }
  }

  // if static HTML + child iframes still found 0 streams, launch Headless Chrome/Edge sniffer
  if (!IS_VERCEL && Object.keys(directStreams).length === 0 && hlsStreams.length === 0) {
    const headlessData = await inspectViaHeadlessBrowser(targetUrl);
    if (headlessData) {
      if (headlessData.title && (!rawTitle || rawTitle.startsWith('Video on'))) {
        rawTitle = headlessData.title;
      }
      if (headlessData.cookieHeader) {
        cookieHeader += '; ' + headlessData.cookieHeader;
      }
      Object.assign(directStreams, headlessData.directStreams || {});
      (headlessData.hlsStreams || []).forEach(u => hlsStreams.push(u));
    }
  }

  // verify direct MP4 streams and measure their real file sizes
  const verifiedDirectMap = await verifyAndMeasureDirectStreams(directStreams, finalPageUrl, cookieHeader);

  // parse any HLS (.m3u8) master manifests to discover the exact resolutions inside
  const uniqueHls = [...new Set(hlsStreams)];
  const hlsVariantsByRes = {};
  for (const m3u8Url of uniqueHls.slice(0, 3)) {
    const parsedVariants = await parseHlsMasterManifest(m3u8Url, finalPageUrl, cookieHeader);
    Object.entries(parsedVariants).forEach(([resKey, info]) => {
      if (!hlsVariantsByRes[resKey]) {
        hlsVariantsByRes[resKey] = info;
      }
    });
  }

  // combine ONLY the real verified resolutions discovered from direct MP4s + HLS manifests
  const allRealResolutions = [
    ...new Set([
      ...Object.keys(verifiedDirectMap).map(Number),
      ...Object.keys(hlsVariantsByRes).map(Number)
    ])
  ]
    .filter(Boolean)
    .sort((a, b) => b - a);

  const videoFormats = allRealResolutions.map(res => {
    const directInfo = verifiedDirectMap[res];
    const hlsInfo = hlsVariantsByRes[res];
    const estBytes =
      directInfo?.filesize ||
      (hlsInfo?.bandwidth && durationSec ? Math.round((hlsInfo.bandwidth / 8) * durationSec) : null);

    return {
      resolution: res,
      ext: 'mp4',
      codec: 'Video (H.264 + AAC)',
      sizeText: formatBytes(estBytes)
    };
  });

  // audio formats available via ffmpeg audio extraction when a video stream exists
  const audioFormats =
    videoFormats.length > 0
      ? [
          { bitrate: 320, label: '320 kbps', desc: 'MP3 High Bitrate Audio' },
          { bitrate: 192, label: '192 kbps', desc: 'MP3 Standard Stereo Audio' },
          { bitrate: 128, label: '128 kbps', desc: 'MP3 Compact Audio' }
        ]
      : [];

  const resultData = {
    title: rawTitle || humanizeUrlSlug(finalPageUrl),
    extractor: decodeHtmlEntities(getMeta('og:site_name')) || hostLabel,
    duration: formatDuration(durationSec) || 'Video',
    thumbnail,
    resolutions: allRealResolutions,
    videoFormats,
    audioFormats,
    verifiedDirectMap,
    hlsVariantsByRes,
    hlsStreams: uniqueHls,
    childPages,
    finalPageUrl,
    cookieHeader
  };

  if (videoFormats.length > 0) {
    pageSessionCache.set(targetUrl, { timestamp: Date.now(), data: resultData });
  }

  return resultData;
}

// inspect via yt-dlp --dump-single-json to get the EXACT real resolutions, duration, and file sizes
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
    25000
  );

  const info = JSON.parse(rawJson);
  const durationSec = Number(info.duration) || null;
  const resolutionMap = new Map();
  const audioBitratesSet = new Set();
  const directStreams = {};
  const hlsStreams = [];

  (info.formats || []).forEach(f => {
    // check audio tracks
    if (f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')) {
      if (f.abr) {
        const roundedAbr = f.abr >= 250 ? 320 : f.abr >= 150 ? 192 : 128;
        audioBitratesSet.add(roundedAbr);
      }
    }

    // check video tracks for real available resolutions
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

  // if single-file extractor returned info.url directly without a formats array
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

  const resultData = {
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

  pageSessionCache.set(targetUrl, { timestamp: Date.now(), data: resultData });
  return resultData;
}

// GET /api/proxy-image - proxy thumbnails with Referer + automatic YouTube maxresdefault -> hqdefault fallback
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  try {
    const parsed = new URL(url);
    let imgRes = await fetch(parsed.href, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': parsed.origin + '/'
      },
      signal: AbortSignal.timeout(5000)
    });

    // if a YouTube maxresdefault thumbnail 404s, automatically fallback to hqdefault.jpg
    if (!imgRes.ok && parsed.hostname.includes('ytimg.com') && parsed.pathname.includes('maxresdefault')) {
      const fallbackYtThumb = parsed.href.replace('maxresdefault', 'hqdefault');
      imgRes = await fetch(fallbackYtThumb, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(5000)
      });
    }

    if (!imgRes.ok) return res.status(404).end();
    res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const arrayBuffer = await imgRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch {
    res.status(404).end();
  }
});

// POST /api/info - inspects the video and returns ONLY the real qualities available for that specific link
app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Please paste a valid video link.' });

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return res.status(400).json({ error: 'Invalid link format. Make sure it starts with https://' });
  }

  // 1. Try yt-dlp real format inspection first (accurate per-video resolutions for YouTube & 1,800+ sites)
  try {
    const ytData = await inspectViaYtDlp(parsed.href);
    if (ytData && ytData.videoFormats && ytData.videoFormats.length > 0) {
      return res.json({
        title: ytData.title,
        extractor: ytData.extractor,
        uploader: ytData.uploader,
        duration: ytData.duration,
        thumbnail: ytData.thumbnail,
        resolutions: ytData.resolutions,
        videoFormats: ytData.videoFormats,
        audioFormats: ytData.audioFormats
      });
    }
  } catch {}

  // 2. Deep HTML / KVS / HLS Manifest / Child Iframe / Headless Browser inspection
  try {
    const deepData = await inspectPageDeep(parsed.href);
    if (deepData && deepData.videoFormats && deepData.videoFormats.length > 0) {
      return res.json({
        title: deepData.title,
        extractor: deepData.extractor,
        uploader: deepData.uploader || null,
        duration: deepData.duration,
        thumbnail: deepData.thumbnail,
        resolutions: deepData.resolutions,
        videoFormats: deepData.videoFormats,
        audioFormats: deepData.audioFormats
      });
    }
  } catch {}

  return res.status(422).json({
    error:
      'We apologize, but FileHunt could not find any downloadable video streams on this link. Please verify that the URL points directly to a public video.'
  });
});

// prepare or download the exact requested quality
async function resolveOrPrepareDownload({ url, title, type, resolution, bitrate }) {
  const ext = type === 'mp3' ? 'mp3' : 'mp4';
  const suffix = type === 'mp3' ? `${bitrate}kbps` : `${resolution}p`;
  const cleanFilename = sanitizeFilename(title, suffix, ext);

  const cachedSession = pageSessionCache.get(url)?.data || (await inspectPageDeep(url));
  const sessionCookies = cachedSession.cookieHeader || DEFAULT_AGE_COOKIES;
  const refererToUse = cachedSession.finalPageUrl || url;
  const targetResNum = Number(resolution);

  // 1. Direct MP4 stream for the exact requested resolution
  if (type !== 'mp3') {
    const directMap = cachedSession.verifiedDirectMap || {};
    const exactDirect =
      directMap[targetResNum] ||
      directMap[Object.keys(directMap).map(Number).sort((a, b) => b - a)[0]];

    if (exactDirect?.url && !/\.m3u8(\?|$)/i.test(exactDirect.url)) {
      const token = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      preparedDownloadMap.set(token, {
        mode: 'direct',
        streamUrl: exactDirect.url,
        referer: refererToUse,
        cookies: sessionCookies,
        filename: cleanFilename,
        ext
      });
      return { ok: true, token, filename: cleanFilename };
    }
  }

  // 2. Local yt-dlp download at the exact requested resolution
  if (!IS_VERCEL) {
    const hlsVariant = cachedSession.hlsVariantsByRes?.[targetResNum]?.url;
    const directUrlForAudio =
      cachedSession.verifiedDirectMap?.[targetResNum]?.url ||
      Object.values(cachedSession.verifiedDirectMap || {})[0]?.url;

    const candidateTargets = [
      ...new Set(
        [
          hlsVariant,
          url,
          cachedSession.finalPageUrl,
          ...(cachedSession.childPages || []),
          ...(cachedSession.hlsStreams || []),
          directUrlForAudio
        ].filter(Boolean)
      )
    ];

    for (const targetToRun of candidateTargets) {
      try {
        const jobId = `fh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const outTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);
        const args = [
          '--no-playlist',
          '--no-part',
          '--no-warnings',
          '--no-check-certificates',
          '--referer',
          refererToUse,
          '--user-agent',
          BROWSER_UA,
          '--add-header',
          `Cookie:${sessionCookies}`,
          '-o',
          outTemplate
        ];

        if (type === 'mp3') {
          args.push('-f', 'bestaudio/best');
          if (ffmpegPath) {
            args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', `${bitrate}K`);
          }
        } else {
          const formatSelector = ffmpegPath
            ? `bestvideo[height<=${targetResNum}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=${targetResNum}][ext=mp4]/bestvideo[height<=${targetResNum}]+bestaudio/best[height<=${targetResNum}]/best`
            : `best[height<=${targetResNum}][ext=mp4]/best[ext=mp4]/best`;

          args.push('-f', formatSelector);
          if (ffmpegPath) {
            args.push('--merge-output-format', 'mp4');
          }
        }

        args.push(targetToRun);
        await runYtDlp(args, 240000);

        const producedFiles = fs
          .readdirSync(TEMP_DIR)
          .filter(f => f.startsWith(jobId) && !f.endsWith('.part') && !f.endsWith('.ytdl'));

        if (producedFiles.length > 0) {
          const fullPath = path.join(TEMP_DIR, producedFiles[0]);
          const stat = fs.statSync(fullPath);

          if (stat.size > 25000) {
            const actualExt = path.extname(producedFiles[0]).replace('.', '') || ext;
            const finalDownloadName = sanitizeFilename(title, suffix, actualExt);
            const token = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            preparedDownloadMap.set(token, {
              mode: 'file',
              filePath: fullPath,
              filename: finalDownloadName
            });
            return { ok: true, token, filename: finalDownloadName };
          } else {
            fs.unlink(fullPath, () => {});
          }
        }
      } catch {}
    }

    // 3. Direct ffmpeg remuxer for HLS variant streams or raw streams when yt-dlp doesn't recognize the host
    const ffmpegCandidates = [
      hlsVariant,
      ...(cachedSession.hlsStreams || []),
      directUrlForAudio
    ].filter(Boolean);

    if (ffmpegPath && ffmpegCandidates.length > 0) {
      for (const streamCandidate of ffmpegCandidates) {
        try {
          const jobId = `ff_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const outFilePath = path.join(TEMP_DIR, `${jobId}.${ext}`);
          await runFfmpegDirectMux(
            streamCandidate,
            refererToUse,
            sessionCookies,
            outFilePath,
            type === 'mp3',
            bitrate
          );
          const token = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          preparedDownloadMap.set(token, {
            mode: 'file',
            filePath: outFilePath,
            filename: cleanFilename
          });
          return { ok: true, token, filename: cleanFilename };
        } catch {}
      }
    }
  }

  return { ok: false };
}

// GET /api/download - prepares or streams the verified file
app.get('/api/download', async (req, res) => {
  const { url, title = 'Video', type = 'mp4', resolution = '720', bitrate = '192', prepare, token } = req.query;

  if (token && preparedDownloadMap.has(token)) {
    const entry = preparedDownloadMap.get(token);
    preparedDownloadMap.delete(token);

    if (entry.mode === 'file' && fs.existsSync(entry.filePath)) {
      return res.download(entry.filePath, entry.filename, () => {
        fs.unlink(entry.filePath, () => {});
      });
    }

    if (entry.mode === 'direct') {
      try {
        const upstream = await fetch(entry.streamUrl, {
          headers: {
            'User-Agent': BROWSER_UA,
            'Referer': entry.referer,
            ...(entry.cookies ? { Cookie: entry.cookies } : {})
          },
          redirect: 'follow'
        });

        if (upstream.ok && upstream.body) {
          const contentLen = Number(upstream.headers.get('content-length') || 0);
          res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
          res.setHeader('Content-Type', entry.ext === 'mp3' ? 'audio/mpeg' : 'video/mp4');
          if (contentLen) res.setHeader('Content-Length', String(contentLen));
          Readable.fromWeb(upstream.body).pipe(res);
          return;
        }
      } catch {}
    }
  }

  if (!url) {
    if (prepare === '1') return res.status(400).json({ ok: false });
    return res.redirect('/?apology=1');
  }

  const result = await resolveOrPrepareDownload({ url, title, type, resolution, bitrate });

  if (prepare === '1') {
    if (result.ok) {
      return res.json({
        ok: true,
        downloadUrl: `/api/download?token=${encodeURIComponent(result.token)}`,
        filename: result.filename
      });
    }
    return res.status(422).json({
      ok: false,
      apology:
        'We apologize, but FileHunt is unable to extract a downloadable video from this link right now. Please verify that the page contains a public video and try again.'
    });
  }

  if (result.ok) {
    return res.redirect(`/api/download?token=${encodeURIComponent(result.token)}`);
  }

  return res.redirect('/?apology=1');
});

app.get('/api/extractors', (req, res) => {
  const sorted = [...BUILTIN_EXTRACTORS].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );
  res.json({ extractors: sorted });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`FileHunt running at http://localhost:${PORT}`));
}

module.exports = app;