// allow scraping video hosts with self-signed or incomplete SSL certificate chains
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const path = require('path');
const { PORT, IS_VERCEL } = require('./src/config/constants');
const { handleApiRequest } = require('./src/routes/apiRouter');
const { initLocalBinaries } = require('./src/extractors/ytdlpBridge');

const app = express();

// resolve public directory reliably across local Node and Vercel serverless containers
const PUBLIC_DIR = fsExistsSafe(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(process.cwd(), 'public');

function fsExistsSafe(p) {
  try {
    return require('fs').existsSync(p);
  } catch {
    return false;
  }
}

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
    // adapt express req/res to match our API router signature
    req.query = req.query || {};
    await handleApiRequest(req, res);
  } catch (err) {
    next(err);
  }
});

// SPA fallback for client-side view routing
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (fsExistsSafe(indexFile)) {
    return res.sendFile(indexFile);
  }
  res.status(404).send('index.html not found');
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