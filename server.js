// allow scraping video hosts with self-signed or incomplete SSL certificate chains
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// self-healing module guard so a corrupted or cached node_modules/debug never crashes Express
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  try {
    return originalLoad.apply(this, arguments);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && (request === './debug' || request === 'debug')) {
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
const path = require('path');
const { PORT, IS_VERCEL } = require('./src/config/constants');
const { handleApiRequest } = require('./src/routes/apiRouter');
const { initLocalBinaries } = require('./src/extractors/ytdlpBridge');

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');

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

// route all /api/* requests to our modular API handler
app.use('/api', async (req, res, next) => {
  try {
    req.pathname = '/api' + (req.path === '/' ? '' : req.path);
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
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
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