const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Readable } = require('stream');

// check if ffmpeg-static binary actually exists on disk before passing it to yt-dlp
let ffmpegPath = null;
try {
  const candidate = require('ffmpeg-static');
  if (candidate && fs.existsSync(candidate)) {
    ffmpegPath = candidate;
  }
} catch {}

const app = express();
const PORT = process.env.PORT || 3000;

const IS_VERCEL = Boolean(process.env.VERCEL);
const TEMP_DIR = IS_VERCEL ? path.join(os.tmpdir(), 'filehunt_temp') : path.join(__dirname, 'temp');

try {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
} catch {}

// path where we store the auto-downloaded yt-dlp binary so I don't need it in Windows PATH
const LOCAL_YTDLP_BIN = path.join(
  TEMP_DIR,
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

let resolvedYtDlpCmd = null;
let ytdlpDownloadPromise = null;

// check if yt-dlp is available globally or download the standalone binary automatically
async function ensureYtDlpBinary() {
  if (resolvedYtDlpCmd && (resolvedYtDlpCmd === 'yt-dlp' || fs.existsSync(resolvedYtDlpCmd))) {
    return resolvedYtDlpCmd;
  }

  if (fs.existsSync(LOCAL_YTDLP_BIN) && fs.statSync(LOCAL_YTDLP_BIN).size > 1000000) {
    resolvedYtDlpCmd = LOCAL_YTDLP_BIN;
    return resolvedYtDlpCmd;
  }

  // check if global yt-dlp exists in system PATH
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

  if (IS_VERCEL) return null;

  // auto-download official standalone yt-dlp binary into temp/ folder
  if (!ytdlpDownloadPromise) {
    ytdlpDownloadPromise = (async () => {
      const releaseUrl =
        process.platform === 'win32'
          ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
          : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

      console.log('Downloading standalone yt-dlp binary into temp/ folder (one-time setup)...');
      const res = await fetch(releaseUrl, { redirect: 'follow' });
      if (!res.ok) throw new Error(`Failed to fetch yt-dlp binary: ${res.status}`);

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(LOCAL_YTDLP_BIN, buffer);
      if (process.platform !== 'win32') {
        fs.chmodSync(LOCAL_YTDLP_BIN, 0o755);
      }
      console.log('yt-dlp binary ready at:', LOCAL_YTDLP_BIN);
      resolvedYtDlpCmd = LOCAL_YTDLP_BIN;
      return resolvedYtDlpCmd;
    })().catch(err => {
      console.warn('Could not auto-download yt-dlp binary:', err.message);
      ytdlpDownloadPromise = null;
      return null;
    });
  }

  return ytdlpDownloadPromise;
}

// kick off the binary check in the background right when the server starts
if (!IS_VERCEL) {
  ensureYtDlpBinary();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// preloaded extractors list for instant response on the Sites tab
const BUILTIN_EXTRACTORS = [
  '1News', '9GAG', 'ABC', 'AcademicEarth', 'AcFun', 'Archive.org', 'ARD', 'ArteTV', 'Audiomack',
  'Bandcamp', 'BBC', 'Behance', 'Bilibili', 'BitChute', 'Bloomberg', 'Bluesky', 'BuzzFeed', 'CBC',
  'CBS', 'CloudflareStream', 'CNBC', 'CNN', 'ComedyCentral', 'Coub', 'Coursera', 'Crunchyroll',
  'Dailymotion', 'Deezer', 'Discovery', 'Douyin', 'Dropbox', 'DeutscheWelle', 'edX', 'ESPN',
  'Euronews', 'Facebook', 'Flickr', 'FoxNews', 'FranceTV', 'Freesound', 'GameSpot', 'Giphy',
  'GitHub', 'GoogleDrive', 'Guardian', 'Hotstar', 'HuffPost', 'IGN', 'Imdb', 'Imgur', 'Instagram',
  'InternetArchive', 'ITV', 'Ixigua', 'Jamendo', 'JWPlatform', 'Kaltura', 'KhanAcademy', 'Kick',
  'Kickstarter', 'Kuaishou', 'LastFM', 'LBRY', 'LinkedIn', 'Loom', 'MailRu', 'Mastodon', 'Medaltv',
  'Medium', 'Metacafe', 'Mixcloud', 'MTV', 'NationalGeographic', 'Naver', 'NBA', 'NBC', 'NDTV',
  'NetEaseMusic', 'Newgrounds', 'NextCloud', 'NFL', 'NHK', 'Niconico', 'NPR', 'NewYorkTimes',
  'Odysee', 'Odnoklassniki', 'Panopto', 'Patreon', 'PBS', 'PeerTube', 'Pinterest', 'Pixiv',
  'PlutoTV', 'Podbean', 'Polygon', 'Pornhat', 'Pornhub', 'QQMusic', 'Quora', 'RaiPlay', 'RedBullTV',
  'Reddit', 'RedGifs', 'Rumble', 'Rutube', 'SharePoint', 'Simplecast', 'SkyNews', 'Slideshare',
  'SmugMug', 'Snapchat', 'SonyLIV', 'SoundCloud', 'Spotify', 'Spreaker', 'Steam', 'Streamable',
  'Substack', 'TED', 'Telegram', 'TencentVideo', 'TheGuardian', 'TheVerge', 'Threads', 'TikTok',
  'TMZ', 'TradingView', 'Triller', 'Trovo', 'Tumblr', 'TuneIn', 'Twitch', 'Twitter', 'Udemy',
  'Unity', 'Ustream', 'Vbox7', 'Vice', 'Vidyard', 'Viki', 'Vimeo', 'VK', 'Vocaroo', 'VoxMedia',
  'WashingtonPost', 'WaybackMachine', 'Webex', 'Weibo', 'Wikimedia', 'Wikipedia', 'Wistia',
  'WordPress', 'WSJ', 'WWE', 'X.com', 'XboxClips', 'XHamster', 'XNXX', 'XVideos', 'Yahoo',
  'YandexVideo', 'Youku', 'YouTube', 'ZDF', 'Zoom'
];

function formatDuration(sec) {
  if (!sec || isNaN(sec) || sec <= 0) return 'HD';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// clean video title so the downloaded file has the real video title as its filename
function sanitizeFilename(rawTitle, suffix = '', ext = 'mp4') {
  const cleaned = String(rawTitle || 'Video')
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

async function runYtDlp(args, timeoutMs = 150000) {
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

// extract direct mp4/webm streams from raw HTML string
function extractStreamsFromHtml(html, baseUrl, directStreams = {}) {
  const getMeta = prop => {
    const r1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
    const r2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
    return (html.match(r1)?.[1] || html.match(r2)?.[1] || '').trim();
  };

  // check og:video and twitter:player:stream meta tags first
  const metaVideo =
    getMeta('og:video:secure_url') ||
    getMeta('og:video:url') ||
    getMeta('og:video') ||
    getMeta('twitter:player:stream');

  if (metaVideo && /\.(mp4|webm|m4v)(\?|$)/i.test(metaVideo)) {
    directStreams[720] = resolveAbsoluteUrl(metaVideo.replace(/&amp;/g, '&'), baseUrl);
  }

  // check <video src="..."> and <source src="..."> tags
  const mediaTagRegex = /<(?:source|video)[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = mediaTagRegex.exec(html)) !== null) {
    const rawSrc = m[1].replace(/&amp;/g, '&');
    if (!/\.(mp4|webm|m4v)(\?|$)/i.test(rawSrc) && !/video|stream|mp4|cdn|media/i.test(rawSrc)) continue;
    const srcUrl = resolveAbsoluteUrl(rawSrc, baseUrl);
    const labelMatch =
      m[0].match(/(?:label|title|res|data-res|size)=["']?(\d{3,4})p?/i) ||
      srcUrl.match(/[_/-](\d{3,4})p?\b/i);
    const res = labelMatch ? Number(labelMatch[1]) : (directStreams[720] ? 480 : 720);
    if (srcUrl && !directStreams[res]) {
      directStreams[res] = srcUrl;
    }
  }

  // scan inline player scripts & JSON-LD contentUrl for direct .mp4 or .webm URLs
  const unescaped = html
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&');

  const directUrlRegex = /https?:\/\/[^\s"'<>\\]+\.(?:mp4|webm|m4v)(?:\?[^\s"'<>\\]+)?/gi;
  let uMatch;
  while ((uMatch = directUrlRegex.exec(unescaped)) !== null) {
    const candidate = uMatch[0];
    if (/preview|thumb|sprite|banner|logo/i.test(candidate)) continue;
    const resHit = candidate.match(/[_/-](2160|1440|1080|720|480|360|240)p?\b/i);
    const resKey = resHit
      ? Number(resHit[1])
      : !directStreams[1080]
      ? 1080
      : !directStreams[720]
      ? 720
      : !directStreams[480]
      ? 480
      : 360;
    if (!directStreams[resKey]) {
      directStreams[resKey] = candidate;
    }
  }

  return directStreams;
}

// scrape direct video streams, metadata, and embedded player iframes from any HTML5 video page
async function scrapePageMedia(targetUrl) {
  const parsed = new URL(targetUrl);
  const pageRes = await fetch(targetUrl, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': parsed.origin + '/'
    },
    signal: AbortSignal.timeout(6500)
  });

  const html = await pageRes.text();

  const getMeta = prop => {
    const r1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
    const r2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
    return (html.match(r1)?.[1] || html.match(r2)?.[1] || '').trim();
  };

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const posterMatch = html.match(/poster=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i);

  const rawTitle =
    getMeta('og:title') ||
    getMeta('twitter:title') ||
    (titleMatch ? titleMatch[1].trim() : parsed.hostname.replace(/^www\./, ''));

  const rawThumb =
    getMeta('og:image') ||
    getMeta('twitter:image') ||
    (posterMatch ? posterMatch[1] : '');

  const thumbnail = resolveAbsoluteUrl(rawThumb, targetUrl);
  const directStreams = extractStreamsFromHtml(html, targetUrl, {});

  // if the main page uses an embedded player iframe, inspect the iframe page as well
  if (Object.keys(directStreams).length === 0) {
    const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+(?:embed|player|video)[^"']*)["']/i);
    if (iframeMatch?.[1]) {
      try {
        const iframeUrl = resolveAbsoluteUrl(iframeMatch[1], targetUrl);
        const iframeRes = await fetch(iframeUrl, {
          headers: { 'User-Agent': BROWSER_UA, 'Referer': targetUrl },
          signal: AbortSignal.timeout(4000)
        });
        if (iframeRes.ok) {
          const iframeHtml = await iframeRes.text();
          extractStreamsFromHtml(iframeHtml, iframeUrl, directStreams);
        }
      } catch {}
    }
  }

  const foundResolutions = Object.keys(directStreams)
    .map(Number)
    .sort((a, b) => b - a);

  const host = parsed.hostname.replace(/^www\./, '').toUpperCase();
  return {
    title: rawTitle,
    extractor: getMeta('og:site_name') || host,
    duration: 'HD',
    thumbnail,
    resolutions: foundResolutions.length ? foundResolutions : [1080, 720, 480, 360],
    directStreams
  };
}

// fast public API lookup for Dailymotion, YouTube, Vimeo, TikTok, SoundCloud
async function resolveViaPublicApi(targetUrl) {
  const dmMatch =
    targetUrl.match(/dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/i) ||
    targetUrl.match(/dai\.ly\/([a-zA-Z0-9]+)/i);

  if (dmMatch) {
    const videoId = dmMatch[1];
    const apiRes = await fetch(
      `https://api.dailymotion.com/video/${videoId}?fields=id,title,duration,thumbnail_1080_url,thumbnail_720_url,thumbnail_480_url,owner.screenname`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (apiRes.ok) {
      const dm = await apiRes.json();
      return {
        title: dm.title || `Dailymotion Video (${videoId})`,
        extractor: 'Dailymotion',
        uploader: dm['owner.screenname'] || 'Dailymotion',
        duration: formatDuration(dm.duration),
        thumbnail: dm.thumbnail_1080_url || dm.thumbnail_720_url || dm.thumbnail_480_url || '',
        resolutions: [1080, 720, 480, 360]
      };
    }
  }

  const ytMatch =
    targetUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
    targetUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
    targetUrl.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);

  if (ytMatch || /youtube\.com|youtu\.be/i.test(targetUrl)) {
    const videoId = ytMatch ? ytMatch[1] : '';
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`, {
      signal: AbortSignal.timeout(4000)
    });
    if (res.ok) {
      const yt = await res.json();
      return {
        title: yt.title || 'YouTube Video',
        extractor: 'YouTube',
        uploader: yt.author_name || 'YouTube',
        duration: 'HD',
        thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : yt.thumbnail_url,
        resolutions: [1080, 720, 480, 360]
      };
    }
  }

  const providers = [
    { rx: /vimeo\.com/i, name: 'Vimeo', url: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(targetUrl)}` },
    { rx: /tiktok\.com/i, name: 'TikTok', url: `https://www.tiktok.com/oembed?url=${encodeURIComponent(targetUrl)}` },
    { rx: /soundcloud\.com/i, name: 'SoundCloud', url: `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(targetUrl)}` }
  ];

  for (const p of providers) {
    if (p.rx.test(targetUrl)) {
      const res = await fetch(p.url, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const d = await res.json();
        return {
          title: d.title || `${p.name} Video`,
          extractor: p.name,
          uploader: d.author_name || p.name,
          duration: formatDuration(d.duration),
          thumbnail: d.thumbnail_url || '',
          resolutions: [1080, 720, 480, 360]
        };
      }
    }
  }

  return null;
}

// GET /api/proxy-image - proxies external thumbnails so Referer hotlink protection never breaks preview images
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  try {
    const parsed = new URL(url);
    const imgRes = await fetch(parsed.href, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': parsed.origin + '/'
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!imgRes.ok) return res.status(404).end();
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const arrayBuffer = await imgRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch {
    res.status(404).end();
  }
});

// POST /api/info - resolves stream metadata and available resolutions
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Please paste a valid video link.' });

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return res.status(400).json({ error: 'Invalid link format. Make sure it starts with https://' });
  }

  try {
    const apiData = await resolveViaPublicApi(parsed.href);
    if (apiData) return res.json(apiData);
  } catch {}

  try {
    const scraped = await scrapePageMedia(parsed.href);
    if (scraped) return res.json(scraped);
  } catch {}

  const host = parsed.hostname.replace(/^www\./, '');
  return res.json({
    title: `Video Stream (${host})`,
    extractor: host.toUpperCase(),
    duration: 'HD',
    thumbnail: '',
    resolutions: [1080, 720, 480, 360]
  });
});

// GET /api/download - downloads video/audio with real video title and H.264 compatibility
app.get('/api/download', async (req, res) => {
  const { url, title = 'Video', type = 'mp4', resolution = '720', bitrate = '192', lang = 'en' } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing URL parameter' });

  const ext = type === 'mp3' ? 'mp3' : type === 'subtitles' ? 'srt' : 'mp4';
  const suffix = type === 'mp3' ? `${bitrate}kbps` : type === 'subtitles' ? lang.toUpperCase() : `${resolution}p`;
  const cleanFilename = sanitizeFilename(title, suffix, ext);

  if (type === 'subtitles') {
    const srt = `1\n00:00:01,000 --> 00:00:05,000\n${title} (${lang.toUpperCase()})\n`;
    res.setHeader('Content-Disposition', `attachment; filename="${cleanFilename}"`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(srt);
  }

  // Strategy 1: Direct HTML5 MP4 stream scraper (fastest for direct video hosting sites)
  if (type !== 'mp3') {
    try {
      const scraped = await scrapePageMedia(url);
      const streams = scraped.directStreams || {};
      const availableRes = Object.keys(streams).map(Number).sort((a, b) => b - a);
      const targetRes = availableRes.find(r => r <= Number(resolution)) || availableRes[0];
      const directMp4Url = targetRes ? streams[targetRes] : (/\.(mp4|webm|m4v)(\?|$)/i.test(url) ? url : null);

      if (directMp4Url) {
        const parsedOrigin = new URL(url).origin + '/';
        const upstream = await fetch(directMp4Url, {
          headers: {
            'User-Agent': BROWSER_UA,
            'Referer': parsedOrigin
          }
        });

        const contentType = upstream.headers.get('content-type') || '';
        if (upstream.ok && !contentType.includes('text/html') && upstream.body) {
          res.setHeader('Content-Disposition', `attachment; filename="${cleanFilename}"`);
          res.setHeader('Content-Type', contentType || 'video/mp4');
          const contentLen = upstream.headers.get('content-length');
          if (contentLen) res.setHeader('Content-Length', contentLen);

          Readable.fromWeb(upstream.body).pipe(res);
          return;
        }
      }
    } catch (scrapeErr) {
      console.warn('Direct scrape step skipped:', scrapeErr.message);
    }
  }

  // Strategy 2: Auto-bootstrapped yt-dlp binary (handles YouTube, Dailymotion, TikTok, HLS/m3u8, etc.)
  if (!IS_VERCEL) {
    try {
      const jobId = `fh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const outTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);
      const args = [
        '--no-playlist',
        '--no-part',
        '--no-warnings',
        '--user-agent',
        BROWSER_UA,
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
          ? `bestvideo[height<=${resolution}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=${resolution}][ext=mp4]/bestvideo[height<=${resolution}]+bestaudio/best[height<=${resolution}]/best`
          : `best[height<=${resolution}][ext=mp4]/best[ext=mp4]/best`;

        args.push('-f', formatSelector);
        if (ffmpegPath) {
          args.push('--merge-output-format', 'mp4');
        }
      }

      args.push(url);
      await runYtDlp(args, 180000);

      const producedFiles = fs
        .readdirSync(TEMP_DIR)
        .filter(f => f.startsWith(jobId) && !f.endsWith('.part') && !f.endsWith('.ytdl'));

      if (producedFiles.length > 0) {
        const fullPath = path.join(TEMP_DIR, producedFiles[0]);
        const stat = fs.statSync(fullPath);
        if (stat.size > 1024) {
          const actualExt = path.extname(producedFiles[0]).replace('.', '') || ext;
          const finalDownloadName = sanitizeFilename(title, suffix, actualExt);
          return res.download(fullPath, finalDownloadName, () => {
            fs.unlink(fullPath, () => {});
          });
        }
      }
    } catch (ytErr) {
      console.warn('yt-dlp extraction failed:', ytErr.message);
    }
  }

  return res.status(422).json({
    error: 'No downloadable video file was found on this page (make sure the link points to a video and not a profile or offline live room).'
  });
});

app.get('/api/extractors', (req, res) => {
  res.json({ extractors: BUILTIN_EXTRACTORS });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`FileHunt running at http://localhost:${PORT}`));
}

module.exports = app;