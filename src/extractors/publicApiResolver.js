const { BROWSER_UA, DEFAULT_AGE_COOKIES } = require('../config/constants');
const {
  snapToStandardResolution,
  formatBytes,
  formatDuration
} = require('../utils/mediaFormatters');

// query YouTube InnerTube Player API directly to get real per-video resolutions & sizes
async function resolveYouTubeInnerTube(targetUrl) {
  const ytMatch =
    targetUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
    targetUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
    targetUrl.match(/youtube\.com\/(?:shorts|embed)\/([a-zA-Z0-9_-]{11})/);

  if (!ytMatch) return null;
  const videoId = ytMatch[1];

  const clients = [
    {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      androidSdkVersion: 34,
      userAgent: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 14; en_US; Quest 3; Build/UP1A.231005.007.A1; Cronet/119.0.6045.194)'
    },
    {
      clientName: 'IOS',
      clientVersion: '19.45.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.1.0.22B83',
      userAgent: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1 like Mac OS X;)'
    }
  ];

  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': client.userAgent
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: client.clientName,
              clientVersion: client.clientVersion,
              hl: 'en',
              gl: 'US',
              ...(client.androidSdkVersion ? { androidSdkVersion: client.androidSdkVersion } : {}),
              ...(client.deviceMake ? { deviceMake: client.deviceMake, deviceModel: client.deviceModel, osName: client.osName, osVersion: client.osVersion } : {})
            }
          }
        }),
        signal: AbortSignal.timeout(5500)
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
        if (f.mimeType && f.mimeType.startsWith('video/')) {
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

          if (f.url && hasAudio) {
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

  return null;
}

// query Dailymotion Player Metadata API to get exact qualities and stream URLs
async function resolveDailymotionPlayerApi(targetUrl) {
  const dmMatch =
    targetUrl.match(/dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/i) ||
    targetUrl.match(/dai\.ly\/([a-zA-Z0-9]+)/i);

  if (!dmMatch) return null;
  const videoId = dmMatch[1];

  try {
    const metaRes = await fetch(`https://www.dailymotion.com/player/metadata/video/${videoId}`, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(5000)
    });
    if (!metaRes.ok) return null;
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

    if (videoFormats.length === 0) return null;

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
  } catch {
    return null;
  }
}

async function resolveViaPublicPlatformApis(targetUrl) {
  if (/youtube\.com|youtu\.be/i.test(targetUrl)) {
    const yt = await resolveYouTubeInnerTube(targetUrl);
    if (yt) return yt;
  }
  if (/dailymotion\.com|dai\.ly/i.test(targetUrl)) {
    const dm = await resolveDailymotionPlayerApi(targetUrl);
    if (dm) return dm;
  }
  return null;
}

module.exports = {
  resolveViaPublicPlatformApis
};