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

async function handleApiRequest(req, res) {
  const route = req.pathname || req.path;

  // GET /api/health
  if (req.method === 'GET' && (route === '/api/health' || route === '/health')) {
    return res.json({
      status: 'ok',
      version: '4.0.0',
      runtime: IS_VERCEL ? 'vercel-serverless' : 'local-node'
    });
  }

  // GET /api/extractors
  if (req.method === 'GET' && (route === '/api/extractors' || route === '/extractors')) {
    return res.json({ extractors: BUILTIN_EXTRACTORS });
  }

  // GET /api/proxy-image
  if (req.method === 'GET' && (route === '/api/proxy-image' || route === '/proxy-image')) {
    const { url } = req.query || {};
    if (!url) return res.status(400).send('');

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

      if (!imgRes.ok) return res.status(404).send('');
      res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const arrayBuffer = await imgRes.arrayBuffer();
      return res.send(Buffer.from(arrayBuffer));
    } catch {
      return res.status(404).send('');
    }
  }

  // POST /api/info
  if (req.method === 'POST' && (route === '/api/info' || route === '/info')) {
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
  }

  // GET /api/download
  if (req.method === 'GET' && (route === '/api/download' || route === '/download')) {
    const { url, title = 'Video', type = 'mp4', resolution = '720', bitrate = '192', prepare, token } = req.query || {};

    if (token) {
      const entry = consumePreparedToken(token);
      if (!entry) {
        return res.redirect('/?apology=1');
      }

      if (entry.mode === 'file' && fs.existsSync(entry.filePath)) {
        const stat = fs.statSync(entry.filePath);
        res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
        res.setHeader('Content-Type', entry.filename.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4');
        res.setHeader('Content-Length', String(stat.size));

        const readStream = fs.createReadStream(entry.filePath);
        readStream.on('close', () => {
          fs.unlink(entry.filePath, () => {});
        });
        return readStream.pipe(res);
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
            return Readable.fromWeb(upstream.body).pipe(res);
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
  }

  return res.status(404).json({ error: 'API endpoint not found' });
}

module.exports = { handleApiRequest };