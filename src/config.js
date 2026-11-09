const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT) || 3000;
const TEMP_DIR = path.join(process.cwd(), 'temp');

try {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
} catch {}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DEFAULT_AGE_COOKIES =
  'age_verified=1; over18=1; splash=1; disclaimer=1; verified=1; consented=1; kt_tcookie=1; platform=pc; accessAgeDisclaimerPH=1; expiredEnterModalShown=1';

const MIN_VALID_VIDEO_BYTES = 1500000;

const STANDARD_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240, 144];

const BUILTIN_EXTRACTORS = [
  '1News', '9GAG', 'Abebony', 'ABC', 'AcademicEarth', 'AcFun', 'Archive.org', 'ARD', 'ArteTV',
  'Audiomack', 'Bandcamp', 'BBC', 'Beeg', 'Behance', 'Bilibili', 'BitChute', 'Bloomberg', 'Bluesky',
  'BuzzFeed', 'Camwhores', 'CBC', 'CBS', 'CloudflareStream', 'CNBC', 'CNN', 'ColliderPorn',
  'ComedyCentral', 'Coub', 'Coursera', 'Crunchyroll', 'DaftSex', 'Dailymotion', 'Deezer',
  'Discovery', 'Douyin', 'Dropbox', 'DeutscheWelle', 'edX', 'Eporner', 'ESPN', 'Euronews',
  'Facebook', 'Flickr', 'FoxNews', 'FranceTV', 'Freesound', 'FullHindiBFVideos', 'GameSpot',
  'Giphy', 'GoogleDrive', 'Guardian', 'HClips', 'HotMovs', 'Hotstar', 'HQPorner', 'HuffPost',
  'IcePorn', 'IGN', 'Imdb', 'Imgur', 'Instagram', 'InternetArchive', 'ITV', 'Ixigua', 'Jamendo',
  'JWPlatform', 'Kaltura', 'KhanAcademy', 'Kick', 'Kickstarter', 'Kuaishou', 'LastFM', 'LBRY',
  'LetsPorn', 'LinkedIn', 'Loom', 'MailRu', 'Mastodon', 'Medaltv', 'Medium', 'Metacafe',
  'Mixcloud', 'Motherless', 'MTV', 'NationalGeographic', 'Naver', 'NBA', 'NBC', 'NDTV',
  'NetEaseMusic', 'Newgrounds', 'NextCloud', 'NFL', 'NHK', 'Niconico', 'NPR', 'NewYorkTimes',
  'Odysee', 'Odnoklassniki', 'Panopto', 'Patreon', 'PBS', 'PeerTube', 'Pinterest', 'Pixiv',
  'PlutoTV', 'Podbean', 'Polygon', 'Pornhat', 'Pornhub', 'Porntrex', 'QQMusic', 'Quora',
  'RaiPlay', 'RedBullTV', 'Reddit', 'RedGifs', 'RedTube', 'Rule34Video', 'Rumble', 'Rutube',
  'SharePoint', 'Simplecast', 'SkyNews', 'Slideshare', 'SmugMug', 'Snapchat', 'SonyLIV',
  'SoundCloud', 'SpankBang', 'Spotify', 'Spreaker', 'Steam', 'Streamable', 'Streamtape',
  'Substack', 'SxyPrn', 'TED', 'Telegram', 'TencentVideo', 'TheGuardian', 'TheVerge', 'ThisVid',
  'Threads', 'TikTok', 'TMZ', 'TradingView', 'Triller', 'Trovo', 'Tube8', 'Tubepornclassic',
  'Tumblr', 'TuneIn', 'Twitch', 'Twitter', 'Txxx', 'Udemy', 'Unity', 'Upornia', 'Ustream',
  'Vbox7', 'Vice', 'Vidyard', 'Viki', 'Vimeo', 'Vjav', 'VK', 'Vocaroo', 'VoxMedia', 'VoyeurHit',
  'WashingtonPost', 'WaybackMachine', 'Webex', 'Weibo', 'Wikimedia', 'Wikipedia', 'Wistia',
  'WordPress', 'WSJ', 'WWE', 'X.com', 'XboxClips', 'XHamster', 'XHAccess', 'XNXX', 'XVideos',
  'Yahoo', 'YandexVideo', 'Youku', 'YouPorn', 'YouTube', 'ZDF', 'Zoom'
].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

class LruCache {
  constructor(maxEntries = 300, defaultTtlMs = 30 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
    this.store = new Map();
  }

  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    this.store.delete(key);
    this.store.set(key, item);
    return item.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key) {
    this.store.delete(key);
  }
}

function normalizeInputUrl(rawInput) {
  if (!rawInput) return '';
  let trimmed = String(rawInput).trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  const parsed = new URL(trimmed);
  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    throw new Error('Invalid hostname');
  }
  return parsed.href;
}

function snapToStandardResolution(rawHeight) {
  const n = Number(rawHeight);
  if (!n || isNaN(n) || n < 120) return null;
  if (STANDARD_HEIGHTS.includes(n)) return n;
  return STANDARD_HEIGHTS.reduce((prev, curr) =>
    Math.abs(curr - n) < Math.abs(prev - n) ? curr : prev
  );
}

function formatBytes(bytes) {
  const b = Number(bytes);
  if (!b || isNaN(b) || b < MIN_VALID_VIDEO_BYTES) return null;
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

const NAMED_ENTITIES = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  excl: '!',
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: '...',
  copy: '(c)',
  reg: '(r)'
};

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&([a-zA-Z0-9]+);/g, (full, name) => {
      const lower = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : '';
    })
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
    const trimmed = String(maybeRelative).trim();
    if (trimmed.startsWith('//')) {
      const parsedBase = new URL(baseUrl);
      return `${parsedBase.protocol}${trimmed}`;
    }
    return new URL(trimmed, baseUrl).href;
  } catch {
    return '';
  }
}

module.exports = {
  PORT,
  TEMP_DIR,
  BROWSER_UA,
  DEFAULT_AGE_COOKIES,
  MIN_VALID_VIDEO_BYTES,
  STANDARD_HEIGHTS,
  BUILTIN_EXTRACTORS,
  LruCache,
  normalizeInputUrl,
  snapToStandardResolution,
  formatBytes,
  formatDuration,
  decodeHtmlEntities,
  humanizeUrlSlug,
  sanitizeFilename,
  resolveAbsoluteUrl
};