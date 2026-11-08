const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const {
  IS_VERCEL,
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

const BINARY_FILENAME =
  process.platform === 'win32'
    ? 'yt-dlp.exe'
    : process.arch === 'arm64'
    ? 'yt-dlp_linux_aarch64'
    : 'yt-dlp_linux';

const LOCAL_YTDLP_BIN = path.join(TEMP_DIR, BINARY_FILENAME);

let resolvedYtDlpCmd = null;
let ytdlpDownloadPromise = null;
let resolvedFfmpegPath = null;

function getLocalFfmpegPath() {
  if (IS_VERCEL) return null;
  if (resolvedFfmpegPath) return resolvedFfmpegPath;

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

  if (!IS_VERCEL) {
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
  }

  if (!ytdlpDownloadPromise) {
    ytdlpDownloadPromise = (async () => {
      const releaseUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${BINARY_FILENAME}`;
      const res = await fetch(releaseUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(LOCAL_YTDLP_BIN, buffer);
      if (process.platform !== 'win32') {
        fs.chmodSync(LOCAL_YTDLP_BIN, 0o755);
      }
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
  if (!IS_VERCEL) {
    getLocalFfmpegPath();
    ensureYtDlpBinary();
  }
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
    /\.m3u8|_preview\.|-preview\.|\/previews\/|\/thumbs\/|\/t\/|sprite|banner|logo|_TPL_/i.test(
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

async function streamHlsSegmentsToResponse(variantM3u8Url, refererUrl, cookieHeader, res, filename) {
  const plRes = await fetch(variantM3u8Url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Referer': refererUrl,
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(6000)
  });

  if (!plRes.ok) throw new Error('Failed to fetch HLS media playlist');
  const plText = await plRes.text();
  const baseUrl = plRes.url || variantM3u8Url;

  const segmentUrls = plText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(seg => resolveAbsoluteUrl(seg, baseUrl))
    .filter(Boolean);

  if (segmentUrls.length === 0) {
    throw new Error('No media segments found in HLS playlist');
  }

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');

  for (const segUrl of segmentUrls.slice(0, 140)) {
    if (res.writableEnded || res.destroyed) break;
    const segRes = await fetch(segUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': refererUrl,
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
      },
      signal: AbortSignal.timeout(10000)
    });
    if (segRes.ok) {
      const buf = Buffer.from(await segRes.arrayBuffer());
      res.write(buf);
    }
  }

  res.end();
}

// Multi-tier YouTube resolver that works on Vercel datacenter IPs (Embed VisitorData + InnerTube + Piped/Invidious fallback)
async function resolveYouTubeMultiEngine(videoId, targetUrl) {
  // Step 1: Fetch embed page to harvest a valid visitorData token & encrypted sts signature timestamp
  let visitorData = '';
  let sts = null;
  try {
    const embedRes = await fetch(`https://www.youtube.com/embed/${videoId}`, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(4000)
    });
    if (embedRes.ok) {
      const embedHtml = await embedRes.text();
      const vdMatch = embedHtml.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/i);
      const stsMatch = embedHtml.match(/"sts"\s*:\s*(\d+)/i);
      if (vdMatch?.[1]) visitorData = vdMatch[1];
      if (stsMatch?.[1]) sts = Number(stsMatch[1]);
    }
  } catch {}

  const clients = [
    {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      userAgent: 'Mozilla/5.0 (PlayStation; PlayStation 4/11.50) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15',
      isEmbedded: true
    },
    {
      clientName: 'IOS',
      clientVersion: '19.45.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.1.0.22B83',
      userAgent: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1 like Mac OS X;)'
    },
    {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      androidSdkVersion: 34,
      userAgent: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 14; en_US; Quest 3; Build/UP1A.231005.007.A1; Cronet/119.0.6045.194)'
    },
    {
      clientName: 'ANDROID_TESTSUITE',
      clientVersion: '1.9',
      androidSdkVersion: 30,
      userAgent: 'com.google.android.youtube/1.9 (Linux; U; Android 11; en_US)'
    }
  ];

  for (const client of clients) {
    try {
      const bodyPayload = {
        videoId,
        racyCheckOk: true,
        contentCheckOk: true,
        context: {
          client: {
            clientName: client.clientName,
            clientVersion: client.clientVersion,
            hl: 'en',
            gl: 'US',
            ...(visitorData ? { visitorData } : {}),
            ...(client.androidSdkVersion ? { androidSdkVersion: client.androidSdkVersion } : {}),
            ...(client.deviceMake
              ? {
                  deviceMake: client.deviceMake,
                  deviceModel: client.deviceModel,
                  osName: client.osName,
                  osVersion: client.osVersion
                }
              : {})
          },
          ...(client.isEmbedded
            ? {
                thirdParty: {
                  embedUrl: 'https://www.youtube.com/'
                }
              }
            : {})
        },
        ...(sts ? { playbackContext: { contentPlaybackContext: { signatureTimestamp: sts } } } : {})
      };

      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': client.userAgent,
          ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {})
        },
        body: JSON.stringify(bodyPayload),
        signal: AbortSignal.timeout(5000)
      });

      if (!res.ok) continue;
      const data = await res.json();
      const details = data?.videoDetails;
      const streamingData = data?.streamingData;
      if (!details || !streamingData) continue;

      const durationSec = Number(details.lengthSeconds) || null;
      const allFormats = [
        ...(streamingData.formats || []),
        ...(streamingData.adaptiveFormats || [])
      ];

      const resolutionMap = new Map();
      const verifiedDirectMap = {};

      allFormats.forEach(f => {
        if (f.mimeType && f.mimeType.startsWith('video/') && f.url) {
          const rawHeight = f.height || parseInt(String(f.qualityLabel || ''), 10);
          const normRes = snapToStandardResolution(rawHeight);
          if (!normRes) return;

          const sizeBytes =
            Number(f.contentLength) ||
            (f.bitrate && durationSec ? Math.round((f.bitrate / 8) * durationSec) : null);
          const hasAudio = Boolean(f.audioQuality);

          const existing = resolutionMap.get(normRes);
          if (!existing || (hasAudio && !existing.hasAudio) || (sizeBytes && !existing.sizeBytes)) {
            resolutionMap.set(normRes, {
              resolution: normRes,
              ext: 'mp4',
              hasAudio,
              codec: 'Video (H.264 + AAC)',
              sizeBytes,
              sizeText: formatBytes(sizeBytes)
            });
          }

          if (hasAudio || !verifiedDirectMap[normRes]) {
            verifiedDirectMap[normRes] = {
              url: f.url,
              filesize: sizeBytes
            };
          }
        }
      });

      const videoFormats = Array.from(resolutionMap.values()).sort((a, b) => b.resolution - a.resolution);
      if (videoFormats.length === 0) continue;

      return {
        title: details.title || 'YouTube Video',
        extractor: 'YouTube',
        uploader: details.author || 'YouTube',
        duration: formatDuration(durationSec) || 'Video',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        resolutions: videoFormats.map(v => v.resolution),
        videoFormats,
        audioFormats: [
          { bitrate: 320, label: '320 kbps', desc: 'MP3 High Bitrate Audio' },
          { bitrate: 192, label: '192 kbps', desc: 'MP3 Standard Stereo Audio' },
          { bitrate: 128, label: '128 kbps', desc: 'MP3 Compact Audio' }
        ],
        verifiedDirectMap,
        hlsVariantsByRes: {},
        hlsStreams: streamingData.hlsManifestUrl ? [streamingData.hlsManifestUrl] : [],
        childPages: [],
        finalPageUrl: targetUrl,
        cookieHeader: DEFAULT_AGE_COOKIES
      };
    } catch {}
  }

  // Step 2: Public Piped / Invidious API fallback if YouTube blocked the Vercel AWS IP
  const pipedInstances = [
    `https://pipedapi.kavin.rocks/streams/${videoId}`,
    `https://pipedapi.tokhmi.xyz/streams/${videoId}`,
    `https://pipedapi.moomoo.me/streams/${videoId}`,
    `https://inv.tux.pizza/api/v1/videos/${videoId}`,
    `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`
  ];

  for (const apiEndpoint of pipedInstances) {
    try {
      const pRes = await fetch(apiEndpoint, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(4500)
      });
      if (!pRes.ok) continue;
      const pData = await pRes.json();

      const durationSec = Number(pData.duration || pData.lengthSeconds) || null;
      const resolutionMap = new Map();
      const verifiedDirectMap = {};

      // Piped format
      const streamsList = pData.videoStreams || pData.formatStreams || [];
      streamsList.forEach(s => {
        if (!s?.url) return;
        const rawRes = parseInt(String(s.quality || s.resolution || ''), 10);
        const normRes = snapToStandardResolution(rawRes);
        if (!normRes) return;
        const hasAudio = s.videoOnly === false || Boolean(s.audioQuality) || Array.isArray(pData.formatStreams);
        const existing = resolutionMap.get(normRes);
        if (!existing || (hasAudio && !existing.hasAudio)) {
          resolutionMap.set(normRes, {
            resolution: normRes,
            ext: 'mp4',
            hasAudio,
            codec: 'Video (H.264 + AAC)',
            sizeText: null
          });
          verifiedDirectMap[normRes] = { url: s.url, filesize: null };
        }
      });

      const videoFormats = Array.from(resolutionMap.values()).sort((a, b) => b.resolution - a.resolution);
      if (videoFormats.length > 0) {
        return {
          title: pData.title || 'YouTube Video',
          extractor: 'YouTube',
          uploader: pData.uploader || pData.author || 'YouTube',
          duration: formatDuration(durationSec) || 'Video',
          thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
          resolutions: videoFormats.map(v => v.resolution),
          videoFormats,
          audioFormats: [
            { bitrate: 320, label: '320 kbps', desc: 'MP3 High Bitrate Audio' },
            { bitrate: 192, label: '192 kbps', desc: 'MP3 Standard Stereo Audio' },
            { bitrate: 128, label: '128 kbps', desc: 'MP3 Compact Audio' }
          ],
          verifiedDirectMap,
          hlsVariantsByRes: {},
          hlsStreams: pData.hls ? [pData.hls] : [],
          childPages: [],
          finalPageUrl: targetUrl,
          cookieHeader: DEFAULT_AGE_COOKIES
        };
      }
    } catch {}
  }

  return null;
}

