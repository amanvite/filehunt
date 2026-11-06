// allow scraping video hosts with self-signed or incomplete SSL certificate chains
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const path = require('path');
const { PORT, IS_VERCEL } = require('./src/config/constants');
const apiRouter = require('./src/routes/apiRouter');
const { initLocalBinaries } = require('./src/extractors/ytdlpBridge');

const app = express();

// disable x-powered-by header and apply baseline security headers
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '1mb' }));

// serve static frontend assets from public/
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.use('/src/components', express.static(path.join(PUBLIC_DIR, 'components')));

// mount all /api/* endpoints
app.use('/api', apiRouter);

// SPA fallback using app.use instead of app.get('*') so Express 4 & 5 never throw path-to-regexp errors
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// global error boundary so an unhandled exception never crashes the process
app.use((err, req, res, _next) => {
  console.error('[FileHunt Error]:', err.message);
  if (!res.headersSent) {
    res.status(500).json({
      error: 'We apologize, but an unexpected server error occurred. Please try again.'
    });
  }
});

// warm up local yt-dlp binary only when running on my local machine
if (!IS_VERCEL) {
  initLocalBinaries();
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`FileHunt v4.0 running at http://localhost:${PORT}`);
  });
}

module.exports = app;