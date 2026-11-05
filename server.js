const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to run yt-dlp and capture stdout
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));
    proc.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
    });
  });
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 1. Inspect URL & Return Rich Stream Metadata
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Please provide a valid URL.' });

  try {
    const raw = await runYtDlp(['--dump-single-json', '--no-playlist', '--no-warnings', url]);
    const info = JSON.parse(raw);

    const resolutionMap = new Map();
    (info.formats || []).forEach(f => {
      if (f.height && f.vcodec && f.vcodec !== 'none') {
        const existing = resolutionMap.get(f.height);
        const size = f.filesize || f.filesize_approx || null;
        if (!existing || (size && (!existing.filesize || size > existing.filesize))) {
          resolutionMap.set(f.height, {
            category: 'muxed',
            resolution: f.height,
            ext: f.ext || 'mp4',
            vcodec: (f.vcodec || 'h264').split('.')[0].toUpperCase(),
            fps: f.fps || 30,
            filesize: size
          });
        }
      }
    });

    const sortedFormats = Array.from(resolutionMap.values()).sort((a, b) => b.resolution - a.resolution);
    const resolutions = sortedFormats.map(f => f.resolution);
    const subtitles = Object.keys(info.subtitles || info.automatic_captions || { en: true }).slice(0, 8);

    res.json({
      title: info.title || 'Untitled Video',
      extractor: info.extractor_key || info.extractor || 'Web',
      duration: formatDuration(info.duration),
      thumbnail: info.thumbnail || '',
      uploader: info.uploader || info.channel || null,
      view_count: info.view_count || null,
      resolutions: resolutions.length ? resolutions : [1080, 720, 480, 360],
      formats: sortedFormats,
      subtitles
    });
  } catch (err) {
    res.status(500).json({ error: 'Unable to extract video info. Check the URL and try again.' });
  }
});

// 2. Download & Convert Endpoint (Supports MP4, MP3 bitrates, Video-Only, Subtitles, and Clipping)
app.get('/api/download', async (req, res) => {
  const { url, type = 'mp4', resolution = '720', bitrate = '192', start, end } = req.query;
  if (!url) return res.status(400).send('Missing URL parameter');

  const id = Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const clipArgs = [];
  if (start || end) {
    clipArgs.push('--download-sections', `*${start || '00:00:00'}-${end || 'inf'}`);
  }

  let outTemplate = path.join(TEMP_DIR, `filehunt_${id}.%(ext)s`);
  let args = ['--no-playlist', ...clipArgs, '-o', outTemplate];

  if (type === 'mp3') {
    if (bitrate === 'm4a') {
      args.push('-f', 'bestaudio[ext=m4a]/bestaudio', '--extract-audio', '--audio-format', 'm4a');
    } else {
      args.push('-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', `${bitrate}K`);
    }
  } else if (type === 'videoonly') {
    args.push('-f', `bestvideo[height<=${resolution}]/bestvideo`);
  } else {
    args.push(
      '-f',
      `bestvideo[height<=${resolution}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${resolution}][ext=mp4]/best`,
      '--merge-output-format',
      'mp4'
    );
  }

  args.push(url);

  try {
    await runYtDlp(args);
    const matchingFile = fs.readdirSync(TEMP_DIR).find(f => f.startsWith(`filehunt_${id}`));
    if (!matchingFile) return res.status(500).send('File conversion failed.');

    const fullPath = path.join(TEMP_DIR, matchingFile);
    res.download(fullPath, matchingFile, () => {
      fs.unlink(fullPath, () => {});
    });
  } catch (err) {
    res.status(500).send('Error processing download: ' + err.message);
  }
});

// 3. List All Supported Extractors
let cachedExtractors = null;
app.get('/api/extractors', async (req, res) => {
  try {
    if (!cachedExtractors) {
      const stdout = await runYtDlp(['--list-extractors']);
      cachedExtractors = stdout
        .split('\n')
        .map(s => s.trim())
        .filter(s => s && !s.includes('(CURRENTLY BROKEN)'));
    }
    res.json({ extractors: cachedExtractors });
  } catch (err) {
    res.status(500).json({ error: 'Could not load extractors' });
  }
});

app.listen(PORT, () => {
  console.log(`FileHunt server running at http://localhost:${PORT}`);
});