async function resolveViaPublicPlatformApis(targetUrl) {
  const ytMatch =
    targetUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
    targetUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
    targetUrl.match(/youtube\.com\/(?:shorts|embed)\/([a-zA-Z0-9_-]{11})/);

  if (ytMatch) {
    const ytData = await resolveYouTubeMultiEngine(ytMatch[1], targetUrl);
    if (ytData) return ytData;
  }

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

        const thumbs = meta.posters || {};
        const bestThumb = thumbs['1080'] || thumbs['720'] || thumbs['480'] || thumbs['360'] || '';

        let videoFormats = Array.from(resolutionMap.values()).sort((a, b) => b.resolution - a.resolution);
        if (videoFormats.length === 0 && hlsStreams.length > 0) {
          videoFormats = [1080, 720, 480, 360].map(r => ({
            resolution: r,
            ext: 'mp4',
            codec: 'Video (H.264 + AAC)',
            sizeText: null
          }));
        }

        if (videoFormats.length > 0) {
          return {
            title: meta.title || `Dailymotion Video (${videoId})`,
            extractor: 'Dailymotion',
            uploader: meta.owner?.username || 'Dailymotion',
            duration: formatDuration(durationSec) || 'Video',
            thumbnail: bestThumb,
            resolutions: videoFormats.map(v => v.resolution),
            videoFormats,
            audioFormats: [
              { bitrate: 320, label: '320 kbps', desc: 'MP3 High Bitrate Audio' },
              { bitrate: 192, label: '192 kbps', desc: 'MP3 Standard Stereo Audio' },
              { bitrate: 128, label: '128 kbps', desc: 'MP3 Compact Audio' }
            ],
            verifiedDirectMap,
            hlsVariantsByRes: {},
            hlsStreams,
            childPages: [],
            finalPageUrl: targetUrl,
            cookieHeader: DEFAULT_AGE_COOKIES
          };
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
      else if (!directStreams[720]) directStreams[720] = mUrl;
    }
  }

  const preloadVideoRegex = /<link[^>]+as=["']video["'][^>]+href=["']([^"']+)["']/gi;
  let plMatch;
  while ((plMatch = preloadVideoRegex.exec(fullText)) !== null) {
    const pUrl = resolveAbsoluteUrl(plMatch[1].trim(), baseUrl);
    if (pUrl && /^https?:\/\//i.test(pUrl)) {
      if (/\.m3u8(\?|$)/i.test(pUrl)) hlsStreams.push(pUrl);
      else if (!directStreams[720]) directStreams[720] = pUrl;
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
    const idMatch = parsed.pathname.match(/\/(?:video|videos|watch|v|movie|clip)s?\/(\d{4,12})\b/i);
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
          signal: AbortSignal.timeout(3500)
        });

        if (!probe.ok) {
          verified[numRes] = {
            url: streamUrl,
            filesize: null
          };
          return;
        }

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
      } catch {
        verified[numRes] = {
          url: streamUrl,
          filesize: null
        };
      }
    })
  );

  return verified;
}

