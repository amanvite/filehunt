const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const {
  PORT,
  TEMP_DIR,
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
const chunkProxyStore = new LruCache(500, 30 * 60 * 1000);

// 2 MB streaming range window so packets flow immediately without waiting for 8 MB ArrayBuffers
const STREAM_WINDOW_BYTES = 2 * 1024 * 1024;

async function inspectMediaUrl(rawUrl) {
  const targetUrl = normalizeInputUrl(rawUrl);

  const cached = sessionCache.get(targetUrl);
  if (cached && cached.videoFormats?.length > 0) {
    return cached;
  }

  // Tier 1: Fast native platform APIs
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

// resolve exact total byte size of an upstream stream
async function resolveUpstreamTotalBytes({ streamUrl, knownSize, userAgent, referer, cookies }) {
  try {
    const parsed = new URL(streamUrl);
    const clen = parsed.searchParams.get('clen');
    if (clen && Number(clen) > 0) {
      return { totalBytes: Number(clen), supportsRanges: true };
    }
  } catch {}

  if (knownSize && Number(knownSize) > 0) {
    return { totalBytes: Number(knownSize), supportsRanges: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const isGoogleVideo = /googlevideo\.com/i.test(streamUrl);
    const probe = await fetch(streamUrl, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent || BROWSER_UA,
        ...(!isGoogleVideo && referer ? { Referer: referer } : {}),
        ...(!isGoogleVideo && cookies ? { Cookie: cookies } : {}),
        Range: 'bytes=0-1'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timer);

    const contentRange = probe.headers.get('content-range') || '';
    const m = contentRange.match(/\/(\d+)/);
    try { probe.body?.cancel?.(); } catch {}

    if (probe.status === 206 && m?.[1]) {
      return { totalBytes: Number(m[1]), supportsRanges: true };
    }

    const len = Number(probe.headers.get('content-length') || 0);
    return { totalBytes: len > 0 ? len : 0, supportsRanges: probe.status === 206 };
  } catch {
    clearTimeout(timer);
    return { totalBytes: 0, supportsRanges: false };
  }
}

// open a single range window [start..end] and return the raw fetch response for immediate packet streaming
async function openRangeWindowResponse({ streamUrl, start, end, userAgent, referer, cookies }) {
  const isGoogleVideo = /googlevideo\.com/i.test(streamUrl);

  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), 15000);

    try {
      let targetHref = streamUrl;
      const headers = {
        'User-Agent': userAgent || BROWSER_UA
      };

      if (isGoogleVideo) {
        const u = new URL(streamUrl);
        u.searchParams.set('range', `${start}-${end}`);
        targetHref = u.href;
      } else {
        headers['Range'] = `bytes=${start}-${end}`;
        if (referer) headers['Referer'] = referer;
        if (cookies) headers['Cookie'] = cookies;
      }

      const res = await fetch(targetHref, {
        headers,
        redirect: 'follow',
        signal: controller.signal
      });

      clearTimeout(connectTimer);

      if ((!res.ok && res.status !== 206) || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      return res;
    } catch (err) {
      clearTimeout(connectTimer);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

// download a single range chunk into a Buffer (used for 4x parallel audio pre-staging)
async function fetchRangeBuffer({ streamUrl, start, end, userAgent, referer, cookies }) {
  const res = await openRangeWindowResponse({ streamUrl, start, end, userAgent, referer, cookies });
  return Buffer.from(await res.arrayBuffer());
}

// pre-stage the small audio track (typically 2–4 MB) into temp/ using 4 parallel range workers in ~250ms
async function prestageAudioTrackToFile({ audioUrl, knownSize, userAgent, referer, cookies }) {
  const { totalBytes } = await resolveUpstreamTotalBytes({
    streamUrl: audioUrl,
    knownSize,
    userAgent,
    referer,
    cookies
  });

  if (!totalBytes || totalBytes <= 0 || totalBytes > 35 * 1024 * 1024) {
    return null;
  }

  const tempAudioPath = path.join(
    TEMP_DIR,
    `vh_audio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.m4a`
  );

  const partSize = 1024 * 1024; // 1 MB parallel parts
  const parts = [];
  for (let start = 0; start < totalBytes; start += partSize) {
    parts.push({
      index: parts.length,
      start,
      end: Math.min(start + partSize - 1, totalBytes - 1)
    });
  }

  const buffers = new Array(parts.length);
  const concurrency = 4;
  let cursor = 0;

  async function worker() {
    while (cursor < parts.length) {
      const myIdx = cursor++;
      const part = parts[myIdx];
      buffers[part.index] = await fetchRangeBuffer({
        streamUrl: audioUrl,
        start: part.start,
        end: part.end,
        userAgent,
        referer,
        cookies
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, parts.length) }, () => worker()));
  fs.writeFileSync(tempAudioPath, Buffer.concat(buffers));
  return tempAudioPath;
}

// stream 2 MB range windows packet-by-packet with zero ArrayBuffer pauses
async function streamRangeWindowsToResponse({
  streamUrl,
  knownSize,
  userAgent,
  referer,
  cookies,
  req,
  res,
  attachmentFilename = null,
  mimeType = 'video/mp4'
}) {
  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
  });

  const { totalBytes, supportsRanges } = await resolveUpstreamTotalBytes({
    streamUrl,
    knownSize,
    userAgent,
    referer,
    cookies
  });

  const isGoogleVideo = /googlevideo\.com/i.test(streamUrl);

  if (totalBytes > 0 && (supportsRanges || isGoogleVideo)) {
    let startByte = 0;
    let endByte = totalBytes - 1;
    const rangeHeader = req.headers?.range;

    if (rangeHeader) {
      const match = String(rangeHeader).match(/bytes=(\d+)-(\d*)/);
      if (match) {
        startByte = parseInt(match[1], 10);
        if (match[2]) {
          endByte = Math.min(parseInt(match[2], 10), totalBytes - 1);
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${startByte}-${endByte}/${totalBytes}`);
      }
    }

    const contentLength = endByte - startByte + 1;
    if (attachmentFilename) {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${attachmentFilename}"; filename*=UTF-8''${encodeURIComponent(attachmentFilename)}`
      );
    }
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(contentLength));
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();

    let cursor = startByte;
    let nextWindowPromise = null;
    let prefetchedStart = -1;
    let prefetchedEnd = -1;

    while (cursor <= endByte && !clientClosed && !res.writableEnded) {
      const winEnd = Math.min(cursor + STREAM_WINDOW_BYTES - 1, endByte);

      let currentResPromise;
      if (nextWindowPromise && prefetchedStart === cursor && prefetchedEnd === winEnd) {
        currentResPromise = nextWindowPromise;
        nextWindowPromise = null;
      } else {
        currentResPromise = openRangeWindowResponse({
          streamUrl,
          start: cursor,
          end: winEnd,
          userAgent,
          referer,
          cookies
        });
      }

      // pre-open the next 2 MB window connection in parallel while streaming current packets
      const nextStart = winEnd + 1;
      if (nextStart <= endByte && !clientClosed) {
        prefetchedStart = nextStart;
        prefetchedEnd = Math.min(nextStart + STREAM_WINDOW_BYTES - 1, endByte);
        nextWindowPromise = openRangeWindowResponse({
          streamUrl,
          start: prefetchedStart,
          end: prefetchedEnd,
          userAgent,
          referer,
          cookies
        }).catch(() => null);
      }

      const winRes = await currentResPromise;
      let bytesReceivedInWindow = 0;

      for await (const packet of winRes.body) {
        if (clientClosed || res.writableEnded) {
          try { winRes.body.cancel(); } catch {}
          break;
        }
        const buf = Buffer.from(packet);
        bytesReceivedInWindow += buf.length;
        const canContinue = res.write(buf);
        if (!canContinue) {
          await new Promise(resolve => res.once('drain', resolve));
        }
      }

      if (bytesReceivedInWindow <= 0) break;
      cursor += bytesReceivedInWindow;
    }

    if (!res.writableEnded) {
      res.end();
    }
    return true;
  }

  // Fallback for standard progressive servers without Range requirement
  const connectController = new AbortController();
  const connectTimer = setTimeout(() => connectController.abort(), 15000);

  try {
    const upstream = await fetch(streamUrl, {
      headers: {
        'User-Agent': userAgent || BROWSER_UA,
        ...(!isGoogleVideo && referer ? { Referer: referer } : {}),
        ...(!isGoogleVideo && cookies ? { Cookie: cookies } : {})
      },
      redirect: 'follow',
      signal: connectController.signal
    });
    clearTimeout(connectTimer);

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!upstream.ok || !upstream.body || contentType.includes('text/html')) {
      return false;
    }

    if (attachmentFilename) {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${attachmentFilename}"; filename*=UTF-8''${encodeURIComponent(attachmentFilename)}`
      );
    }
    res.setHeader('Content-Type', mimeType);
    const exactLen = Number(upstream.headers.get('content-length') || 0);
    if (exactLen > 0) {
      res.setHeader('Content-Length', String(exactLen));
    }
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();

    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => {
      if (!res.writableEnded) try { res.end(); } catch {}
    });
    res.on('close', () => {
      try { nodeStream.destroy(); } catch {}
    });

    nodeStream.pipe(res);
    return true;
  } catch {
    clearTimeout(connectTimer);
    return false;
  }
}

