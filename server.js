// suppress the NODE_TLS_REJECT_UNAUTHORIZED warning while allowing self-signed video CDNs
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (typeof warning === 'string' && warning.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
    return;
  }
  return originalEmitWarning.call(process, warning, ...args);
};
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// prevent any unexpected stream or socket abort from stopping the local server
process.on('uncaughtException', err => {
  console.error('[VideoHunt Recoverable Exception]:', err?.message || err);
});

process.on('unhandledRejection', reason => {
  console.error('[VideoHunt Recoverable Rejection]:', reason?.message || reason);
});

const express = require('express');
const path = require('path');
const { PORT, BROWSER_UA, BUILTIN_EXTRACTORS, normalizeInputUrl } = require('./src/config');
const { initLocalBinaries } = require('./src/extractor');
const {
  inspectMediaUrl,
  streamMediaToResponse,
  handleInternalChunkProxy
} = require('./src/downloader');

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    name: 'VideoHunt',
    version: '9.0.0',
    runtime: 'local-node'
  });
});

// GET /api/extractors
app.get('/api/extractors', (req, res) => {
  res.json({ extractors: BUILTIN_EXTRACTORS });
});

// GET /api/proxy-image - proxies thumbnails with Referer so hotlink rules never break artwork
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query || {};
  if (!url) return res.status(400).end();

  try {
    const parsed = new URL(normalizeInputUrl(url));
    let imgRes = await fetch(parsed.href, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': parsed.origin + '/'
      },
      signal: AbortSignal.timeout(6000)
    });

    if (!imgRes.ok && parsed.hostname.includes('ytimg.com') && parsed.pathname.includes('maxresdefault')) {
      const fallbackThumb = parsed.href.replace('maxresdefault', 'hqdefault');
      imgRes = await fetch(fallbackThumb, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(6000)
      });
    }

    if (!imgRes.ok) return res.status(404).end();
    res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const arrayBuffer = await imgRes.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch {
    return res.status(404).end();
  }
});

// GET /api/chunk-proxy - internal high-speed range-window proxy feeding local FFmpeg without CDN throttling
app.get('/api/chunk-proxy', async (req, res) => {
  try {
    await handleInternalChunkProxy(req, res);
  } catch {
    if (!res.headersSent) res.status(502).end();
    else try { res.end(); } catch {}
  }
});

// POST /api/info - accepts links with or without http:// or https://
app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !String(url).trim()) {
    return res.status(400).json({ error: 'Please paste a video link.' });
  }

  let normalizedUrl;
  try {
    normalizedUrl = normalizeInputUrl(url);
  } catch {
    return res.status(400).json({ error: 'Please enter a valid website link (e.g. youtube.com/watch?v=...).' });
  }

  try {
    const info = await inspectMediaUrl(normalizedUrl);
    if (info && info.videoFormats?.length > 0) {
      return res.json({
        normalizedUrl,
        title: info.title,
        extractor: info.extractor,
        uploader: info.uploader || null,
        duration: info.duration,
        thumbnail: info.thumbnail,
        resolutions: info.resolutions,
        videoFormats: info.videoFormats,
        audioFormats: info.audioFormats
      });
    }
  } catch (err) {
    console.error('[Inspect Error]:', err.message);
  }

  return res.status(422).json({
    error:
      'We apologize, but VideoHunt could not find any downloadable video streams on this link. Please verify that the URL points directly to a public video.'
  });
});

// GET /api/download - starts browser download immediately with continuous unthrottled packet flow
app.get('/api/download', async (req, res) => {
  const { url, title = 'Video', type = 'mp4', resolution = '720', bitrate = '192' } = req.query || {};
  if (!url) {
    return res.redirect('/?apology=1');
  }

  try {
    const normalizedUrl = normalizeInputUrl(url);
    await streamMediaToResponse({ url: normalizedUrl, title, type, resolution, bitrate, req, res });
  } catch (err) {
    console.error('[Download Stream Error]:', err.message);
    if (!res.headersSent) {
      return res.redirect('/?apology=1');
    }
    try { res.end(); } catch {}
  }
});

// SPA fallback
app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

initLocalBinaries();

const server = app.listen(PORT, () => {
  console.log(`VideoHunt v9.0 running at http://localhost:${PORT}`);
});

server.timeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;