async function fetchHtmlWithFallback(targetUrl) {
  const parsed = new URL(targetUrl);
  let html = '';
  let cookieHeader = DEFAULT_AGE_COOKIES;
  let finalPageUrl = targetUrl;

  const hasMediaSignatures = (txt) =>
    Boolean(txt && txt.length > 800 && /<video|<source|video_url|xplayerSettings|window\.initials|setVideoUrl|mediaDefinitions|m3u8|\.mp4|<iframe/i.test(txt));

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
      signal: AbortSignal.timeout(6500)
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

  if (!hasMediaSignatures(html)) {
    const proxyUrls = [
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
      `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`
    ];

    try {
      const relayHtml = await Promise.any(
        proxyUrls.map(async (pUrl) => {
          const r = await fetch(pUrl, {
            headers: { 'User-Agent': BROWSER_UA },
            signal: AbortSignal.timeout(6000)
          });
          if (!r.ok) throw new Error('Relay status ' + r.status);
          const text = await r.text();
          if (!text || text.length < 600) throw new Error('Empty relay response');
          return text;
        })
      );
      if (relayHtml) {
        html = relayHtml;
      }
    } catch {}
  }

  return { html, cookieHeader, finalPageUrl };
}

async function inspectViaYtDlp(targetUrl) {
  const parsed = new URL(targetUrl);
  const cleanHost = parsed.hostname.replace(/^www\./, '').toUpperCase();

  const rawJson = await runYtDlp(
    [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--geo-bypass',
      '--extractor-args',
      'youtube:player_client=tv_embedded,ios,web_embedded',
      '--referer',
      parsed.origin + '/',
      '--user-agent',
      BROWSER_UA,
      '--add-header',
      `Cookie:${DEFAULT_AGE_COOKIES}`,
      targetUrl
    ],
    20000
  );

  const info = JSON.parse(rawJson);
  const durationSec = Number(info.duration) || null;
  const resolutionMap = new Map();
  const audioBitratesSet = new Set();
  const directStreams = {};
  const hlsStreams = [];

  (info.formats || []).forEach(f => {
    if (f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')) {
      if (f.abr) {
        const roundedAbr = f.abr >= 250 ? 320 : f.abr >= 150 ? 192 : 128;
        audioBitratesSet.add(roundedAbr);
      }
    }

    if (f.vcodec && f.vcodec !== 'none' && (f.height || f.format_note || f.url)) {
      if (f.url && isPreviewOrJunkUrl(f.url) && !/\.m3u8/i.test(f.url)) return;

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

      if (f.url && /^https?:\/\//i.test(f.url)) {
        if (/\.m3u8(\?|$)/i.test(f.url) || f.protocol?.includes('m3u8')) {
          hlsStreams.push(f.url);
        } else {
          directStreams[res] = { url: f.url, filesize: sizeBytes };
        }
      }
    }
  });

  if (resolutionMap.size === 0 && info.url && !isPreviewOrJunkUrl(info.url)) {
    const sizeBytes = info.filesize || info.filesize_approx || null;
    if (!sizeBytes || sizeBytes >= MIN_VALID_VIDEO_BYTES) {
      const res = snapToStandardResolution(info.height) || 720;
      resolutionMap.set(res, {
        resolution: res,
        ext: 'mp4',
        codec: 'Video (H.264 + AAC)',
        sizeText: formatBytes(sizeBytes)
      });
      if (/\.m3u8(\?|$)/i.test(info.url)) {
        hlsStreams.push(info.url);
      } else {
        directStreams[res] = { url: info.url, filesize: sizeBytes };
      }
    }
  }

  const videoFormats = Array.from(resolutionMap.values()).sort((a, b) => b.resolution - a.resolution);
  if (videoFormats.length === 0) return null;

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
    title: String(info.title || humanizeUrlSlug(targetUrl)).replace(/\s*\(\d+\)\s*$/, '').trim(),
    extractor: friendlyExtractor,
    uploader: info.uploader || info.channel || null,
    duration: formatDuration(durationSec) || 'HD Video',
    thumbnail: info.thumbnail || '',
    resolutions: videoFormats.map(v => v.resolution),
    videoFormats,
    audioFormats,
    verifiedDirectMap: directStreams,
    hlsVariantsByRes: {},
    hlsStreams,
    childPages: [],
    finalPageUrl: info.webpage_url || targetUrl,
    cookieHeader: DEFAULT_AGE_COOKIES
  };
}

async function scrapePageDeep(targetUrl, providedHtml = '') {
  const parsed = new URL(targetUrl);
  const hostLabel = parsed.hostname.replace(/^www\./, '').toUpperCase();

  let html = providedHtml || '';
  let cookieHeader = DEFAULT_AGE_COOKIES;
  let finalPageUrl = targetUrl;

  if (!html) {
    const fetched = await fetchHtmlWithFallback(targetUrl);
    html = fetched.html;
    cookieHeader = fetched.cookieHeader;
    finalPageUrl = fetched.finalPageUrl;
  }

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
        const childFetched = await fetchHtmlWithFallback(childUrl);
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

  return {
    title: rawTitle || humanizeUrlSlug(finalPageUrl),
    extractor: decodeHtmlEntities(getMeta('og:site_name')) || hostLabel,
    duration: formatDuration(durationSec) || 'HD Video',
    thumbnail,
    resolutions: allRealResolutions,
    videoFormats,
    audioFormats,
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
  getLocalFfmpegPath,
  runYtDlp,
  parseHlsMasterManifest,
  streamHlsSegmentsToResponse,
  resolveViaPublicPlatformApis,
  inspectViaYtDlp,
  scrapePageDeep
};