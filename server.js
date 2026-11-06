// allow scraping video hosts with self-signed or incomplete SSL certificate chains
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PORT, IS_VERCEL } = require('./src/config/constants');
const { handleApiRequest } = require('./src/routes/apiRouter');
const { initLocalBinaries } = require('./src/extractors/ytdlpBridge');

const PUBLIC_DIR = path.join(__dirname, 'public');

// MIME type lookup for serving static frontend files cleanly
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

// attach Express-like helper methods (.status, .json, .send) onto native http.ServerResponse
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

// read and parse JSON request body for POST endpoints
function parseJsonBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST') return resolve({});
    if (req.body && typeof req.body === 'object') return resolve(req.body);

    let raw = '';
    req.on('data', chunk => {
      raw += chunk.toString();
      if (raw.length > 1024 * 1024) req.destroy();
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

// main request handler for both local HTTP server and Vercel serverless invocations
async function requestHandler(req, res) {
  decorateResponse(res);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);
  req.query = Object.fromEntries(parsedUrl.searchParams.entries());
  req.pathname = pathname;

  try {
    // route /api/* calls to our API router
    if (pathname.startsWith('/api/')) {
      req.body = await parseJsonBody(req);
      await handleApiRequest(req, res);
      return;
    }

    // resolve static files inside public/
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const safeCandidate = path.normalize(path.join(PUBLIC_DIR, relativePath));

    if (safeCandidate.startsWith(PUBLIC_DIR) && fs.existsSync(safeCandidate) && fs.statSync(safeCandidate).isFile()) {
      const ext = path.extname(safeCandidate).toLowerCase();
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      fs.createReadStream(safeCandidate).pipe(res);
      return;
    }

    // SPA fallback: serve public/index.html for any view route
    const indexHtmlPath = path.join(PUBLIC_DIR, 'index.html');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    fs.createReadStream(indexHtmlPath).pipe(res);
  } catch (err) {
    console.error('[FileHunt Server Error]:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'We apologize, but an unexpected server error occurred. Please try again.'
      });
    }
  }
}

if (!IS_VERCEL) {
  initLocalBinaries();
}

if (require.main === module) {
  const server = http.createServer(requestHandler);
  server.listen(PORT, () => {
    console.log(`FileHunt v4.0 running at http://localhost:${PORT}`);
  });
}

module.exports = requestHandler;