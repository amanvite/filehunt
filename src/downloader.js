const { spawn } = require('child_process');
const { Readable } = require('stream');
const {
  BROWSER_UA,
  DEFAULT_AGE_COOKIES,
  LruCache,
  normalizeInputUrl,
  sanitizeFilename
} = require('./config');
const {
  ensureYtDlpBinary,
  getLocalFfmpegPath,
  resolveViaPublicPlatformApis,
  inspectViaYtDlp,
  scrapePageDeep
} = require('./extractor');

const sessionCache = new LruCache(300, 30 * 60 * 1000);

async function inspectMediaUrl(rawUrl) {
  const targetUrl = normalizeInputUrl(rawUrl);

  const cached = sessionCache.get(targetUrl);
  if (cached && cached.videoFormats?.length > 0) {
    return cached;
  }

  // Tier 1: Fast native platform APIs (Dailymotion Player API, Eporner JSON API)
  try {
    const apiData = await resolveViaPublicPlatformApis(targetUrl);
    if (apiData && apiData.videoFormats?.length > 0) {
      sessionCache.set(targetUrl, apiData);
      return apiData;
    }
  } catch {}

  // Tier 2: Standalone yt-dlp format inspection
  try {
    const ytData = await inspectViaYtDlp(targetUrl);
    if (ytData && ytData.videoFormats?.length > 0) {
      sessionCache.set(targetUrl, ytData);
      return ytData;
    }
  } catch {}

  // Tier 3: Deep HTML / KVS / /embed/<id> / Child Iframe / Headless Browser Inspector
  try {
    const deepData = await scrapePageDeep(targetUrl);
    if (deepData && deepData.videoFormats?.length > 0) {
      sessionCache.set(targetUrl, deepData);
      return deepData;
    }
  } catch {}

  return null;
}

// stream a child process stdout to Express res with continuous packet flushing
function pipeProcessToResponse(proc, res, cleanFilename, mimeType) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let headersWritten = false;

    const cleanup = () => {
      try {
        proc.kill('SIGKILL');
      } catch {}
    };

    res.on('close', () => {
      if (!res.writableEnded) {
        cleanup();
      }
    });

    res.on('error', () => cleanup());
    proc.stderr.on('data', () => {});

    // write HTTP headers on the first data chunk so if a process fails at startup we can still fall back cleanly
    proc.stdout.on('data', chunk => {
      if (!headersWritten && !res.headersSent) {
        headersWritten = true;
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${cleanFilename}"; filename*=UTF-8''${encodeURIComponent(cleanFilename)}`
        );
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Cache-Control', 'no-store');
      }
      if (!res.writableEnded) {
        const ok = res.write(chunk);
        if (!ok) {
          proc.stdout.pause();
          res.once('drain', () => {
            try { proc.stdout.resume(); } catch {}
          });
        }
      }
    });

    proc.stdout.on('error', () => cleanup());

    proc.on('error', err => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    proc.on('close', code => {
      if (!settled) {
        settled = true;
        if (headersWritten || code === 0) {
          if (!res.writableEnded) {
            try { res.end(); } catch {}
          }
          resolve();
        } else {
          reject(new Error(`Stream process exited with code ${code}`));
        }
      }
    });
  });
}

