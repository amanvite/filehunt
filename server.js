// suppress the NODE_TLS_REJECT_UNAUTHORIZED warning while allowing self-signed video CDNs
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (typeof warning === 'string' && warning.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
    return;
  }
  return originalEmitWarning.call(process, warning, ...args);
};
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { PORT, BROWSER_UA, BUILTIN_EXTRACTORS } = require('./src/config');
const { initLocalBinaries } = require('./src/extractor');
const {
  inspectMediaUrl,
  prepareMediaDownload,
  consumePreparedToken
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
    version: '6.0.0',
    runtime: 'local-node'
  });
});

// GET /api/extractors
app.get('/api/extractors', (req, res) => {
  res.json({ extractors: BUILTIN_EXTRACTORS });
});

// GET /api/proxy-image - proxies thumbnails with Referer so hotlink protection never breaks preview images
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query || {};
  if (!url) return res.status(400).end();

  try {
    const parsed = new URL(url);
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

// POST /api/info - inspects the video URL and returns only the real qualities available for that video
app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url) {
    return res.status(400).json({ error: 'Please paste a valid video link.' });
  }

  try {
    new URL(url.trim());
  } catch {
    return res.status(400).json({ error: 'Invalid link format. Make sure it starts with https://' });
  }

  try {
    const info = await inspectMediaUrl(url.trim());
    if (info && info.videoFormats?.length > 0) {
      return res.json({
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
      'We apologize, but FileHunt could not find any downloadable video streams on this link. Please verify that the URL points directly to a public video.'
  });
});

// GET /api/download - prepares the video locally into temp/ and triggers a native browser file save
app.get('/api/download', async (req, res) => {
  const { url, title = 'Video', type = 'mp4', resolution = '720', bitrate = '192', prepare, token } = req.query || {};

  if (token) {
    const entry = consumePreparedToken(token);
    if (!entry || !entry.filePath || !fs.existsSync(entry.filePath)) {
      return res.redirect('/?apology=1');
    }

    return res.download(entry.filePath, entry.filename, () => {
      fs.unlink(entry.filePath, () => {});
    });
  }

  if (!url) {
    if (prepare === '1') return res.status(400).json({ ok: false });
    return res.redirect('/?apology=1');
  }

  const result = await prepareMediaDownload({ url, title, type, resolution, bitrate });

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

// SPA fallback
app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

initLocalBinaries();

app.listen(PORT, () => {
  console.log(`FileHunt Local v6.0 running at http://localhost:${PORT}`);
});