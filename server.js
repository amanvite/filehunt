// I suppress the NODE_TLS_REJECT_UNAUTHORIZED warning while allowing self-signed video CDNs
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (typeof warning === 'string' && warning.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
    return;
  }
  return originalEmitWarning.call(process, warning, ...args);
};
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// satisfy Vercel's static Express entrypoint check at build time
if (process.env.__VERCEL_BUILD_SCANNER__) {
  require('express');
}

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { PORT, IS_VERCEL, BROWSER_UA, BUILTIN_EXTRACTORS } = require('./src/config');
const { initLocalBinaries, streamHlsSegmentsToResponse } = require('./src/extractor');
const {
  inspectMediaUrl,
  prepareMediaDownload,
  consumePreparedToken
} = require('./src/downloader');

const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(process.cwd(), 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function decorateResponse(res) {
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };

  res.json = function (payload) {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(payload));
    return res;
  };

  res.send = function (body) {
    if (Buffer.isBuffer(body) || typeof body === 'string') {
      res.end(body);
    } else {
      res.json(body);
    }
    return res;
  };

  res.redirect = function (locationUrl) {
    res.statusCode = 302;
    res.setHeader('Location', locationUrl);
    res.end();
    return res;
  };

  return res;
}

function parseJsonBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST') return resolve({});
    if (req.body && typeof req.body === 'object') return resolve(req.body);

    let raw = '';
    req.on('data', chunk => {
      raw += chunk.toString();
      if (raw.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// I append &title= to googlevideo.com URLs so Google's CDN forces a file download instead of opening a video player tab
function attachDownloadTitleParam(rawStreamUrl, filename) {
  try {
    const parsed = new URL(rawStreamUrl);
    if (parsed.hostname.includes('googlevideo.com')) {
      const cleanTitle = String(filename || 'video').replace(/\.(mp4|mp3|webm)$/i, '');
      parsed.searchParams.set('title', cleanTitle);
      return parsed.href;
    }
  } catch {}
  return rawStreamUrl;
}

async function handleApiRoutes(req, res) {
  const route = req.pathname;

  if (req.method === 'GET' && route === '/api/health') {
    return res.json({
      status: 'ok',
      version: '5.2.0',
      runtime: IS_VERCEL ? 'vercel-serverless' : 'local-node'
    });
  }

  if (req.method === 'GET' && route === '/api/extractors') {
    return res.json({ extractors: BUILTIN_EXTRACTORS });
  }

  if (req.method === 'GET' && route === '/api/proxy-image') {
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

  if (req.method === 'POST' && route === '/api/info') {
    const { url, clientHtml } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: 'Please paste a valid video link.' });
    }

    try {
      new URL(url.trim());
    } catch {
      return res.status(400).json({ error: 'Invalid link format. Make sure it starts with https://' });
    }

    try {
      const info = await inspectMediaUrl(url.trim(), clientHtml || '');
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

  if (req.method === 'GET' && route === '/api/download') {
    const { url, title = 'Video', type = 'mp4', resolution = '720', bitrate = '192', prepare, token, st } = req.query || {};

    if (token || st) {
      const entry = consumePreparedToken(token, st);
      if (!entry) {
        return res.redirect('/?apology=1');
      }

      if (entry.mode === 'file' && entry.filePath && fs.existsSync(entry.filePath)) {
        const stat = fs.statSync(entry.filePath);
        res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(stat.size));

        const readStream = fs.createReadStream(entry.filePath);
        readStream.on('close', () => {
          fs.unlink(entry.filePath, () => {});
        });
        return readStream.pipe(res);
      }

      if (entry.mode === 'direct') {
        const targetStreamUrl = attachDownloadTitleParam(entry.streamUrl, entry.filename);
        try {
          const upstream = await fetch(targetStreamUrl, {
            headers: {
              'User-Agent': BROWSER_UA,
              'Referer': entry.referer || targetStreamUrl,
              ...(entry.cookies ? { Cookie: entry.cookies } : {})
            },
            redirect: 'follow'
          });

          const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
          // verify the upstream response is a real media stream and not an HTML redirect page
          if (upstream.ok && upstream.body && !contentType.includes('text/html')) {
            const contentLen = Number(upstream.headers.get('content-length') || 0);
            res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
            // use application/octet-stream so Chrome always saves to disk instead of opening a video player tab
            res.setHeader('Content-Type', 'application/octet-stream');
            if (contentLen > 0) {
              res.setHeader('Content-Length', String(contentLen));
            }
            return Readable.fromWeb(upstream.body).pipe(res);
          }

          // if the CDN is IP-bound to the user's residential IP (e.g. signed googlevideo.com), redirect with &title= attached
          if (targetStreamUrl.includes('googlevideo.com')) {
            return res.redirect(targetStreamUrl);
          }
          return res.redirect('/?apology=1');
        } catch {
          if (targetStreamUrl.includes('googlevideo.com')) {
            return res.redirect(targetStreamUrl);
          }
          return res.redirect('/?apology=1');
        }
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
        const dlQuery = new URLSearchParams({ token: result.token });
        if (result.st) dlQuery.set('st', result.st);
        return res.json({
          ok: true,
          downloadUrl: `/api/download?${dlQuery.toString()}`,
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
      const dlQuery = new URLSearchParams({ token: result.token });
      if (result.st) dlQuery.set('st', result.st);
      return res.redirect(`/api/download?${dlQuery.toString()}`);
    }

    return res.redirect('/?apology=1');
  }

  return res.status(404).json({ error: 'API endpoint not found' });
}

async function app(req, res) {
  decorateResponse(res);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);
  req.query = Object.fromEntries(parsedUrl.searchParams.entries());
  req.pathname = pathname;
  req.path = pathname;

  try {
    if (pathname.startsWith('/api/')) {
      req.body = await parseJsonBody(req);
      await handleApiRoutes(req, res);
      return;
    }

    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const safeCandidate = path.normalize(path.join(PUBLIC_DIR, relativePath));

    if (
      safeCandidate.startsWith(PUBLIC_DIR) &&
      fs.existsSync(safeCandidate) &&
      fs.statSync(safeCandidate).isFile()
    ) {
      const ext = path.extname(safeCandidate).toLowerCase();
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      res.end(fs.readFileSync(safeCandidate));
      return;
    }

    const indexFile = path.join(PUBLIC_DIR, 'index.html');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(indexFile, 'utf8'));
  } catch (err) {
    console.error('[FileHunt Error]:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'We apologize, but an unexpected server error occurred. Please try again.'
      });
    }
  }
}

app.handle = app;
app.use = () => app;
app.set = () => app;
app.disable = () => app;
app.listen = (...args) => http.createServer(app).listen(...args);

initLocalBinaries();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`FileHunt running at http://localhost:${PORT}`);
  });
}

module.exports = app;