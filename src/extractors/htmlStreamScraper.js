const { BROWSER_UA, DEFAULT_AGE_COOKIES } = require('../config/constants');
const {
  snapToStandardResolution,
  formatBytes,
  formatDuration,
  decodeHtmlEntities,
  humanizeUrlSlug,
  resolveAbsoluteUrl
} = require('../utils/mediaFormatters');
const {
  unpackDeanEdwards,
  decodeInlineBase64Urls,
  decodeKvsUrl
} = require('./ciphers');
const { parseHlsMasterManifest } = require('./hlsParser');

function extractStreamsFromHtml(rawHtml, baseUrl, directStreams = {}, hlsStreams = []) {
  const unpacked = unpackDeanEdwards(rawHtml);
  const b64Decoded = decodeInlineBase64Urls(rawHtml + '\n' + unpacked);
  const combined = rawHtml + '\n' + unpacked + '\n' + b64Decoded;

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

  // 0. OpenGraph & Twitter stream meta tags + <link rel="preload" as="video">
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

  // 1. XVideos / XNXX html5player signatures
  const xvHigh = fullText.match(/setVideoUrlHigh\(\s*['"]([^'"]+)['"]\s*\)/i);
  const xvLow = fullText.match(/setVideoUrlLow\(\s*['"]([^'"]+)['"]\s*\)/i);
  const xvHls = fullText.match(/setVideoHLS\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (xvHigh?.[1]) directStreams[720] = resolveAbsoluteUrl(xvHigh[1], baseUrl);
  if (xvLow?.[1]) directStreams[360] = resolveAbsoluteUrl(xvLow[1], baseUrl);
  if (xvHls?.[1]) hlsStreams.push(resolveAbsoluteUrl(xvHls[1], baseUrl));

  // 2. Pornhub / RedTube / YouPorn / Tube8 mediaDefinitions
  const mediaDefRegex = /"videoUrl"\s*:\s*"([^"]+)"\s*,\s*"quality"\s*:\s*"?(\d{3,4})"?/gi;
  let mdMatch;
  while ((mdMatch = mediaDefRegex.exec(fullText)) !== null) {
    const vUrl = mdMatch[1];
    const q = snapToStandardResolution(mdMatch[2]);
    if (vUrl && q && /^https?:\/\//i.test(vUrl)) {
      if (/\.m3u8/i.test(vUrl)) hlsStreams.push(vUrl);
      else directStreams[q] = vUrl;
    }
  }

  // 3. SpankBang stream_data
  ['2160p', '1440p', '1080p', '720p', '480p', '360p', '240p'].forEach(qKey => {
    const sbMatch = fullText.match(new RegExp(`['"]?${qKey}['"]?\\s*:\\s*\\[\\s*['"](https?:\\/\\/[^'"]+)['"]`, 'i'));
    if (sbMatch?.[1]) {
      const h = parseInt(qKey, 10);
      if (/\.m3u8/i.test(sbMatch[1])) hlsStreams.push(sbMatch[1]);
      else directStreams[h] = sbMatch[1];
    }
  });

  // 4. xHamster & mirror domains (xhaccess.com, xhamster46.desi, etc.) window.initials & xplayerSettings
  const initialsMatch = fullText.match(/window\.initials\s*=\s*(\{[\s\S]*?\});\s*<\/script>/i);
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

  // 5. KVS (kt_player) flashvars
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
      if (absUrl && /^https?:\/\//i.test(absUrl)) {
        const textMatch = fullText.match(new RegExp(`${textKey}\\s*:\\s*['"]([^'"]+)['"]`, 'i'));
        const resMatch =
          (textMatch && textMatch[1].match(/(2160|1440|1080|720|480|360|240)/)) ||
          absUrl.match(/[_/-](2160|1440|1080|720|480|360|240)p?\b/i);
        const res = resMatch ? Number(resMatch[1]) : defaultRes;
        directStreams[res] = absUrl;
      }
    }
  });

  // 6. HTML5MediaEmbed equivalent: capture ANY <video src="..."> and <source src="..."> regardless of file extension
  const html5VideoTagRegex = /<(?:video|source)[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi;
  let vMatch;
  while ((vMatch = html5VideoTagRegex.exec(fullText)) !== null) {
    const rawSrc = vMatch[1].trim();
    if (!rawSrc || rawSrc.startsWith('blob:') || rawSrc.startsWith('data:')) continue;
    const srcUrl = resolveAbsoluteUrl(rawSrc, baseUrl);
    if (!/^https?:\/\//i.test(srcUrl)) continue;
    if (/\.(jpg|jpeg|png|webp|gif|svg|css|js|vtt|srt)(\?|$)/i.test(srcUrl)) continue;

    if (/\.m3u8(\?|$)/i.test(srcUrl)) {
      hlsStreams.push(srcUrl);
      continue;
    }

    const labelMatch =
      vMatch[0].match(/(?:label|title|res|data-res|size)=["']?(2160|1440|1080|720|480|360|240|144)p?/i) ||
      srcUrl.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
    const res = labelMatch ? Number(labelMatch[1]) : !directStreams[720] ? 720 : 480;
    if (!directStreams[res]) {
      directStreams[res] = srcUrl;
    }
  }

  // 7. Generic JWPlayer / FluidPlayer / Plyr / VideoJS / JSON-LD contentUrl properties
  const playerPropRegex = /(?:__fileurl|file|src|video_url|mp4_url|stream_url|contentUrl|embedUrl|hq_video_file|normal_video_file)\s*[:=]\s*['"](https?:\/\/[^'"\s<>]+)['"]/gi;
  let pMatch;
  while ((pMatch = playerPropRegex.exec(fullText)) !== null) {
    const candidate = pMatch[1];
    if (/\.(jpg|jpeg|png|webp|gif|svg|css|js|vtt|srt|xml|html|php)(\?|$)/i.test(candidate)) continue;
    if (/preview|thumb|sprite|banner|logo|ads/i.test(candidate)) continue;

    if (/\.m3u8(\?|$)/i.test(candidate)) {
      hlsStreams.push(candidate);
    } else if (/\.(mp4|webm|m4v|mov)(\?|$)|\/get_file\/|\/stream\/|\/mp4\/|\/videos?\//i.test(candidate)) {
      const resHit = candidate.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
      const resKey = resHit ? Number(resHit[1]) : 720;
      if (!directStreams[resKey]) {
        directStreams[resKey] = candidate;
      }
    }
  }

  // 8. Scan for any remaining .m3u8 manifests or direct .mp4 / get_file URLs
  const m3u8Regex = /https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]+)?/gi;
  let hMatch;
  while ((hMatch = m3u8Regex.exec(fullText)) !== null) {
    hlsStreams.push(hMatch[0]);
  }

  const directUrlRegex = /https?:\/\/[^\s"'<>\\]+?(?:\.(?:mp4|webm|m4v)(?:\?[^\s"'<>\\]*)?|\/get_file\/\d+\/[0-9a-f]{32}\/[^\s"'<>\\]+)/gi;
  let uMatch;
  while ((uMatch = directUrlRegex.exec(fullText)) !== null) {
    const candidate = uMatch[0].replace(/['",;)+]+$/, '');
    if (/\.m3u8|preview|thumb|sprite|banner|logo|trailer|_TPL_/i.test(candidate)) continue;
    const resHit = candidate.match(/[_/-](2160|1440|1080|720|480|360|240|144)p?\b/i);
    const resKey = resHit ? Number(resHit[1]) : 720;
    if (!directStreams[resKey]) {
      directStreams[resKey] = candidate;
    }
  }

  return { directStreams, hlsStreams };
}

function findChildMediaPages(html, baseUrl) {
  const candidates = [];

  const metaRefresh = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'\s>]+)/i);
  if (metaRefresh?.[1]) {
    candidates.push(resolveAbsoluteUrl(metaRefresh[1], baseUrl));
  }

  const locRedirect = html.match(/window\.location(?:\.href|\.replace)?\s*(?:=|\()\s*['"](https?:\/\/[^'"]+)['"]/i);
  if (locRedirect?.[1]) {
    candidates.push(locRedirect[1]);
  }

  const iframeRegex = /<(?:iframe|embed|frame)[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi;
  let iMatch;
  while ((iMatch = iframeRegex.exec(html)) !== null) {
    const src = iMatch[1];
    if (/ads|banner|doubleclick|exoclick|juicyads|traffic|chat|magsrv|realsrv|syndication|captcha/i.test(src)) {
      continue;
    }
    const abs = resolveAbsoluteUrl(src, baseUrl);
    if (abs && /^https?:\/\//i.test(abs)) {
      candidates.push(abs);
    }
  }

  return [...new Set(candidates)].slice(0, 4);
}

// non-destructive stream probe: measures file size if CDN permits, but NEVER deletes valid video streams on Vercel
async function verifyAndMeasureDirectStreams(directStreams, refererUrl, cookieHeader) {
  const verified = {};
  const entries = Object.entries(directStreams);

  await Promise.all(
    entries.map(async ([resKey, streamUrl]) => {
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

        const contentType = (probe.headers.get('content-type') || '').toLowerCase();
        const contentRange = probe.headers.get('content-range') || '';
        const totalMatch = contentRange.match(/\/(\d+)/);
        const totalBytes = totalMatch
          ? Number(totalMatch[1])
          : Number(probe.headers.get('content-length') || 0);

        try { probe.body?.cancel?.(); } catch {}

        // only reject if the server explicitly returned a tiny text/html error page
        if (contentType.includes('text/html') && totalBytes > 0 && totalBytes < 15000) {
          return;
        }

        verified[numRes] = {
          url: streamUrl,
          filesize: totalBytes > 40000 ? totalBytes : null
        };
      } catch {
        // keep the stream even if the CDN blocks datacenter Range requests on Vercel
        verified[numRes] = {
          url: streamUrl,
          filesize: null
        };
      }
    })
  );

  return verified;
}

// fetch page HTML with automatic proxy fallback if the target site blocks Vercel datacenter IPs
async function fetchHtmlWithFallback(targetUrl) {
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
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
        'Referer': parsed.origin + '/',
        'Cookie': DEFAULT_AGE_COOKIES
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(7000)
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

  // if direct fetch from Vercel was blocked by Cloudflare/403 or returned no media tags, try web proxy relays
  if (!html || (!/<video|<source|video_url|xplayerSettings|setVideoUrl|m3u8|\.mp4/i.test(html))) {
    const proxyRelays = [
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`
    ];

    for (const relayUrl of proxyRelays) {
      try {
        const relayRes = await fetch(relayUrl, {
          headers: { 'User-Agent': BROWSER_UA },
          signal: AbortSignal.timeout(6000)
        });
        if (relayRes.ok) {
          const relayText = await relayRes.text();
          if (relayText && relayText.length > 500) {
            html = relayText;
            if (/<video|<source|video_url|xplayerSettings|setVideoUrl|m3u8|\.mp4/i.test(html)) {
              break;
            }
          }
        }
      } catch {}
    }
  }

  return { html, cookieHeader, finalPageUrl };
}

async function scrapePageDeep(targetUrl) {
  const parsed = new URL(targetUrl);
  const hostLabel = parsed.hostname.replace(/^www\./, '').toUpperCase();

  const { html, cookieHeader, finalPageUrl } = await fetchHtmlWithFallback(targetUrl);

  const getMeta = prop => {
    const r1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
    const r2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
    return (html.match(r1)?.[1] || html.match(r2)?.[1] || '').trim();
  };

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const kvsTitleMatch = html.match(/video_title\s*:\s*['"]([^'"]+)['"]/i);
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);

  const rawTitle = decodeHtmlEntities(
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

  const childPages = html ? findChildMediaPages(html, finalPageUrl) : [];
  if (Object.keys(directStreams).length === 0 && hlsStreams.length === 0 && childPages.length > 0) {
    for (const childUrl of childPages) {
      try {
        const childFetched = await fetchHtmlWithFallback(childUrl);
        if (childFetched.html) {
          extractStreamsFromHtml(childFetched.html, childFetched.finalPageUrl || childUrl, directStreams, hlsStreams);
          if (Object.keys(directStreams).length > 0 || hlsStreams.length > 0) break;
        }
      } catch {}
    }
  }

  const verifiedDirectMap = await verifyAndMeasureDirectStreams(directStreams, finalPageUrl, cookieHeader);

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

  // if an HLS stream exists but manifest probing was blocked by CDN IP rules, expose 720p for the HLS stream
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
  scrapePageDeep
};