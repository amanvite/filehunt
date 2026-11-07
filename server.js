// allow scraping video hosts with self-signed or incomplete SSL certificate chains
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// self-healing module guard so a corrupted or cached node_modules/debug never crashes Express on Vercel
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  try {
    return originalLoad.apply(this, arguments);
  } catch (err) {
    if (
      err &&
      err.code === 'MODULE_NOT_FOUND' &&
      (request === './debug' || request === 'debug' || request === './node.js' || request === 'ms')
    ) {
      if (request === 'ms') {
        return val => (typeof val === 'number' ? `${val}ms` : 0);
      }
      const debugShim = function createDebug(namespace) {
        function debug() {}
        debug.namespace = namespace;
        debug.enabled = false;
        debug.useColors = false;
        debug.color = 0;
        debug.destroy = () => {};
        debug.extend = () => debug;
        return debug;
      };
      debugShim.debug = debugShim;
      debugShim.default = debugShim;
      debugShim.coerce = val => val;
      debugShim.disable = () => '';
      debugShim.enable = () => {};
      debugShim.enabled = () => false;
      debugShim.humanize = ms => `${ms}ms`;
      debugShim.names = [];
      debugShim.skips = [];
      debugShim.formatters = {};
      debugShim.selectColor = () => 0;
      return debugShim;
    }
    throw err;
  }
};

const express = require('express');
const fs = require('fs');
const path = require('path');
const { PORT, IS_VERCEL } = require('./src/config/constants');
const { handleApiRequest } = require('./src/routes/apiRouter');
const { initLocalBinaries } = require('./src/extractors/ytdlpBridge');

const app = express();

const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(process.cwd(), 'public');

// built-in HTML shell fallback in case Vercel serves static assets from Edge CDN instead of /var/task/public
const FALLBACK_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>FileHunt — Free Online Video Downloader</title>
  <link rel="stylesheet" href="/style.css" />
  <script type="importmap">
    {
      "imports": {
        "react": "https://esm.sh/react@18.3.1",
        "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
        "htm": "https://esm.sh/htm@3.1.1"
      }
    }
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.js"></script>
</body>
</html>`;

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/src/components', express.static(path.join(PUBLIC_DIR, 'components')));

// route all /api/* requests to our modular API controller
app.use('/api', async (req, res, next) => {
  try {
    req.pathname = '/api' + (req.path === '/' ? '' : req.path);
    req.query = req.query || {};
    await handleApiRequest(req, res);
  } catch (err) {
    next(err);
  }
});

// SPA fallback for client-side views
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexFile)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(fs.readFileSync(indexFile, 'utf8'));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(FALLBACK_INDEX_HTML);
});

app.use((err, req, res, _next) => {
  console.error('[FileHunt Error]:', err.message);
  if (!res.headersSent) {
    res.status(500).json({
      error: 'We apologize, but an unexpected server error occurred. Please try again.'
    });
  }
});

if (!IS_VERCEL) {
  initLocalBinaries();
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`FileHunt running at http://localhost:${PORT}`);
  });
}

module.exports = app;