// stream progressive MP4 directly over the wire without memory-buffering pauses
async function pipeDirectProgressiveStream({
  streamUrl,
  userAgent,
  referer,
  cookies,
  req,
  res,
  cleanFilename,
  mimeType
}) {
  const connectController = new AbortController();
  // timeout applies ONLY to the initial connection handshake; cleared as soon as headers arrive
  const connectTimer = setTimeout(() => connectController.abort(), 15000);

  try {
    const clientRange = req.headers?.range;
    const isGoogleVideo = /googlevideo\.com/i.test(streamUrl);

    const headers = {
      'User-Agent': userAgent || BROWSER_UA
    };

    if (!isGoogleVideo) {
      if (referer) headers['Referer'] = referer;
      if (cookies) headers['Cookie'] = cookies;
    }
    if (clientRange) {
      headers['Range'] = clientRange;
    }

    const upstream = await fetch(streamUrl, {
      headers,
      redirect: 'follow',
      signal: connectController.signal
    });

    clearTimeout(connectTimer);

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    if ((!upstream.ok && upstream.status !== 206) || !upstream.body || contentType.includes('text/html')) {
      return false;
    }

    if (upstream.status === 206) {
      res.status(206);
    }

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${cleanFilename}"; filename*=UTF-8''${encodeURIComponent(cleanFilename)}`
    );
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');

    const exactLen = Number(upstream.headers.get('content-length') || 0);
    const contentRange = upstream.headers.get('content-range') || '';
    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
    }
    if (exactLen > 0) {
      res.setHeader('Content-Length', String(exactLen));
    }

    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => {
      if (!res.writableEnded) {
        try { res.end(); } catch {}
      }
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        try { nodeStream.destroy(); } catch {}
      }
    });

    nodeStream.pipe(res);
    return true;
  } catch {
    clearTimeout(connectTimer);
    return false;
  }
}