async function handleInternalChunkProxy(req, res) {
  const { token } = req.query || {};
  const meta = chunkProxyStore.get(token);
  if (!meta) {
    return res.status(404).end();
  }

  await streamRangeWindowsToResponse({
    streamUrl: meta.streamUrl,
    knownSize: meta.knownSize,
    userAgent: meta.userAgent,
    referer: meta.referer,
    cookies: meta.cookies,
    req,
    res,
    attachmentFilename: null,
    mimeType: 'application/octet-stream'
  });
}

function registerChunkProxyToken(meta) {
  const token = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  chunkProxyStore.set(token, meta);
  return `http://127.0.0.1:${PORT}/api/chunk-proxy?token=${encodeURIComponent(token)}`;
}

function pipeProcessToResponse(proc, res, cleanFilename, mimeType, onCleanup = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let headersWritten = false;

    const cleanup = () => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      if (typeof onCleanup === 'function') {
        try { onCleanup(); } catch {}
      }
    };

    res.on('close', () => {
      if (!res.writableEnded) {
        cleanup();
      }
    });

    res.on('error', () => cleanup());
    proc.stderr.on('data', () => {});

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
      cleanup();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    proc.on('close', code => {
      if (typeof onCleanup === 'function') {
        try { onCleanup(); } catch {}
      }
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

// start downloading in Chrome's download manager immediately with continuous packet flow and unthrottled speed
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
  let ffmpegHeaders = `User-Agent: ${streamUa}\r\nReferer: ${refererToUse}\r\n`;
  if (sessionCookies) {
    ffmpegHeaders += `Cookie: ${sessionCookies}\r\n`;
  }

  // PATH 1: High-Speed MP3 Audio Stream via Packet-Streaming Range Proxy -> FFmpeg pipe:1
  if (type === 'mp3') {
    const audioSourceUrl =
      session.bestAudioUrl ||
      chosenStream?.progressiveUrl ||
      chosenStream?.hlsUrl ||
      chosenStream?.videoUrl;

    if (ffmpegBin && audioSourceUrl) {
      const isHlsAudio = /\.m3u8(\?|$)/i.test(audioSourceUrl);
      const inputAudioUrl = isHlsAudio
        ? audioSourceUrl
        : registerChunkProxyToken({
            streamUrl: audioSourceUrl,
            knownSize: session.bestAudioSize || chosenStream?.progressiveSize || null,
            userAgent: session.bestAudioUa || streamUa,
            referer: refererToUse,
            cookies: sessionCookies
          });

      try {
        const ffArgs = ['-loglevel', 'error'];
        if (isHlsAudio) {
          ffArgs.push(
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-headers', ffmpegHeaders
          );
        }
        ffArgs.push(
          '-i', inputAudioUrl,
          '-vn',
          '-acodec', 'libmp3lame',
          '-b:a', `${bitrate}k`,
          '-flush_packets', '1',
          '-f', 'mp3',
          'pipe:1'
        );

        const proc = spawn(ffmpegBin, ffArgs);
        await pipeProcessToResponse(proc, res, cleanFilename, 'audio/mpeg');
        return;
      } catch {}
    }
  }

  // PATH 2: Direct Progressive MP4 Stream via 2 MB Packet-Streaming Range Windows (shows exact total MB & time left)
  if (type !== 'mp3' && chosenStream?.progressiveUrl) {
    const pumped = await streamRangeWindowsToResponse({
      streamUrl: chosenStream.progressiveUrl,
      knownSize: chosenStream.progressiveSize,
      userAgent: streamUa,
      referer: refererToUse,
      cookies: sessionCookies,
      req,
      res,
      attachmentFilename: cleanFilename,
      mimeType: 'video/mp4'
    });
    if (pumped) return;
  }

  // PATH 3: Unthrottled DASH 1080p/4K Video + Pre-Staged Local Audio -> Micro-Fragmented FFmpeg Pipe
  if (type !== 'mp3' && ffmpegBin && chosenStream) {
    if (chosenStream.videoUrl && session.bestAudioUrl && chosenStream.videoUrl !== session.bestAudioUrl) {
      let localAudioFile = null;
      try {
        // pre-stage the small audio file in 4 parallel range threads (~250ms) so the audio socket never idles or drops
        localAudioFile = await prestageAudioTrackToFile({
          audioUrl: session.bestAudioUrl,
          knownSize: session.bestAudioSize || null,
          userAgent: session.bestAudioUa || streamUa,
          referer: refererToUse,
          cookies: sessionCookies
        });
      } catch {}

      const proxiedVideoUrl = registerChunkProxyToken({
        streamUrl: chosenStream.videoUrl,
        knownSize: chosenStream.videoSize || null,
        userAgent: streamUa,
        referer: refererToUse,
        cookies: sessionCookies
      });

      const audioInput =
        localAudioFile ||
        registerChunkProxyToken({
          streamUrl: session.bestAudioUrl,
          knownSize: session.bestAudioSize || null,
          userAgent: session.bestAudioUa || streamUa,
          referer: refererToUse,
          cookies: sessionCookies
        });

      const cleanupTempAudio = () => {
        if (localAudioFile && fs.existsSync(localAudioFile)) {
          fs.unlink(localAudioFile, () => {});
        }
      };

      try {
        // -frag_size 131072 and -flush_packets 1 force FFmpeg to emit fragments every 128 KB with zero dead-air pauses
        const proc = spawn(ffmpegBin, [
          '-loglevel', 'error',
          '-i', proxiedVideoUrl,
          '-i', audioInput,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-frag_size', '131072',
          '-flush_packets', '1',
          '-f', 'mp4',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          'pipe:1'
        ]);
        await pipeProcessToResponse(proc, res, cleanFilename, 'video/mp4', cleanupTempAudio);
        return;
      } catch {
        cleanupTempAudio();
      }
    }

    const singleSource = chosenStream.hlsUrl || chosenStream.videoUrl;
    if (singleSource) {
      const isHls = /\.m3u8(\?|$)/i.test(singleSource);
      const inputUrl = isHls
        ? singleSource
        : registerChunkProxyToken({
            streamUrl: singleSource,
            knownSize: chosenStream.videoSize || null,
            userAgent: streamUa,
            referer: refererToUse,
            cookies: sessionCookies
          });

      try {
        const ffArgs = ['-loglevel', 'error'];
        if (isHls) {
          ffArgs.push(
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-headers', ffmpegHeaders
          );
        }
        ffArgs.push(
          '-i', inputUrl,
          '-c', 'copy',
          '-bsf:a', 'aac_adtstoasc',
          '-frag_size', '131072',
          '-flush_packets', '1',
          '-f', 'mp4',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          'pipe:1'
        );

        const proc = spawn(ffmpegBin, ffArgs);
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
  streamMediaToResponse,
  handleInternalChunkProxy
};