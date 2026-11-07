// allow scraping video hosts with self-signed or incomplete SSL certificate chains
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// satisfy Vercel's static Express entrypoint detector at build time without loading broken node_modules at runtime
if (process.env.__VERCEL_BUILD_SCANNER__) {
  require('express');
}

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PORT, IS_VERCEL } = require('./src/config/constants');
const { handleApiRequest } = require('./src/routes/apiRouter');
const { initLocalBinaries } = require('./src/extractors/ytdlpBridge');

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

// attach Express-compatible helper methods onto native http.ServerResponse
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
      await handleApiRequest(req, res);
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

// attach Express-compatible methods in case Vercel's runtime wrapper inspects the exported function
app.handle = app;
app.use = () => app;
app.set = () => app;
app.disable = () => app;
app.listen = (...args) => http.createServer(app).listen(...args);

if (!IS_VERCEL) {
  initLocalBinaries();
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`FileHunt running at http://localhost:${PORT}`);
  });
}

module.exports = app;