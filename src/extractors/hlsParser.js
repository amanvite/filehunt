const { BROWSER_UA } = require('../config/constants');
const { snapToStandardResolution, resolveAbsoluteUrl } = require('../utils/mediaFormatters');

// parse an HLS (.m3u8) master playlist to discover the exact resolutions inside the stream
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

// pure-Node HLS segment downloader & pipe for serverless environments
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
  res.setHeader('Content-Type', 'video/mp4');

  for (const segUrl of segmentUrls.slice(0, 120)) {
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

module.exports = {
  parseHlsMasterManifest,
  streamHlsSegmentsToResponse
};