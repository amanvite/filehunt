const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const {
  TEMP_DIR,
  BROWSER_UA,
  DEFAULT_AGE_COOKIES,
  MIN_VALID_VIDEO_BYTES,
  snapToStandardResolution,
  formatBytes,
  formatDuration,
  decodeHtmlEntities,
  humanizeUrlSlug,
  resolveAbsoluteUrl
} = require('./config');

const BINARY_FILENAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const LOCAL_YTDLP_BIN = path.join(TEMP_DIR, BINARY_FILENAME);

let resolvedYtDlpCmd = null;
let ytdlpDownloadPromise = null;
let resolvedFfmpegPath = null;

function getLocalFfmpegPath() {
  if (resolvedFfmpegPath) return resolvedFfmpegPath;

  try {
    const candidate = require('ffmpeg-static');
    if (candidate && fs.existsSync(candidate)) {
      resolvedFfmpegPath = candidate;
      return resolvedFfmpegPath;
    }
  } catch {}

  const winCandidates = [
    path.join(TEMP_DIR, 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\WinGet\\Links\\ffmpeg.exe')
  ];

  for (const c of winCandidates) {
    if (c && fs.existsSync(c)) {
      resolvedFfmpegPath = c;
      return resolvedFfmpegPath;
    }
  }
  return null;
}

async function ensureYtDlpBinary() {
  if (resolvedYtDlpCmd && (resolvedYtDlpCmd === 'yt-dlp' || fs.existsSync(resolvedYtDlpCmd))) {
    return resolvedYtDlpCmd;
  }

  try {
    if (fs.existsSync(LOCAL_YTDLP_BIN) && fs.statSync(LOCAL_YTDLP_BIN).size > 5000000) {
      resolvedYtDlpCmd = LOCAL_YTDLP_BIN;
      return resolvedYtDlpCmd;
    }
  } catch {}

  const hasGlobal = await new Promise(resolve => {
    try {
      const p = spawn('yt-dlp', ['--version']);
      p.on('error', () => resolve(false));
      p.on('close', code => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });

  if (hasGlobal) {
    resolvedYtDlpCmd = 'yt-dlp';
    return resolvedYtDlpCmd;
  }

  if (!ytdlpDownloadPromise) {
    ytdlpDownloadPromise = (async () => {
      const releaseUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${BINARY_FILENAME}`;
      console.log('Downloading standalone yt-dlp binary into temp/ folder...');
      const res = await fetch(releaseUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(LOCAL_YTDLP_BIN, buffer);
      if (process.platform !== 'win32') {
        fs.chmodSync(LOCAL_YTDLP_BIN, 0o755);
      }
      console.log('Standalone yt-dlp binary ready.');
      resolvedYtDlpCmd = LOCAL_YTDLP_BIN;
      return resolvedYtDlpCmd;
    })().catch(() => {
      ytdlpDownloadPromise = null;
      return null;
    });
  }

  return ytdlpDownloadPromise;
}

function initLocalBinaries() {
  getLocalFfmpegPath();
  ensureYtDlpBinary();
}

async function runYtDlp(args, timeoutMs = 45000) {
  const cmd = await ensureYtDlpBinary();
  if (!cmd) throw new Error('yt-dlp binary unavailable');
  const ffmpegBin = getLocalFfmpegPath();

  return new Promise((resolve, reject) => {
    let settled = false;
    let proc;
    try {
      const fullArgs = ffmpegBin ? ['--ffmpeg-location', ffmpegBin, ...args] : args;
      proc = spawn(cmd, fullArgs);
    } catch (err) {
      return reject(err);
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill(); } catch {}
        reject(new Error('yt-dlp timeout'));
      }
    }, timeoutMs);

    proc.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    proc.stdout.on('data', d => (stdout += d.toString()));
    proc.stderr.on('data', d => (stderr += d.toString()));

    proc.on('close', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) resolve(stdout);
        else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      }
    });
  });
}

function isPreviewOrJunkUrl(candidateUrl) {
  if (!candidateUrl) return true;
  return (
    /\.m3u8|_preview\.|-preview\.|\/previews\/|\/thumbs\/|\/t\/|trailer|teaser|sprite|banner|logo|_TPL_/i.test(
      candidateUrl
    ) ||
    /\.(jpg|jpeg|png|webp|gif|svg|css|js|vtt|srt|xml|html|php|json|ico)(\?|$)/i.test(candidateUrl)
  );
}

function stripHoverPreviewTags(rawHtml) {
  if (!rawHtml) return '';
  return rawHtml.replace(
    /<(?:video|source)[^>]*(?:data-preview|data-trailer|onmouseover|onmouseenter)[^>]*>/gi,
    ''
  );
}

function unpackDeanEdwards(html) {
  let unpackedChunks = '';
  const packedRegex = /eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]*?\}\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\.split\('\|'\)/gi;
  let match;
  while ((match = packedRegex.exec(html)) !== null) {
    try {
      let payload = match[1];
      const radix = parseInt(match[2], 10);
      let count = parseInt(match[3], 10);
      const symtab = match[4].split('|');

      const encodeBase = (num) => {
        const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        if (num < radix) {
          return num < 36 ? num.toString(36) : chars[num];
        }
        return encodeBase(Math.floor(num / radix)) + encodeBase(num % radix);
      };

      while (count--) {
        if (symtab[count]) {
          const token = encodeBase(count);
          payload = payload.replace(new RegExp(`\\b${token}\\b`, 'g'), symtab[count]);
        }
      }
      unpackedChunks += '\n' + payload;
    } catch {}
  }
  return unpackedChunks;
}

function decodeInlineBase64Urls(text) {
  let decodedExtras = '';
  const b64Regex = /(?:atob|base64_decode)\(\s*['"]([A-Za-z0-9+/=]{16,})['"]\s*\)/gi;
  let m;
  while ((m = b64Regex.exec(text)) !== null) {
    try {
      const dec = Buffer.from(m[1], 'base64').toString('utf8');
      if (/https?:\/\/|\/\/|\.mp4|\.m3u8|\/get_file\/|\/embed\/|\/video/i.test(dec)) {
        decodedExtras += '\n' + dec;
      }
    } catch {}
  }
  return decodedExtras;
}

function decodeKvsUrl(rawUrl, licenseCode) {
  if (!rawUrl) return '';
  if (!rawUrl.startsWith('function/0/')) return rawUrl;

  const realUrl = rawUrl.slice('function/0/'.length);
  if (!licenseCode) return realUrl;

  try {
    const cleanLicense = String(licenseCode).replace(/^\$/, '');
    let c = '';
    for (let i = 0; i < cleanLicense.length; i++) {
      c += cleanLicense[i] === '0' ? '1' : cleanLicense[i];
    }

    const s = Math.floor(c.length / 2);
    const k1 = parseInt(c.substring(0, s + 1), 10);
    const k2 = parseInt(c.substring(s), 10);
    const diff = Math.abs(k2 - k1) * 4;
    const diffStr = String(diff);
    const iLen = s + 1;

    const swapTable = [];
    for (let g = 0; g < iLen; g++) {
      for (let h = 1; h <= 4; h++) {
        const d1 = parseInt(cleanLicense[g + h - 1], 10) || 0;
        const d2 = parseInt(diffStr[g % diffStr.length], 10) || 0;
        let sum = d1 + d2;
        if (sum >= 10) sum -= 10;
        swapTable.push(sum);
      }
    }

    const urlParts = realUrl.split('/');
    const tokenIdx = urlParts.findIndex(seg => /^[0-9a-f]{32}/i.test(seg));
    if (tokenIdx === -1) return realUrl;

    const origSeg = urlParts[tokenIdx];
    const hashChars = origSeg.slice(0, 32).split('');
    for (let k = 31; k >= 0; k--) {
      const swapPos = (k + (swapTable[k] || 0)) % 32;
      const tmp = hashChars[k];
      hashChars[k] = hashChars[swapPos];
      hashChars[swapPos] = tmp;
    }

    urlParts[tokenIdx] = hashChars.join('') + origSeg.slice(32);
    return urlParts.join('/');
  } catch {
    return realUrl;
  }
}

async function parseHlsMasterManifest(m3u8Url, refererUrl, cookieHeader) {
  const variants = {};
  try {
    const res = await fetch(m3u8Url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': refererUrl,
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return variants;
    const text = await res.text();
    if (!text.includes('#EXTM3U')) return variants;

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/i);
        const nameMatch = line.match(/NAME="?(2160|1440|1080|720|480|360|240|144)p?"?/i);
        const bwMatch = line.match(/BANDWIDTH=(\d+)/i);

        let height = null;
        if (resMatch) {
          const w = parseInt(resMatch[1], 10);
          const h = parseInt(resMatch[2], 10);
          height = snapToStandardResolution(Math.min(w, h));
        } else if (nameMatch) {
          height = snapToStandardResolution(parseInt(nameMatch[1], 10));
        }

        let nextUri = null;
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].startsWith('#')) {
            nextUri = lines[j];
            break;
          }
        }

        if (height && nextUri) {
          const absVariantUrl = resolveAbsoluteUrl(nextUri, res.url || m3u8Url);
          if (absVariantUrl && !variants[height]) {
            variants[height] = {
              url: absVariantUrl,
              bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : null
            };
          }
        }
      }
    }

    if (Object.keys(variants).length === 0 && text.includes('#EXTINF:')) {
      const resFromUrl = m3u8Url.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
      const h = resFromUrl ? Number(resFromUrl[1]) : 720;
      variants[h] = { url: m3u8Url, bandwidth: null };
    }
  } catch {}
  return variants;
}

function buildStreamsByRes(verifiedDirectMap = {}, hlsVariantsByRes = {}, uniqueHls = []) {
  const streamsByRes = {};

  Object.entries(verifiedDirectMap).forEach(([resKey, info]) => {
    const r = Number(resKey);
    if (!r || !info?.url) return;
    streamsByRes[r] = {
      progressiveUrl: info.url,
      progressiveSize: info.filesize || null,
      videoUrl: info.url,
      videoSize: info.filesize || null,
      userAgent: BROWSER_UA,
      hlsUrl: null
    };
  });

  Object.entries(hlsVariantsByRes).forEach(([resKey, info]) => {
    const r = Number(resKey);
    if (!r || !info?.url) return;
    if (!streamsByRes[r]) {
      streamsByRes[r] = {
        progressiveUrl: null,
        progressiveSize: null,
        videoUrl: null,
        videoSize: null,
        userAgent: BROWSER_UA,
        hlsUrl: info.url
      };
    } else if (!streamsByRes[r].hlsUrl) {
      streamsByRes[r].hlsUrl = info.url;
    }
  });

  if (Object.keys(streamsByRes).length === 0 && uniqueHls.length > 0) {
    streamsByRes[720] = {
      progressiveUrl: null,
      progressiveSize: null,
      videoUrl: null,
      videoSize: null,
      userAgent: BROWSER_UA,
      hlsUrl: uniqueHls[0]
    };
  }

  return streamsByRes;
}

async function resolveViaPublicPlatformApis(targetUrl) {
  const dmMatch =
    targetUrl.match(/dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/i) ||
    targetUrl.match(/dai\.ly\/([a-zA-Z0-9]+)/i);

  if (dmMatch) {
    const videoId = dmMatch[1];
    try {
      const metaRes = await fetch(`https://www.dailymotion.com/player/metadata/video/${videoId}`, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(5000)
      });
      if (metaRes.ok) {
        const meta = await metaRes.json();
        const durationSec = Number(meta.duration) || null;
        const qualities = meta.qualities || {};
        const verifiedDirectMap = {};
        const hlsStreams = [];
        const resolutionMap = new Map();

        Object.entries(qualities).forEach(([qKey, streamList]) => {
          if (!Array.isArray(streamList)) return;
          const numRes = snapToStandardResolution(parseInt(qKey, 10));
          streamList.forEach(entry => {
            if (!entry?.url) return;
            if (entry.type === 'application/x-mpegURL' || /\.m3u8/i.test(entry.url)) {
              hlsStreams.push(entry.url);
            } else if (numRes) {
              verifiedDirectMap[numRes] = { url: entry.url, filesize: null };
            }
          });
          if (numRes) {
            resolutionMap.set(numRes, {
              resolution: numRes,
              ext: 'mp4',
              codec: 'Video (H.264 + AAC)',
              sizeText: null
            });
          }
        });

        const hlsVariantsByRes = {};
        if (hlsStreams.length > 0) {
          const parsedVariants = await parseHlsMasterManifest(hlsStreams[0], targetUrl, DEFAULT_AGE_COOKIES);
          Object.entries(parsedVariants).forEach(([resKey, info]) => {
            const r = Number(resKey);
            hlsVariantsByRes[r] = info;
            if (!resolutionMap.has(r)) {
              resolutionMap.set(r, {
                resolution: r,
                ext: 'mp4',
                codec: 'Video (H.264 + AAC)',
                sizeText: null
              });
            }
          });
        }

        const thumbs = meta.posters || {};
        const bestThumb = thumbs['1080'] || thumbs['720'] || thumbs['480'] || thumbs['360'] || '';

        const videoFormats = Array.from(resolutionMap.values()).sort((a, b) => b.resolution - a.resolution);
        if (videoFormats.length > 0) {
          const streamsByRes = buildStreamsByRes(verifiedDirectMap, hlsVariantsByRes, hlsStreams);
          const firstStream = Object.values(streamsByRes)[0];
          return {
            title: decodeHtmlEntities(meta.title || `Dailymotion Video (${videoId})`),
            extractor: 'Dailymotion',
            uploader: meta.owner?.username || 'Dailymotion',
            duration: formatDuration(durationSec) || 'HD Video',
            thumbnail: bestThumb,
            resolutions: videoFormats.map(v => v.resolution),
            videoFormats,
            audioFormats: [
              { bitrate: 320, label: '320 kbps', desc: 'MP3 High Bitrate Audio' },
              { bitrate: 192, label: '192 kbps', desc: 'MP3 Standard Stereo Audio' },
              { bitrate: 128, label: '128 kbps', desc: 'MP3 Compact Audio' }
            ],
            streamsByRes,
            bestAudioUrl: firstStream?.progressiveUrl || firstStream?.hlsUrl || null,
            bestAudioSize: null,
            bestAudioUa: BROWSER_UA,
            verifiedDirectMap,
            hlsVariantsByRes,
            hlsStreams,
            childPages: [],
            finalPageUrl: targetUrl,
            cookieHeader: DEFAULT_AGE_COOKIES
          };
        }
      }
    } catch {}
  }

  if (/eporner\.com/i.test(targetUrl)) {
    try {
      const pageRes = await fetch(targetUrl, {
        headers: { 'User-Agent': BROWSER_UA, 'Cookie': DEFAULT_AGE_COOKIES },
        signal: AbortSignal.timeout(6000)
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const vidMatch = html.match(/vid\s*:\s*['"]([a-zA-Z0-9]+)['"]/i);
        const hashMatch = html.match(/hash\s*:\s*['"]([0-9a-f]{32})['"]/i);
        if (vidMatch && hashMatch) {
          const vid = vidMatch[1];
          const rawHash = hashMatch[1];
          let encodedHash = '';
          for (let i = 0; i < 32; i += 8) {
            encodedHash += parseInt(rawHash.substring(i, i + 8), 16).toString(36);
          }
          const xhrRes = await fetch(
            `https://www.eporner.com/xhr/video/${vid}?hash=${encodedHash}&device=generic&domain=www.eporner.com&fallback=false&embed=false&supportedFormats=mp4`,
            { headers: { 'User-Agent': BROWSER_UA, 'Referer': targetUrl } }
          );
          if (xhrRes.ok) {
            const epData = await xhrRes.json();
            const mp4Map = epData?.sources?.mp4 || {};
            const verifiedDirectMap = {};
            const videoFormats = [];
            Object.entries(mp4Map).forEach(([label, obj]) => {
              const resMatch = label.match(/(\d{3,4})p/i);
              const res = resMatch ? snapToStandardResolution(resMatch[1]) : 720;
              if (res && obj?.src) {
                verifiedDirectMap[res] = { url: obj.src, filesize: null };
                videoFormats.push({
                  resolution: res,
                  ext: 'mp4',
                  codec: 'Video (H.264 + AAC)',
                  sizeText: obj.size || null
                });
              }
            });
            videoFormats.sort((a, b) => b.resolution - a.resolution);
            if (videoFormats.length > 0) {
              const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
              const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
              const streamsByRes = buildStreamsByRes(verifiedDirectMap, {}, []);
              const firstStream = Object.values(streamsByRes)[0];
              return {
                title: decodeHtmlEntities(ogTitle ? ogTitle[1] : humanizeUrlSlug(targetUrl)),
                extractor: 'Eporner',
                uploader: 'Eporner',
                duration: 'HD Video',
                thumbnail: ogImage ? ogImage[1] : '',
                resolutions: videoFormats.map(v => v.resolution),
                videoFormats,
                audioFormats: [
                  { bitrate: 320, label: '320 kbps', desc: 'MP3 High Bitrate Audio' },
                  { bitrate: 192, label: '192 kbps', desc: 'MP3 Standard Stereo Audio' },
                  { bitrate: 128, label: '128 kbps', desc: 'MP3 Compact Audio' }
                ],
                streamsByRes,
                bestAudioUrl: firstStream?.progressiveUrl || null,
                bestAudioSize: null,
                bestAudioUa: BROWSER_UA,
                verifiedDirectMap,
                hlsVariantsByRes: {},
                hlsStreams: [],
                childPages: [],
                finalPageUrl: targetUrl,
                cookieHeader: DEFAULT_AGE_COOKIES
              };
            }
          }
        }
      }
    } catch {}
  }

  return null;
}

function extractStreamsFromHtml(rawHtml, baseUrl, directStreams = {}, hlsStreams = []) {
  const cleanedHtml = stripHoverPreviewTags(rawHtml);
  const unpacked = unpackDeanEdwards(cleanedHtml);
  const b64Decoded = decodeInlineBase64Urls(cleanedHtml + '\n' + unpacked);
  const combined = cleanedHtml + '\n' + unpacked + '\n' + b64Decoded;

  const unescaped = combined
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');

  let urlDecodedExtras = '';
  const encodedUrlRegex = /https?%3A%2F%2F[^\s"'<>\\&]+/gi;
  let encMatch;
  while ((encMatch = encodedUrlRegex.exec(unescaped)) !== null) {
    try {
      urlDecodedExtras += '\n' + decodeURIComponent(encMatch[0]);
    } catch {}
  }

  const fullText = unescaped + '\n' + urlDecodedExtras;

  const metaStreamRegex = /<meta[^>]+(?:property|name)=["'](?:og:video|og:video:url|og:video:secure_url|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi;
  let metaMatch;
  while ((metaMatch = metaStreamRegex.exec(fullText)) !== null) {
    const mUrl = resolveAbsoluteUrl(metaMatch[1].trim(), baseUrl);
    if (mUrl && /^https?:\/\//i.test(mUrl) && !/\.(swf|html|php)(\?|$)/i.test(mUrl)) {
      if (/\.m3u8(\?|$)/i.test(mUrl)) hlsStreams.push(mUrl);
      else if (!isPreviewOrJunkUrl(mUrl) && !directStreams[720]) directStreams[720] = mUrl;
    }
  }

  const preloadVideoRegex = /<link[^>]+as=["']video["'][^>]+href=["']([^"']+)["']/gi;
  let plMatch;
  while ((plMatch = preloadVideoRegex.exec(fullText)) !== null) {
    const pUrl = resolveAbsoluteUrl(plMatch[1].trim(), baseUrl);
    if (pUrl && /^https?:\/\//i.test(pUrl)) {
      if (/\.m3u8(\?|$)/i.test(pUrl)) hlsStreams.push(pUrl);
      else if (!isPreviewOrJunkUrl(pUrl) && !directStreams[720]) directStreams[720] = pUrl;
    }
  }

  const xvHigh = fullText.match(/setVideoUrlHigh\(\s*['"]([^'"]+)['"]\s*\)/i);
  const xvLow = fullText.match(/setVideoUrlLow\(\s*['"]([^'"]+)['"]\s*\)/i);
  const xvHls = fullText.match(/setVideoHLS\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (xvHigh?.[1]) directStreams[720] = resolveAbsoluteUrl(xvHigh[1], baseUrl);
  if (xvLow?.[1]) directStreams[360] = resolveAbsoluteUrl(xvLow[1], baseUrl);
  if (xvHls?.[1]) hlsStreams.push(resolveAbsoluteUrl(xvHls[1], baseUrl));

  const mediaDefRegex = /"videoUrl"\s*:\s*"([^"]+)"\s*,\s*"quality"\s*:\s*"?(\d{3,4})"?/gi;
  let mdMatch;
  while ((mdMatch = mediaDefRegex.exec(fullText)) !== null) {
    const vUrl = resolveAbsoluteUrl(mdMatch[1], baseUrl);
    const q = snapToStandardResolution(mdMatch[2]);
    if (vUrl && q && /^https?:\/\//i.test(vUrl)) {
      if (/\.m3u8/i.test(vUrl)) hlsStreams.push(vUrl);
      else if (!isPreviewOrJunkUrl(vUrl)) directStreams[q] = vUrl;
    }
  }

  ['2160p', '1440p', '1080p', '720p', '480p', '360p', '240p'].forEach(qKey => {
    const sbMatch = fullText.match(new RegExp(`['"]?${qKey}['"]?\\s*:\\s*\\[\\s*['"]([^'"]+)['"]`, 'i'));
    if (sbMatch?.[1]) {
      const abs = resolveAbsoluteUrl(sbMatch[1], baseUrl);
      const h = parseInt(qKey, 10);
      if (/\.m3u8/i.test(abs)) hlsStreams.push(abs);
      else if (/^https?:\/\//i.test(abs) && !isPreviewOrJunkUrl(abs)) directStreams[h] = abs;
    }
  });

  const initialsMatch = rawHtml.match(/window\.initials\s*=\s*(\{[\s\S]*?\});\s*<\/script>/i);
  if (initialsMatch) {
    try {
      const initials = JSON.parse(initialsMatch[1]);
      const mp4Sources =
        initials?.xplayerSettings?.sources?.standard?.h264 ||
        initials?.xplayerSettings?.sources?.standard?.mp4 ||
        initials?.videoModel?.sources?.mp4 ||
        initials?.videoEntity?.sources?.mp4 ||
        [];

      if (Array.isArray(mp4Sources)) {
        mp4Sources.forEach(item => {
          const u = item?.url || item?.fallback;
          const q = snapToStandardResolution(parseInt(String(item?.quality || item?.label || '720'), 10)) || 720;
          if (u && !/\.m3u8(\?|$)/i.test(u)) {
            directStreams[q] = resolveAbsoluteUrl(u, baseUrl);
          } else if (u && /\.m3u8(\?|$)/i.test(u)) {
            hlsStreams.push(resolveAbsoluteUrl(u, baseUrl));
          }
        });
      } else if (mp4Sources && typeof mp4Sources === 'object') {
        Object.entries(mp4Sources).forEach(([k, val]) => {
          const u = typeof val === 'string' ? val : val?.url;
          const q = snapToStandardResolution(parseInt(k, 10)) || 720;
          if (u && !/\.m3u8(\?|$)/i.test(u)) {
            directStreams[q] = resolveAbsoluteUrl(u, baseUrl);
          }
        });
      }

      const hlsObj = initials?.xplayerSettings?.sources?.hls;
      if (hlsObj) {
        Object.values(hlsObj).forEach(entry => {
          if (entry?.url) hlsStreams.push(resolveAbsoluteUrl(entry.url, baseUrl));
        });
      }
    } catch {}
  }

  const licenseMatch = fullText.match(/license_code\s*:\s*['"]([^'"]+)['"]/i);
  const licenseCode = licenseMatch ? licenseMatch[1] : '';

  const kvsKeys = [
    { key: 'video_url', defaultRes: 720, textKey: 'video_url_text' },
    { key: 'video_alt_url', defaultRes: 1080, textKey: 'video_alt_url_text' },
    { key: 'video_alt_url2', defaultRes: 1080, textKey: 'video_alt_url2_text' },
    { key: 'video_alt_url3', defaultRes: 2160, textKey: 'video_alt_url3_text' }
  ];

  kvsKeys.forEach(({ key, defaultRes, textKey }) => {
    const valMatch = fullText.match(new RegExp(`${key}\\s*:\\s*['"]([^'"]+)['"]`, 'i'));
    if (valMatch && valMatch[1]) {
      const decoded = decodeKvsUrl(valMatch[1], licenseCode);
      const absUrl = resolveAbsoluteUrl(decoded, baseUrl);
      if (absUrl && /^https?:\/\//i.test(absUrl) && !isPreviewOrJunkUrl(absUrl)) {
        const textMatch = fullText.match(new RegExp(`${textKey}\\s*:\\s*['"]([^'"]+)['"]`, 'i'));
        const resMatch =
          (textMatch && textMatch[1].match(/(2160|1440|1080|720|480|360|240)/)) ||
          absUrl.match(/[_/-](2160|1440|1080|720|480|360|240)p?\b/i);
        const res = resMatch ? Number(resMatch[1]) : defaultRes;
        directStreams[res] = absUrl;
      }
    }
  });

  const html5VideoTagRegex = /<(?:video|source)[^>]+(?:src|data-src|data-video|data-mp4)=["']([^"']+)["'][^>]*>/gi;
  let vMatch;
  while ((vMatch = html5VideoTagRegex.exec(fullText)) !== null) {
    const rawTag = vMatch[0];
    if (/data-preview|mouseover/i.test(rawTag)) continue;
    const rawSrc = vMatch[1].trim();
    if (!rawSrc || rawSrc.startsWith('blob:') || rawSrc.startsWith('data:') || rawSrc === '#') continue;
    const srcUrl = resolveAbsoluteUrl(rawSrc, baseUrl);
    if (!/^https?:\/\//i.test(srcUrl)) continue;

    if (/\.m3u8(\?|$)/i.test(srcUrl)) {
      hlsStreams.push(srcUrl);
      continue;
    }

    if (isPreviewOrJunkUrl(srcUrl)) continue;

    const labelMatch =
      rawTag.match(/(?:label|title|res|data-res|size)=["']?(2160|1440|1080|720|480|360|240|144)p?/i) ||
      srcUrl.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
    const res = labelMatch ? Number(labelMatch[1]) : !directStreams[720] ? 720 : 480;
    if (!directStreams[res]) {
      directStreams[res] = srcUrl;
    }
  }

  const playerPropRegex = /(?:__fileurl|file|video_url|mp4_url|stream_url|contentUrl|hq_video_file|normal_video_file)\s*[:=]\s*['"]((?:https?:)?\/\/[^'"\s<>]+|\/[^'"\s<>]+)['"]/gi;
  let pMatch;
  while ((pMatch = playerPropRegex.exec(fullText)) !== null) {
    const candidate = resolveAbsoluteUrl(pMatch[1], baseUrl);
    if (!candidate || !/^https?:\/\//i.test(candidate)) continue;

    if (/\.m3u8(\?|$)/i.test(candidate)) {
      hlsStreams.push(candidate);
    } else if (!isPreviewOrJunkUrl(candidate) && (/\.(mp4|webm|m4v|mov)(\?|$)|\/get_file\/|\/stream\/|\/mp4\/|\/video/i.test(candidate))) {
      const resHit = candidate.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
      const resKey = resHit ? Number(resHit[1]) : !directStreams[720] ? 720 : 480;
      if (!directStreams[resKey]) {
        directStreams[resKey] = candidate;
      }
    }
  }

  const m3u8Regex = /(?:https?:)?\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]+)?/gi;
  let hMatch;
  while ((hMatch = m3u8Regex.exec(fullText)) !== null) {
    hlsStreams.push(resolveAbsoluteUrl(hMatch[0], baseUrl));
  }

  const directUrlRegex = /(?:https?:)?\/\/[^\s"'<>\\]+?(?:\.(?:mp4|webm|m4v)(?:\?[^\s"'<>\\]*)?|\/get_file\/[^\s"'<>\\]+)/gi;
  let uMatch;
  while ((uMatch = directUrlRegex.exec(fullText)) !== null) {
    const candidate = resolveAbsoluteUrl(uMatch[0].replace(/['",;)+]+$/, ''), baseUrl);
    if (!candidate || isPreviewOrJunkUrl(candidate)) continue;
    const resHit = candidate.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
    const resKey = resHit ? Number(resHit[1]) : !directStreams[720] ? 720 : 480;
    if (!directStreams[resKey]) {
      directStreams[resKey] = candidate;
    }
  }

  return { directStreams, hlsStreams };
}

function findChildMediaPages(html, baseUrl) {
  const candidates = [];

  try {
    const parsed = new URL(baseUrl);
    const idMatch = parsed.pathname.match(/\/(?:video|videos|watch|v|movie|clip|look)s?\/(\d{4,12})\b/i);
    if (idMatch?.[1]) {
      candidates.push(`${parsed.origin}/embed/${idMatch[1]}`);
    }
  } catch {}

  const metaRefresh = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'\s>]+)/i);
  if (metaRefresh?.[1]) {
    candidates.push(resolveAbsoluteUrl(metaRefresh[1], baseUrl));
  }

  const locRedirect = html.match(/(?:window\.)?location(?:\.href|\.replace)?\s*(?:=|\()\s*['"]([^'"]+)['"]/i);
  if (locRedirect?.[1] && !locRedirect[1].startsWith('#') && !locRedirect[1].startsWith('javascript:')) {
    candidates.push(resolveAbsoluteUrl(locRedirect[1], baseUrl));
  }

  const iframeRegex = /<(?:iframe|embed|frame)[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi;
  let iMatch;
  while ((iMatch = iframeRegex.exec(html)) !== null) {
    const src = iMatch[1];
    if (/ads|banner|doubleclick|exoclick|juicyads|traffic|chat|magsrv|realsrv|syndication|captcha|google|stripchat|chaturbate|bongacams|livejasmin/i.test(src)) {
      continue;
    }
    const abs = resolveAbsoluteUrl(src, baseUrl);
    if (abs && /^https?:\/\//i.test(abs)) {
      candidates.push(abs);
    }
  }

  return [...new Set(candidates)].slice(0, 5);
}

function findLocalBrowserExecutable() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        ];

  return candidates.find(p => p && fs.existsSync(p)) || null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function inspectViaHeadlessBrowser(targetUrl) {
  const browserBin = findLocalBrowserExecutable();
  if (!browserBin) return null;

  let proc = null;
  const profileDir = path.join(TEMP_DIR, `chrome_prof_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);

  try {
    const port = await getFreePort();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--headless=new',
      '--disable-gpu',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      `--user-agent=${BROWSER_UA}`,
      targetUrl
    ];

    proc = spawn(browserBin, args, { stdio: 'ignore' });

    let wsUrl = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise(r => setTimeout(r, 300));
      try {
        const listRes = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) });
        if (listRes.ok) {
          const targets = await listRes.json();
          const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
          if (pageTarget) {
            wsUrl = pageTarget.webSocketDebuggerUrl;
            break;
          }
        }
      } catch {}
    }

    if (!wsUrl || typeof WebSocket === 'undefined') {
      return null;
    }

    const capturedDirect = {};
    const capturedHls = new Set();
    let domResult = null;

    await new Promise(resolve => {
      const ws = new WebSocket(wsUrl);
      let msgId = 1;

      const sendCmd = (method, params = {}) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: msgId++, method, params }));
        }
      };

      const finish = () => {
        try { ws.close(); } catch {}
        resolve();
      };

      const timeout = setTimeout(finish, 7500);

      ws.addEventListener('open', () => {
        sendCmd('Network.enable');
        sendCmd('Page.enable');

        setTimeout(() => {
          const jsExpr = `(() => {
            try {
              document.querySelectorAll('.vjs-big-play-button, .fp-play, .kt-play, [class*="play"], [id*="play"], button').forEach(b => {
                const txt = (b.innerText || b.className || b.id || '').toLowerCase();
                if (/play|watch|enter|agree|18|yes|continue/.test(txt)) b.click();
              });
              document.querySelectorAll('video').forEach(v => {
                if (v.clientWidth >= 260 || !v.hasAttribute('data-preview')) {
                  try { v.play(); } catch {}
                }
              });
            } catch {}
            const vids = Array.from(document.querySelectorAll('video')).filter(v => {
              const rect = v.getBoundingClientRect();
              return (rect.width === 0 || rect.width >= 260) && !v.hasAttribute('data-preview');
            }).map(v => ({
              src: v.currentSrc || v.src || v.getAttribute('data-src') || '',
              label: v.getAttribute('label') || v.getAttribute('title') || ''
            })).filter(v => v.src);
            const iframes = Array.from(document.querySelectorAll('iframe')).map(f => f.src).filter(Boolean);
            return JSON.stringify({
              locationHref: window.location.href,
              title: document.title,
              cookie: document.cookie,
              html: document.documentElement.outerHTML.slice(0, 300000),
              vids,
              iframes
            });
          })()`;
          sendCmd('Runtime.evaluate', { expression: jsExpr, returnByValue: true });
        }, 3200);
      });

      ws.addEventListener('message', event => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.method === 'Network.responseReceived') {
            const resp = msg.params?.response || {};
            const respUrl = resp.url || '';
            const mime = (resp.mimeType || '').toLowerCase();
            const contentLen = Number(resp.headers?.['content-length'] || resp.headers?.['Content-Length'] || 0);

            if (/^https?:\/\//i.test(respUrl) && !isPreviewOrJunkUrl(respUrl)) {
              if (mime.includes('mpegurl') || /\.m3u8(\?|$)/i.test(respUrl)) {
                capturedHls.add(respUrl);
              } else if (mime.startsWith('video/') && !mime.includes('mp2t')) {
                if (contentLen === 0 || contentLen >= MIN_VALID_VIDEO_BYTES) {
                  const resHit = respUrl.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
                  const r = resHit ? Number(resHit[1]) : 720;
                  if (!capturedDirect[r]) capturedDirect[r] = respUrl;
                }
              }
            }
          }

          if (msg.result?.result?.value) {
            domResult = JSON.parse(msg.result.result.value);
            setTimeout(() => {
              clearTimeout(timeout);
              finish();
            }, 600);
          }
        } catch {}
      });

      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        finish();
      });
    });

    const directStreams = { ...capturedDirect };
    const hlsStreams = [...capturedHls];
    const finalUrl = domResult?.locationHref || targetUrl;

    if (domResult?.html) {
      extractStreamsFromHtml(domResult.html, finalUrl, directStreams, hlsStreams);
    }

    (domResult?.vids || []).forEach(v => {
      if (!v.src || v.src.startsWith('blob:')) return;
      const abs = resolveAbsoluteUrl(v.src, finalUrl);
      if (/\.m3u8(\?|$)/i.test(abs)) {
        hlsStreams.push(abs);
      } else if (/^https?:\/\//i.test(abs) && !isPreviewOrJunkUrl(abs)) {
        const resHit = (v.label || abs).match(/(2160|1440|1080|720|480|360|240|144)/);
        const r = resHit ? Number(resHit[1]) : 720;
        directStreams[r] = abs;
      }
    });

    return {
      title: domResult?.title || null,
      finalUrl,
      cookieHeader: domResult?.cookie || '',
      iframes: domResult?.iframes || [],
      directStreams,
      hlsStreams: [...new Set(hlsStreams)]
    };
  } catch {
    return null;
  } finally {
    if (proc) {
      try { proc.kill('SIGKILL'); } catch {}
    }
    setTimeout(() => {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
    }, 2000);
  }
}

async function verifyAndMeasureDirectStreams(directStreams, refererUrl, cookieHeader) {
  const verified = {};
  const entries = Object.entries(directStreams);

  await Promise.all(
    entries.map(async ([resKey, streamUrl]) => {
      if (isPreviewOrJunkUrl(streamUrl)) return;
      const numRes = Number(resKey) || 720;
      try {
        const probe = await fetch(streamUrl, {
          method: 'GET',
          headers: {
            'User-Agent': BROWSER_UA,
            'Referer': refererUrl,
            'Range': 'bytes=0-4095',
            ...(cookieHeader ? { Cookie: cookieHeader } : {})
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(4000)
        });

        if (!probe.ok) return;

        const contentType = (probe.headers.get('content-type') || '').toLowerCase();
        const contentRange = probe.headers.get('content-range') || '';
        const totalMatch = contentRange.match(/\/(\d+)/);
        const totalBytes = totalMatch
          ? Number(totalMatch[1])
          : Number(probe.headers.get('content-length') || 0);

        try { probe.body?.cancel?.(); } catch {}

        if (
          contentType.includes('text/html') ||
          contentType.includes('text/plain') ||
          contentType.includes('application/json') ||
          (totalBytes > 0 && totalBytes < MIN_VALID_VIDEO_BYTES)
        ) {
          return;
        }

        verified[numRes] = {
          url: streamUrl,
          filesize: totalBytes >= MIN_VALID_VIDEO_BYTES ? totalBytes : null
        };
      } catch {}
    })
  );

  return verified;
}

async function fetchPageHtml(targetUrl) {
  const parsed = new URL(targetUrl);
  let html = '';
  let cookieHeader = DEFAULT_AGE_COOKIES;
  let finalPageUrl = targetUrl;

  try {
    const pageRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': parsed.origin + '/',
        'Cookie': DEFAULT_AGE_COOKIES
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });

    if (pageRes.url) finalPageUrl = pageRes.url;

    const rawCookies = pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : [];
    if (rawCookies.length > 0) {
      cookieHeader = DEFAULT_AGE_COOKIES + '; ' + rawCookies.map(c => c.split(';')[0]).join('; ');
    } else {
      const singleCookie = pageRes.headers.get('set-cookie');
      if (singleCookie) {
        const parsedSingle = singleCookie
          .split(/,(?=\s*[a-zA-Z0-9_-]+=)/)
          .map(c => c.split(';')[0].trim())
          .join('; ');
        cookieHeader = DEFAULT_AGE_COOKIES + '; ' + parsedSingle;
      }
    }

    if (pageRes.ok) {
      html = await pageRes.text();
    }
  } catch {}

  return { html, cookieHeader, finalPageUrl };
}

// Tier 2: Inspect via yt-dlp --dump-single-json (without overriding YouTube's internal mobile User-Agent!)
async function inspectViaYtDlp(targetUrl) {
  const parsed = new URL(targetUrl);
  const cleanHost = parsed.hostname.replace(/^www\./, '').toUpperCase();
  const isYouTube = /youtube\.com|youtu\.be/i.test(parsed.hostname);

  const ytArgs = [
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--geo-bypass'
  ];

  // only pass custom desktop User-Agent & Cookie on non-YouTube sites so yt-dlp's native Android/iOS client works at full speed
  if (!isYouTube) {
    ytArgs.push(
      '--referer',
      parsed.origin + '/',
      '--user-agent',
      BROWSER_UA,
      '--add-header',
      `Cookie:${DEFAULT_AGE_COOKIES}`
    );
  }

  ytArgs.push(targetUrl);

  const rawJson = await runYtDlp(ytArgs, 25000);
  const info = JSON.parse(rawJson);

  const durationSec = Number(info.duration) || null;
  const resolutionMap = new Map();
  const audioBitratesSet = new Set();
  const streamsByRes = {};
  let bestAudioUrl = null;
  let bestAudioSize = null;
  let bestAudioUa = BROWSER_UA;
  let bestAudioScore = -1;

  (info.formats || []).forEach(f => {
    if (!f.url || !/^https?:\/\//i.test(f.url)) return;

    const formatUa =
      f.http_headers?.['User-Agent'] ||
      f.http_headers?.['user-agent'] ||
      BROWSER_UA;

    const hasVideo = Boolean(f.vcodec && f.vcodec !== 'none');
    const hasAudio = Boolean(f.acodec && f.acodec !== 'none');
    const isM3u8 = /\.m3u8(\?|$)/i.test(f.url) || String(f.protocol || '').includes('m3u8');

    if (hasAudio && !hasVideo) {
      if (f.abr) {
        const roundedAbr = f.abr >= 250 ? 320 : f.abr >= 150 ? 192 : 128;
        audioBitratesSet.add(roundedAbr);
      }
      if (!isM3u8) {
        const score = (f.abr || f.tbr || 128) + (/^mp4a|aac/i.test(f.acodec || '') ? 500 : 0);
        if (score > bestAudioScore) {
          bestAudioScore = score;
          bestAudioUrl = f.url;
          bestAudioSize = f.filesize || f.filesize_approx || null;
          bestAudioUa = formatUa;
        }
      }
    }

    if (hasVideo && (f.height || f.format_note || f.url)) {
      if (isPreviewOrJunkUrl(f.url) && !isM3u8) return;

      const noteMatch = String(f.format_note || f.format_id || '').match(/(\d{3,4})p?/);
      const rawDim = f.height
        ? (f.width ? Math.min(f.width, f.height) : f.height)
        : noteMatch
        ? Number(noteMatch[1])
        : 720;

      const res = snapToStandardResolution(rawDim) || 720;
      const sizeBytes =
        f.filesize ||
        f.filesize_approx ||
        (f.tbr && durationSec ? Math.round(((f.tbr * 1000) / 8) * durationSec) : null);

      if (sizeBytes && sizeBytes > 0 && sizeBytes < MIN_VALID_VIDEO_BYTES) return;

      const isH264 = /^avc1|h264/i.test(f.vcodec || '');
      const existing = resolutionMap.get(res);

      if (!existing || (isH264 && !existing.isH264) || (sizeBytes && !existing.sizeBytes)) {
        resolutionMap.set(res, {
          resolution: res,
          ext: 'mp4',
          isH264,
          codec: 'Video (H.264 + AAC)',
          sizeBytes,
          sizeText: formatBytes(sizeBytes)
        });
      }

      if (!streamsByRes[res]) {
        streamsByRes[res] = {
          progressiveUrl: null,
          progressiveSize: null,
          videoUrl: null,
          videoSize: null,
          userAgent: formatUa,
          hlsUrl: null
        };
      }

      if (isM3u8) {
        if (!streamsByRes[res].hlsUrl) {
          streamsByRes[res].hlsUrl = f.url;
          streamsByRes[res].userAgent = formatUa;
        }
      } else if (hasAudio) {
        if (!streamsByRes[res].progressiveUrl || isH264) {
          streamsByRes[res].progressiveUrl = f.url;
          streamsByRes[res].progressiveSize = f.filesize || null;
          streamsByRes[res].userAgent = formatUa;
        }
      } else {
        if (!streamsByRes[res].videoUrl || isH264) {
          streamsByRes[res].videoUrl = f.url;
          streamsByRes[res].videoSize = f.filesize || null;
          streamsByRes[res].userAgent = formatUa;
        }
      }
    }
  });

  if (resolutionMap.size === 0 && info.url && !isPreviewOrJunkUrl(info.url)) {
    const sizeBytes = info.filesize || info.filesize_approx || null;
    if (!sizeBytes || sizeBytes >= MIN_VALID_VIDEO_BYTES) {
      const res = snapToStandardResolution(info.height) || 720;
      const topUa = info.http_headers?.['User-Agent'] || BROWSER_UA;
      resolutionMap.set(res, {
        resolution: res,
        ext: 'mp4',
        codec: 'Video (H.264 + AAC)',
        sizeText: formatBytes(sizeBytes)
      });
      const isM3u8 = /\.m3u8(\?|$)/i.test(info.url);
      streamsByRes[res] = {
        progressiveUrl: isM3u8 ? null : info.url,
        progressiveSize: info.filesize || null,
        videoUrl: isM3u8 ? null : info.url,
        videoSize: info.filesize || null,
        userAgent: topUa,
        hlsUrl: isM3u8 ? info.url : null
      };
    }
  }

  const videoFormats = Array.from(resolutionMap.values()).sort((a, b) => b.resolution - a.resolution);
  if (videoFormats.length === 0) return null;

  if (!bestAudioUrl) {
    const firstProg = Object.values(streamsByRes).find(s => s.progressiveUrl || s.hlsUrl);
    bestAudioUrl = firstProg?.progressiveUrl || firstProg?.hlsUrl || null;
    bestAudioUa = firstProg?.userAgent || BROWSER_UA;
  }

  const sortedAudioRates =
    audioBitratesSet.size > 0
      ? Array.from(audioBitratesSet).sort((a, b) => b - a)
      : [320, 192, 128];

  const audioFormats = sortedAudioRates.map(rate => ({
    bitrate: rate,
    label: `${rate} kbps`,
    desc: rate >= 256 ? 'MP3 High Bitrate Audio' : rate >= 160 ? 'MP3 Standard Stereo Audio' : 'MP3 Compact Audio'
  }));

  const rawExtractor = info.extractor_key || info.extractor || '';
  const friendlyExtractor =
    !rawExtractor || /html5|generic/i.test(rawExtractor) ? cleanHost : rawExtractor;

  return {
    title: decodeHtmlEntities(String(info.title || humanizeUrlSlug(targetUrl)).replace(/\s*\(\d+\)\s*$/, '').trim()),
    extractor: friendlyExtractor,
    uploader: info.uploader || info.channel || null,
    duration: formatDuration(durationSec) || 'HD Video',
    thumbnail: info.thumbnail || '',
    resolutions: videoFormats.map(v => v.resolution),
    videoFormats,
    audioFormats,
    streamsByRes,
    bestAudioUrl,
    bestAudioSize,
    bestAudioUa,
    finalPageUrl: info.webpage_url || targetUrl,
    cookieHeader: DEFAULT_AGE_COOKIES
  };
}

// Tier 3: Deep HTML + KVS + /embed/<id> + Child Iframe + Headless Chrome Inspector
async function scrapePageDeep(targetUrl) {
  const parsed = new URL(targetUrl);
  const hostLabel = parsed.hostname.replace(/^www\./, '').toUpperCase();

  let { html, cookieHeader, finalPageUrl } = await fetchPageHtml(targetUrl);

  const getMeta = prop => {
    const r1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
    const r2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
    return (html.match(r1)?.[1] || html.match(r2)?.[1] || '').trim();
  };

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const kvsTitleMatch = html.match(/video_title\s*:\s*['"]([^'"]+)['"]/i);
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);

  let rawTitle = decodeHtmlEntities(
    getMeta('og:title') ||
      getMeta('twitter:title') ||
      (kvsTitleMatch ? kvsTitleMatch[1] : '') ||
      (h1Match ? h1Match[1] : '') ||
      (titleMatch ? titleMatch[1] : '') ||
      humanizeUrlSlug(finalPageUrl)
  ).replace(/\s*\(\d+\)\s*$/, '').trim();

  const durMeta =
    getMeta('video:duration') ||
    getMeta('og:video:duration') ||
    html.match(/"duration"\s*:\s*"?PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"?/i);

  let durationSec = null;
  if (typeof durMeta === 'string' && /^\d+$/.test(durMeta)) {
    durationSec = Number(durMeta);
  } else if (Array.isArray(durMeta)) {
    durationSec =
      Number(durMeta[1] || 0) * 3600 +
      Number(durMeta[2] || 0) * 60 +
      Number(durMeta[3] || 0);
  }

  const kvsThumbMatch = html.match(/preview_url\s*:\s*['"]([^'"]+)['"]/i);
  const posterMatch = html.match(/poster=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i);

  const rawThumb =
    getMeta('og:image') ||
    getMeta('twitter:image') ||
    (kvsThumbMatch ? kvsThumbMatch[1].replace(/\\\//g, '/') : '') ||
    (posterMatch ? posterMatch[1] : '');

  const thumbnail = resolveAbsoluteUrl(rawThumb, finalPageUrl);
  const directStreams = {};
  const hlsStreams = [];

  if (html) {
    extractStreamsFromHtml(html, finalPageUrl, directStreams, hlsStreams);
  }

  let verifiedDirectMap = await verifyAndMeasureDirectStreams(directStreams, finalPageUrl, cookieHeader);

  const childPages = html ? findChildMediaPages(html, finalPageUrl) : [];
  if (Object.keys(verifiedDirectMap).length === 0 && hlsStreams.length === 0 && childPages.length > 0) {
    for (const childUrl of childPages) {
      try {
        const childFetched = await fetchPageHtml(childUrl);
        if (childFetched.html) {
          const childDirect = {};
          extractStreamsFromHtml(
            childFetched.html,
            childFetched.finalPageUrl || childUrl,
            childDirect,
            hlsStreams
          );
          const childVerified = await verifyAndMeasureDirectStreams(
            childDirect,
            childFetched.finalPageUrl || childUrl,
            cookieHeader
          );
          Object.assign(verifiedDirectMap, childVerified);
          if (Object.keys(verifiedDirectMap).length > 0 || hlsStreams.length > 0) break;
        }
      } catch {}
    }
  }

  if (Object.keys(verifiedDirectMap).length === 0 && hlsStreams.length === 0) {
    const headlessData = await inspectViaHeadlessBrowser(targetUrl);
    if (headlessData) {
      if (headlessData.title && (!rawTitle || rawTitle.startsWith('Video on'))) {
        rawTitle = decodeHtmlEntities(headlessData.title);
      }
      if (headlessData.cookieHeader) {
        cookieHeader += '; ' + headlessData.cookieHeader;
      }
      if (headlessData.finalUrl) {
        finalPageUrl = headlessData.finalUrl;
      }
      (headlessData.iframes || []).forEach(iframeUrl => {
        if (!childPages.includes(iframeUrl)) childPages.push(iframeUrl);
      });
      const headlessVerified = await verifyAndMeasureDirectStreams(
        headlessData.directStreams || {},
        finalPageUrl,
        cookieHeader
      );
      Object.assign(verifiedDirectMap, headlessVerified);
      (headlessData.hlsStreams || []).forEach(u => hlsStreams.push(u));
    }
  }

  if (Object.keys(verifiedDirectMap).length === 0 && hlsStreams.length === 0 && childPages.length > 0) {
    for (const childUrl of childPages.slice(0, 3)) {
      try {
        const ytChild = await inspectViaYtDlp(childUrl);
        if (ytChild && ytChild.videoFormats?.length > 0) {
          return {
            ...ytChild,
            title: rawTitle && !rawTitle.startsWith('Video on') ? rawTitle : ytChild.title,
            thumbnail: thumbnail || ytChild.thumbnail
          };
        }
      } catch {}
    }
  }

  const uniqueHls = [...new Set(hlsStreams)];
  const hlsVariantsByRes = {};
  for (const m3u8Url of uniqueHls.slice(0, 3)) {
    const parsedVariants = await parseHlsMasterManifest(m3u8Url, finalPageUrl, cookieHeader);
    Object.entries(parsedVariants).forEach(([resKey, info]) => {
      if (!hlsVariantsByRes[resKey]) {
        hlsVariantsByRes[resKey] = info;
      }
    });
  }

  if (uniqueHls.length > 0 && Object.keys(hlsVariantsByRes).length === 0 && Object.keys(verifiedDirectMap).length === 0) {
    hlsVariantsByRes[720] = { url: uniqueHls[0], bandwidth: null };
  }

  const allRealResolutions = [
    ...new Set([
      ...Object.keys(verifiedDirectMap).map(Number),
      ...Object.keys(hlsVariantsByRes).map(Number)
    ])
  ]
    .filter(Boolean)
    .sort((a, b) => b - a);

  const videoFormats = allRealResolutions.map(res => {
    const directInfo = verifiedDirectMap[res];
    const hlsInfo = hlsVariantsByRes[res];
    const estBytes =
      directInfo?.filesize ||
      (hlsInfo?.bandwidth && durationSec ? Math.round((hlsInfo.bandwidth / 8) * durationSec) : null);

    return {
      resolution: res,
      ext: 'mp4',
      codec: 'Video (H.264 + AAC)',
      sizeText: formatBytes(estBytes)
    };
  });

  const audioFormats =
    videoFormats.length > 0
      ? [
          { bitrate: 320, label: '320 kbps', desc: 'MP3 High Bitrate Audio' },
          { bitrate: 192, label: '192 kbps', desc: 'MP3 Standard Stereo Audio' },
          { bitrate: 128, label: '128 kbps', desc: 'MP3 Compact Audio' }
        ]
      : [];

  const streamsByRes = buildStreamsByRes(verifiedDirectMap, hlsVariantsByRes, uniqueHls);
  const firstStream = Object.values(streamsByRes)[0];

  return {
    title: rawTitle || humanizeUrlSlug(finalPageUrl),
    extractor: decodeHtmlEntities(getMeta('og:site_name')) || hostLabel,
    duration: formatDuration(durationSec) || 'HD Video',
    thumbnail,
    resolutions: allRealResolutions,
    videoFormats,
    audioFormats,
    streamsByRes,
    bestAudioUrl: firstStream?.progressiveUrl || firstStream?.hlsUrl || null,
    bestAudioSize: null,
    bestAudioUa: BROWSER_UA,
    verifiedDirectMap,
    hlsVariantsByRes,
    hlsStreams: uniqueHls,
    childPages,
    finalPageUrl,
    cookieHeader
  };
}

module.exports = {
  initLocalBinaries,
  ensureYtDlpBinary,
  getLocalFfmpegPath,
  runYtDlp,
  parseHlsMasterManifest,
  resolveViaPublicPlatformApis,
  inspectViaYtDlp,
  scrapePageDeep
};