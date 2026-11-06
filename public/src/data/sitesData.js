import { YouTubeIcon, InstagramIcon, FacebookIcon, TikTokIcon } from '../components/Icons.js';

// unified platform and converter definitions for the Sites view
export const CORE_SITES_DATA = [
  { name: 'youtube.com', label: 'YouTube', icon: YouTubeIcon, color: 'yt', category: 'social' },
  { name: 'instagram.com', label: 'Instagram', icon: InstagramIcon, color: 'ig', category: 'social' },
  { name: 'facebook.com', label: 'Facebook', icon: FacebookIcon, color: 'fb', category: 'social' },
  { name: 'tiktok.com', label: 'TikTok', icon: TikTokIcon, color: 'tt', category: 'social' },
  { name: 'dailymotion.com', label: 'Dailymotion', badge: 'd', color: 'blue', category: 'social' },
  { name: 'vimeo.com', label: 'Vimeo', badge: 'v', color: 'sky', category: 'social' },
  { name: 'vk.com', label: 'VK', badge: 'VK', color: 'vk', category: 'social' },
  { name: 'reddit.com', label: 'Reddit', badge: 'r/', color: 'orange', category: 'social' },
  { name: 'pinterest.com', label: 'Pinterest', badge: 'P', color: 'red', category: 'social' },
  { name: 'Threads', label: 'Threads', badge: '@', color: 'dark', category: 'social' },
  { name: 'x.com', label: 'X (Twitter)', badge: 'X', color: 'dark', category: 'social' },
  { name: 'twitch.tv', label: 'Twitch', badge: 'TW', color: 'purple', category: 'social' },
  { name: 'soundcloud.com', label: 'SoundCloud', badge: 'SC', color: 'orange', category: 'social' },
  { name: 'MP4 Converter', label: 'MP4 Converter', badge: 'MP4', color: 'slate', category: 'converter' },
  { name: 'MP4 to MP3', label: 'MP4 to MP3', badge: 'MP3', color: 'slate', category: 'converter' },
  { name: 'MOV to MP4', label: 'MOV to MP4', badge: 'MOV', color: 'slate', category: 'converter' },
  { name: 'MP4 to GIF', label: 'MP4 to GIF', badge: 'GIF', color: 'slate', category: 'converter' },
  { name: 'MKV to MP4', label: 'MKV to MP4', badge: 'MKV', color: 'slate', category: 'converter' },
  { name: 'WEBM to MP4', label: 'WEBM to MP4', badge: 'WEB', color: 'slate', category: 'converter' },
  { name: 'YouTube Transcript', label: 'YouTube Transcript', badge: 'TXT', color: 'slate', category: 'converter' },
  { name: 'YouTube Subtitles', label: 'YouTube Subtitles', badge: 'CC', color: 'slate', category: 'converter' }
];

export const BADGE_COLOR_PALETTE = ['blue', 'sky', 'vk', 'dark', 'orange', 'red', 'slate', 'green', 'purple'];

export function createExtractorEntry(rawName) {
  const clean = rawName.replace(/[^a-zA-Z0-9]/g, '');
  const shortCode = clean.slice(0, 3).toUpperCase() || 'WEB';
  let hash = 0;
  for (let i = 0; i < rawName.length; i++) {
    hash = rawName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const color = BADGE_COLOR_PALETTE[Math.abs(hash) % BADGE_COLOR_PALETTE.length];
  return {
    name: rawName.includes('.') ? rawName : `${rawName.toLowerCase()}.com`,
    label: rawName,
    badge: shortCode,
    color,
    category: 'extractor'
  };
}

export const TERMS_CLAUSES = [
  {
    title: '1. Acceptance of Terms & Binding Agreement',
    body: 'By accessing, browsing, or submitting any Uniform Resource Locator (URL) to FileHunt ("the Service"), you acknowledge that you have read, understood, and agreed to be legally bound by these Terms of Service. If you do not agree to every provision of these Terms, you are strictly prohibited from accessing or using the Service.'
  },
  {
    title: '2. Strict Prohibition of Copyrighted Materials',
    body: 'Downloading any copyrighted materials without the express prior written authorization of the copyright owner is strictly prohibited. FileHunt is provided solely for media originally created and owned by you, media distributed under an explicit Creative Commons or Public Domain license, or media for which you hold verifiable written permission.'
  },
  {
    title: '3. Non-Circumvention of DRM & Technical Protection Measures',
    body: 'FileHunt operates strictly on publicly exposed HTTP/HTTPS metadata and unencrypted public streams. The Service does not decrypt, bypass, strip, or circumvent Digital Rights Management (DRM), paywalls, private authentication gates, or technological protection measures under 17 U.S.C. § 1201 or equivalent statutes.'
  },
  {
    title: '4. User Representations, Warranties & Sole Responsibility',
    body: 'Every time you submit a URL to FileHunt, you affirmatively represent and warrant under penalty of law that you hold all necessary legal rights to process and download the target resource, that your usage complies with the source site terms, and that you assume 100% of the legal responsibility arising from your actions.'
  },
  {
    title: '5. Passive Technical Intermediary & Safe Harbor Status',
    body: 'FileHunt is an automated, user-initiated, stateless technical conduit. The developer and operator do not select, initiate, monitor, index, host, cache, or curate any third-party media content. Processing occurs solely at the automated direction of the User under 17 U.S.C. § 512(a) (DMCA Safe Harbor) and Section 79 of the Information Technology Act, 2000 (India).'
  },
  {
    title: '6. Complete Disclaimer of Warranties ("AS IS") & Limitation of Liability',
    body: 'THE SERVICE IS PROVIDED STRICTLY "AS IS" WITHOUT WARRANTIES OF ANY KIND. TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT SHALL THE DEVELOPER, CREATOR, OR HOSTING PROVIDERS OF FILEHUNT BE HELD LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, OR FOR ANY CLAIM OF COPYRIGHT INFRINGEMENT COMMITTED BY ANY USER.'
  },
  {
    title: '7. Indemnification & Hold Harmless Agreement',
    body: 'You agree to fully indemnify, defend, and hold harmless the developer and operator of FileHunt from and against any and all claims, demands, lawsuits, liabilities, damages, losses, and legal fees arising out of your use or misuse of the Service or your violation of third-party intellectual property rights.'
  }
];

export const PRIVACY_CLAUSES = [
  {
    title: '1. Zero Personal Data Collection',
    body: 'FileHunt is engineered with a strict privacy-by-design architecture. We do not require user registration, accounts, names, email addresses, phone numbers, or payment details to use the Service.'
  },
  {
    title: '2. Stateless Ephemeral URL Processing (No Past URL History)',
    body: 'When you paste a link into the search bar, the URL is processed ephemerally in volatile memory solely to inspect public stream metadata. We do not store past links in browser autofill history or retain server logs linking URLs to user IP addresses.'
  },
  {
    title: '3. Automatic Temporary File Purge',
    body: 'Whenever stream muxing utilizes temporary scratch storage, temporary buffers are automatically and permanently unlinked (fs.unlink) immediately upon completion of the HTTP download stream.'
  },
  {
    title: '4. No Third-Party Ad Trackers or Behavioral Profiling',
    body: 'FileHunt does not embed third-party advertising networks, cross-site tracking pixels, or behavioral fingerprinting scripts. We never sell, rent, or trade user data with third parties.'
  }
];