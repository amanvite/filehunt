const path = require('path');
const fs = require('fs');
const { IS_VERCEL, TEMP_DIR, BROWSER_UA, DEFAULT_AGE_COOKIES } = require('../config/constants');
const { LruCache } = require('../utils/lruCache');
const { sanitizeFilename } = require('../utils/mediaFormatters');
const { resolveViaPublicPlatformApis } = require('../extractors/publicApiResolver');
const { scrapePageDeep } = require('../extractors/htmlStreamScraper');
const { parseHlsMasterManifest } = require('../extractors/hlsParser');
const { getLocalFfmpegPath, runYtDlp, inspectViaYtDlp } = require('../extractors/ytdlpBridge');

const sessionCache = new LruCache(250, 10 * 60 * 1000);
const preparedTokens = new LruCache(250, 15 * 60 * 1000);

async function inspectMediaUrl(rawUrl) {
  const parsed = new URL(rawUrl.trim());
  const targetUrl = parsed.href;

  const cached = sessionCache.get(targetUrl);
  if (cached && cached.videoFormats?.length > 0) {
    return cached;
  }

  // Tier 1: Fast native platform APIs (YouTube InnerTube, Dailymotion Player Metadata)
  try {
    const apiData = await resolveViaPublicPlatformApis(targetUrl);
    if (apiData && apiData.videoFormats?.length > 0) {
      if (apiData.hlsStreams?.length > 0 && Object.keys(apiData.hlsVariantsByRes || {}).length === 0) {
        apiData.hlsVariantsByRes = await parseHlsMasterManifest(
          apiData.hlsStreams[0],
          targetUrl,
          apiData.cookieHeader
        );
      }
      sessionCache.set(targetUrl, apiData);
      return apiData;
    }
  } catch {}

  // Tier 2: Local yt-dlp format inspection (when running on localhost)
  if (!IS_VERCEL) {
    try {
      const ytData = await inspectViaYtDlp(targetUrl);
      if (ytData && ytData.videoFormats?.length > 0) {
        sessionCache.set(targetUrl, ytData);
        return ytData;
      }
    } catch {}
  }

  // Tier 3: Deep HTML / KVS / Packed JS / Child Iframe / HLS Manifest Scraper
  const deepData = await scrapePageDeep(targetUrl);
  if (deepData && deepData.videoFormats?.length > 0) {
    sessionCache.set(targetUrl, deepData);
    return deepData;
  }

  return null;
}

async function prepareMediaDownload({ url, title, type = 'mp4', resolution = '720', bitrate = '192' }) {
  const ext = type === 'mp3' ? 'mp3' : 'mp4';
  const suffix = type === 'mp3' ? `${bitrate}kbps` : `${resolution}p`;
  const cleanFilename = sanitizeFilename(title, suffix, ext);

  const session = sessionCache.get(url) || (await inspectMediaUrl(url));
  if (!session) return { ok: false };

  const sessionCookies = session.cookieHeader || DEFAULT_AGE_COOKIES;
  const refererToUse = session.finalPageUrl || url;
  const targetResNum = Number(resolution);

  // 1. Verified direct MP4 stream
  if (type !== 'mp3') {
    const directMap = session.verifiedDirectMap || {};
    const availableRes = Object.keys(directMap).map(Number).sort((a, b) => b - a);
    const chosenRes = availableRes.find(r => r <= targetResNum) || availableRes[0];
    const chosenDirect = chosenRes ? directMap[chosenRes] : null;

    if (chosenDirect?.url && !/\.m3u8(\?|$)/i.test(chosenDirect.url)) {
      const token = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      preparedTokens.set(token, {
        mode: 'direct',
        streamUrl: chosenDirect.url,
        referer: refererToUse,
        cookies: sessionCookies,
        filename: cleanFilename,
        ext
      });
      return { ok: true, token, filename: cleanFilename };
    }
  }

  // 2. Local yt-dlp download & muxing
  if (!IS_VERCEL) {
    const ffmpegBin = getLocalFfmpegPath();
    const hlsVariant = session.hlsVariantsByRes?.[targetResNum]?.url;
    const directFallback = Object.values(session.verifiedDirectMap || {})[0]?.url;

    const candidates = [
      ...new Set(
        [
          hlsVariant,
          url,
          session.finalPageUrl,
          ...(session.childPages || []),
          ...(session.hlsStreams || []),
          directFallback
        ].filter(Boolean)
      )
    ];

    for (const targetToRun of candidates) {
      try {
        const jobId = `fh_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const outTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);
        const args = [
          '--no-playlist',
          '--no-part',
          '--no-warnings',
          '--no-check-certificates',
          '--referer',
          refererToUse,
          '--user-agent',
          BROWSER_UA,
          '--add-header',
          `Cookie:${sessionCookies}`,
          '-o',
          outTemplate
        ];

        if (type === 'mp3') {
          args.push('-f', 'bestaudio/best');
          if (ffmpegBin) {
            args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', `${bitrate}K`);
          }
        } else {
          const formatSelector = ffmpegBin
            ? `bestvideo[height<=${targetResNum}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=${targetResNum}][ext=mp4]/bestvideo[height<=${targetResNum}]+bestaudio/best[height<=${targetResNum}]/best`
            : `best[height<=${targetResNum}][ext=mp4]/best[ext=mp4]/best`;

          args.push('-f', formatSelector);
          if (ffmpegBin) {
            args.push('--merge-output-format', 'mp4');
          }
        }

        args.push(targetToRun);
        await runYtDlp(args, 240000);

        const produced = fs
          .readdirSync(TEMP_DIR)
          .filter(f => f.startsWith(jobId) && !f.endsWith('.part') && !f.endsWith('.ytdl'));

        if (produced.length > 0) {
          const fullPath = path.join(TEMP_DIR, produced[0]);
          const stat = fs.statSync(fullPath);
          if (stat.size > 25000) {
            const actualExt = path.extname(produced[0]).replace('.', '') || ext;
            const finalDownloadName = sanitizeFilename(title, suffix, actualExt);
            const token = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            preparedTokens.set(token, {
              mode: 'file',
              filePath: fullPath,
              filename: finalDownloadName
            });
            return { ok: true, token, filename: finalDownloadName };
          } else {
            fs.unlink(fullPath, () => {});
          }
        }
      } catch {}
    }
  }

  // 3. Pure-Node HLS (.m3u8) segment streamer fallback
  const hlsVariantUrl =
    session.hlsVariantsByRes?.[targetResNum]?.url ||
    Object.values(session.hlsVariantsByRes || {})[0]?.url ||
    (session.hlsStreams || [])[0];

  if (hlsVariantUrl) {
    const token = `hls_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    preparedTokens.set(token, {
      mode: 'hls',
      streamUrl: hlsVariantUrl,
      referer: refererToUse,
      cookies: sessionCookies,
      filename: cleanFilename
    });
    return { ok: true, token, filename: cleanFilename };
  }

  return { ok: false };
}

function consumePreparedToken(token) {
  const entry = preparedTokens.get(token);
  if (entry) {
    preparedTokens.delete(token);
  }
  return entry;
}

module.exports = {
  inspectMediaUrl,
  prepareMediaDownload,
  consumePreparedToken
};