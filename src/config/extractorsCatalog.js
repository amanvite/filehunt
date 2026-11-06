// canonical list of supported extractors sorted A-Z
const BUILTIN_EXTRACTORS = [
  '1News', '9GAG', 'Abebony', 'ABC', 'AcademicEarth', 'AcFun', 'Archive.org', 'ARD', 'ArteTV',
  'Audiomack', 'Bandcamp', 'BBC', 'Beeg', 'Behance', 'Bilibili', 'BitChute', 'Bloomberg', 'Bluesky',
  'BuzzFeed', 'Camwhores', 'CBC', 'CBS', 'CloudflareStream', 'CNBC', 'CNN', 'ColliderPorn',
  'ComedyCentral', 'Coub', 'Coursera', 'Crunchyroll', 'DaftSex', 'Dailymotion', 'Deezer',
  'Discovery', 'Douyin', 'Dropbox', 'DeutscheWelle', 'edX', 'Eporner', 'ESPN', 'Euronews',
  'Facebook', 'Flickr', 'FoxNews', 'FranceTV', 'Freesound', 'GameSpot', 'Giphy', 'GitHub',
  'GoogleDrive', 'Guardian', 'HClips', 'HotMovs', 'Hotstar', 'HQPorner', 'HuffPost', 'IGN', 'Imdb',
  'Imgur', 'Instagram', 'InternetArchive', 'ITV', 'Ixigua', 'Jamendo', 'JWPlatform', 'Kaltura',
  'KhanAcademy', 'Kick', 'Kickstarter', 'Kuaishou', 'LastFM', 'LBRY', 'LetsPorn', 'LinkedIn',
  'Loom', 'MailRu', 'Mastodon', 'Medaltv', 'Medium', 'Metacafe', 'Mixcloud', 'Motherless', 'MTV',
  'NationalGeographic', 'Naver', 'NBA', 'NBC', 'NDTV', 'NetEaseMusic', 'Newgrounds', 'NextCloud',
  'NFL', 'NHK', 'Niconico', 'NPR', 'NewYorkTimes', 'Odysee', 'Odnoklassniki', 'Panopto', 'Patreon',
  'PBS', 'PeerTube', 'Pinterest', 'Pixiv', 'PlutoTV', 'Podbean', 'Polygon', 'Pornhat', 'Pornhub',
  'Porntrex', 'QQMusic', 'Quora', 'RaiPlay', 'RedBullTV', 'Reddit', 'RedGifs', 'RedTube',
  'Rule34Video', 'Rumble', 'Rutube', 'SharePoint', 'Simplecast', 'SkyNews', 'Slideshare',
  'SmugMug', 'Snapchat', 'SonyLIV', 'SoundCloud', 'SpankBang', 'Spotify', 'Spreaker', 'Steam',
  'Streamable', 'Streamtape', 'Substack', 'SxyPrn', 'TED', 'Telegram', 'TencentVideo',
  'TheGuardian', 'TheVerge', 'ThisVid', 'Threads', 'TikTok', 'TMZ', 'TradingView', 'Triller',
  'Trovo', 'Tube8', 'Tubepornclassic', 'Tumblr', 'TuneIn', 'Twitch', 'Twitter', 'Txxx', 'Udemy',
  'Unity', 'Upornia', 'Ustream', 'Vbox7', 'Vice', 'Vidyard', 'Viki', 'Vimeo', 'Vjav', 'VK',
  'Vocaroo', 'VoxMedia', 'VoyeurHit', 'WashingtonPost', 'WaybackMachine', 'Webex', 'Weibo',
  'Wikimedia', 'Wikipedia', 'Wistia', 'WordPress', 'WSJ', 'WWE', 'X.com', 'XboxClips', 'XHamster',
  'XNXX', 'XVideos', 'Yahoo', 'YandexVideo', 'Youku', 'YouPorn', 'YouTube', 'ZDF', 'Zoom'
].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

module.exports = { BUILTIN_EXTRACTORS };