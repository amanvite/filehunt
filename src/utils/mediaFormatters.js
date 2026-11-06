const { STANDARD_HEIGHTS } = require('../config/constants');

// snap non-standard heights (e.g. 1072 -> 1080) to standard labels
function snapToStandardResolution(rawHeight) {
  const n = Number(rawHeight);
  if (!n || isNaN(n) || n < 100) return null;
  if (STANDARD_HEIGHTS.includes(n)) return n;
  return STANDARD_HEIGHTS.reduce((prev, curr) =>
    Math.abs(curr - n) < Math.abs(prev - n) ? curr : prev
  );
}

function formatBytes(bytes) {
  const b = Number(bytes);
  if (!b || isNaN(b) || b <= 0) return null;
  const mb = b / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function formatDuration(sec) {
  if (!sec || isNaN(sec) || sec <= 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .trim();
}

function humanizeUrlSlug(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const segments = parsed.pathname
      .split('/')
      .map(s => s.trim())
      .filter(s => s && !/^(video|videos|watch|look|out|go|v|embed|en|de|fr|es|\d+)$/i.test(s));

    const bestSegment = segments.sort((a, b) => b.length - a.length)[0];
    if (bestSegment && bestSegment.length > 2) {
      return decodeURIComponent(bestSegment)
        .replace(/\.(html|php|htm|mp4)$/i, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
    }
    return `Video on ${parsed.hostname.replace(/^www\./, '')}`;
  } catch {
    return 'Video Stream';
  }
}

// clean video title so downloaded files use the real video name
function sanitizeFilename(rawTitle, suffix = '', ext = 'mp4') {
  const cleaned = decodeHtmlEntities(rawTitle || 'Video')
    .replace(/[\u0000-\u001f"<>|:*?\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 85);

  const base = cleaned || 'Video_Stream';
  const tag = suffix ? `_${suffix}` : '';
  return `${base}${tag}.${ext}`;
}

function resolveAbsoluteUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return '';
  try {
    return new URL(maybeRelative, baseUrl).href;
  } catch {
    return '';
  }
}

module.exports = {
  snapToStandardResolution,
  formatBytes,
  formatDuration,
  decodeHtmlEntities,
  humanizeUrlSlug,
  sanitizeFilename,
  resolveAbsoluteUrl
};