// start downloading in Chrome's download manager immediately with continuous packet flow (no "Resuming...")
async function streamMediaToResponse({ url, title, type = 'mp4', resolution = '720', bitrate = '192', req, res }) {
  const ext = type === 'mp3' ? 'mp3' : 'mp4';
  const suffix = type === 'mp3' ? `${bitrate}kbps` : `${resolution}p`;
  const cleanFilename = sanitizeFilename(title, suffix, ext);
  const mimeType = type === 'mp3' ? 'audio/mpeg' : 'video/mp4';

  const session = sessionCache.get(url) || (await inspectMediaUrl(url));
  if (!session) {
    return res.redirect('/?apology=1');
  }

  const refererToUse = session.finalPageUrl || url;
  const sessionCookies = session.cookieHeader || DEFAULT_AGE_COOKIES;
  const targetResNum = Number(resolution) || 720;
  const ffmpegBin = getLocalFfmpegPath();

  const streamsByRes = session.streamsByRes || {};
  const availableRes = Object.keys(streamsByRes).map(Number).sort((a, b) => b - a);
  const chosenRes = availableRes.find(r => r <= targetResNum) || availableRes[0];
  const chosenStream = chosenRes ? streamsByRes[chosenRes] : null;

  const streamUa = chosenStream?.userAgent || BROWSER_UA;
  const isGoogleStream =
    /googlevideo\.com/i.test(chosenStream?.videoUrl || '') ||
    /googlevideo\.com/i.test(chosenStream?.progressiveUrl || '');

  let ffmpegHeaders = `User-Agent: ${streamUa}\r\n`;
  if (!isGoogleStream) {
    ffmpegHeaders += `Referer: ${refererToUse}\r\n`;
    if (sessionCookies) {
      ffmpegHeaders += `Cookie: ${sessionCookies}\r\n`;
    }
  }

  // PATH 1: Continuous Real-Time MP3 Audio Stream via FFmpeg pipe:1
  if (type === 'mp3') {
    const audioSourceUrl =
      session.bestAudioUrl ||
      chosenStream?.progressiveUrl ||
      chosenStream?.hlsUrl ||
      chosenStream?.videoUrl;

    if (ffmpegBin && audioSourceUrl) {
      const audioUa = session.bestAudioUa || streamUa;
      try {
        const proc = spawn(ffmpegBin, [
          '-loglevel', 'error',
          '-user_agent', audioUa,
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-headers', ffmpegHeaders,
          '-i', audioSourceUrl,
          '-vn',
          '-acodec', 'libmp3lame',
          '-b:a', `${bitrate}k`,
          '-flush_packets', '1',
          '-f', 'mp3',
          'pipe:1'
        ]);
        await pipeProcessToResponse(proc, res, cleanFilename, 'audio/mpeg');
        return;
      } catch {}
    }
  }

  // PATH 2: Direct Progressive MP4 Stream (preserves exact Content-Length for "X MB of Y MB, N secs left")
  if (type !== 'mp3' && chosenStream?.progressiveUrl) {
    const piped = await pipeDirectProgressiveStream({
      streamUrl: chosenStream.progressiveUrl,
      userAgent: streamUa,
      referer: refererToUse,
      cookies: sessionCookies,
      req,
      res,
      cleanFilename,
      mimeType
    });
    if (piped) return;
  }

  // PATH 3: Continuous Real-Time FFmpeg Muxing (DASH 1080p/4K Video + Audio or HLS -> pipe:1 with -flush_packets 1)
  if (type !== 'mp3' && ffmpegBin && chosenStream) {
    if (chosenStream.videoUrl && session.bestAudioUrl && chosenStream.videoUrl !== session.bestAudioUrl) {
      try {
        const proc = spawn(ffmpegBin, [
          '-loglevel', 'error',
          '-user_agent', streamUa,
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-headers', ffmpegHeaders,
          '-i', chosenStream.videoUrl,
          '-user_agent', session.bestAudioUa || streamUa,
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-headers', ffmpegHeaders,
          '-i', session.bestAudioUrl,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-flush_packets', '1',
          '-f', 'mp4',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          'pipe:1'
        ]);
        await pipeProcessToResponse(proc, res, cleanFilename, 'video/mp4');
        return;
      } catch {}
    }

    const singleSource = chosenStream.hlsUrl || chosenStream.videoUrl;
    if (singleSource) {
      try {
        const proc = spawn(ffmpegBin, [
          '-loglevel', 'error',
          '-user_agent', streamUa,
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-headers', ffmpegHeaders,
          '-i', singleSource,
          '-c', 'copy',
          '-bsf:a', 'aac_adtstoasc',
          '-flush_packets', '1',
          '-f', 'mp4',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          'pipe:1'
        ]);
        await pipeProcessToResponse(proc, res, cleanFilename, 'video/mp4');
        return;
      } catch {}
    }
  }

  // PATH 4: Multi-Threaded yt-dlp Concurrent Fragment Stdout Stream (--concurrent-fragments 16 -o -)
  const ytdlpCmd = await ensureYtDlpBinary();
  if (ytdlpCmd) {
    const candidateTarget =
      chosenStream?.hlsUrl ||
      chosenStream?.progressiveUrl ||
      chosenStream?.videoUrl ||
      (session.childPages || [])[0] ||
      url;

    const isYouTube = /youtube\.com|youtu\.be/i.test(url);
    const args = [
      '--no-playlist',
      '--no-part',
      '--no-warnings',
      '--no-check-certificates',
      '--geo-bypass',
      '--concurrent-fragments', '16',
      '--buffer-size', '64K',
      '--http-chunk-size', '10M'
    ];

    if (!isYouTube) {
      args.push(
        '--referer', refererToUse,
        '--user-agent', BROWSER_UA,
        '--add-header', `Cookie:${sessionCookies}`
      );
    }

    args.push(
      '-f',
      type === 'mp3'
        ? 'bestaudio/best'
        : `best[height<=${targetResNum}][ext=mp4]/best[height<=${targetResNum}]/best`,
      '-o', '-',
      candidateTarget
    );

    if (ffmpegBin) {
      args.unshift('--ffmpeg-location', ffmpegBin);
    }

    const proc = spawn(ytdlpCmd, args);
    await pipeProcessToResponse(proc, res, cleanFilename, mimeType);
    return;
  }

  if (!res.headersSent) {
    res.redirect('/?apology=1');
  }
}

module.exports = {
  inspectMediaUrl,
  streamMediaToResponse
};