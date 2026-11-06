const express = require('express');
const fs = require('fs');
const { Readable } = require('stream');
const { BROWSER_UA, IS_VERCEL } = require('../config/constants');
const { BUILTIN_EXTRACTORS } = require('../config/extractorsCatalog');
const { streamHlsSegmentsToResponse } = require('../extractors/hlsParser');
const {
  inspectMediaUrl,
  prepareMediaDownload,
  consumePreparedToken
} = require('../services/mediaPipeline');

const router = express.Router();

// GET /api/health - diagnostic endpoint for uptime checks
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '4.0.0',
    runtime: IS_VERCEL ? 'vercel-serverless' : 'local-node'
  });
});

// GET /api/extractors - returns A-Z sorted extractors catalog
router.get('/extractors', (req, res) => {
  res.json({ extractors: BUILTIN_EXTRACTORS });
});

// GET /api/proxy-image - proxies external video thumbnails with automatic YouTube fallback
router.get('/proxy-image', async (req, res) => {
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

    if (!imgRes.ok && parsed.hostname.includes('ytimg.com') && parsed.pathname.includes('maxresdefault')) {
      const fallbackThumb = parsed.href.replace('maxresdefault', 'hqdefault');
      imgRes = await fetch(fallbackThumb, {
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

// POST /api/info - inspects the submitted URL and returns ONLY the real qualities available
router.post('/info', async (req, res) => {
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

// GET /api/download - handles background stream preparation (?prepare=1) and token-based binary streaming
router.get('/download', async (req, res) => {
  const { url, title = 'Video', type = 'mp4', resolution = '720', bitrate = '192', prepare, token } = req.query;

  if (token) {
    const entry = consumePreparedToken(token);
    if (!entry) {
      return res.redirect('/?apology=1');
    }

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
          if (IS_VERCEL && contentLen > 4200000) {
            return res.redirect(entry.streamUrl);
          }

          res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
          res.setHeader('Content-Type', entry.ext === 'mp3' ? 'audio/mpeg' : 'video/mp4');
          if (contentLen) res.setHeader('Content-Length', String(contentLen));
          Readable.fromWeb(upstream.body).pipe(res);
          return;
        }
      } catch {}
    }

    if (entry.mode === 'hls') {
      try {
        await streamHlsSegmentsToResponse(
          entry.streamUrl,
          entry.referer,
          entry.cookies,
          res,
          entry.filename
        );
        return;
      } catch {}
    }

    return res.redirect('/?apology=1');
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

module.exports = router;