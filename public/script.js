const downloadForm = document.getElementById('downloadForm');
const videoUrlInput = document.getElementById('videoUrl');
const submitBtn = document.getElementById('submitBtn');
const pasteBtn = document.getElementById('pasteBtn');
const clearBtn = document.getElementById('clearBtn');
const platformBadge = document.getElementById('platformBadge');
const statusMessage = document.getElementById('statusMessage');
const googleLoader = document.getElementById('googleLoader');
const resultCard = document.getElementById('resultCard');
const videoThumb = document.getElementById('videoThumb');
const videoDurationBadge = document.getElementById('videoDurationBadge');
const videoTitle = document.getElementById('videoTitle');
const videoMetaChips = document.getElementById('videoMetaChips');
const thumbDownloadBtn = document.getElementById('thumbDownloadBtn');
const formatTableContainer = document.getElementById('formatTableContainer');
const toggleClipperBtn = document.getElementById('toggleClipperBtn');
const clipperBox = document.getElementById('clipperBox');
const clipStartInput = document.getElementById('clipStart');
const clipEndInput = document.getElementById('clipEnd');
const historySection = document.getElementById('historySection');
const historyGrid = document.getElementById('historyGrid');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

let currentMediaData = null;
let currentUrl = '';
let activeTab = 'muxed';

// 1. Dynamic Service Adaptation from service.html (?service=...)
const params = new URLSearchParams(window.location.search);
const selectedService = params.get('service');
if (selectedService && videoUrlInput) {
  videoUrlInput.placeholder = `Paste ${selectedService} video or audio URL here...`;
  const badge = document.getElementById('activeServiceBadge');
  const seoTitle = document.getElementById('seoTitle');
  if (badge) {
    badge.style.display = 'inline-flex';
    badge.textContent = `${selectedService} Downloader Mode`;
  }
  if (seoTitle) {
    seoTitle.textContent = `${selectedService} Video & Audio Downloader Online`;
  }
}

// 2. Keyboard shortcut '/' to focus Omnibox like Google Search
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== videoUrlInput && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    videoUrlInput?.focus();
  }
});

// 3. Auto-detect Platform as user types/pastes
const PLATFORM_RULES = [
  { name: 'YouTube', regex: /(youtube\.com|youtu\.be)/i },
  { name: 'TikTok', regex: /tiktok\.com/i },
  { name: 'Instagram', regex: /instagram\.com/i },
  { name: 'X / Twitter', regex: /(twitter\.com|x\.com)/i },
  { name: 'Facebook', regex: /(facebook\.com|fb\.watch)/i },
  { name: 'Vimeo', regex: /vimeo\.com/i },
  { name: 'Twitch', regex: /twitch\.tv/i },
  { name: 'SoundCloud', regex: /soundcloud\.com/i },
  { name: 'Dailymotion', regex: /dailymotion\.com/i },
  { name: 'Reddit', regex: /reddit\.com/i }
];

function detectPlatform(url) {
  if (!url) {
    platformBadge.textContent = 'Auto-Detect';
    platformBadge.classList.remove('active');
    clearBtn.style.display = 'none';
    return;
  }
  clearBtn.style.display = 'inline-flex';
  const match = PLATFORM_RULES.find(p => p.regex.test(url));
  platformBadge.textContent = match ? match.name : 'Web Link';
  platformBadge.classList.add('active');
}

videoUrlInput?.addEventListener('input', (e) => detectPlatform(e.target.value.trim()));

// 4. Paste & Clear Buttons
pasteBtn?.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      videoUrlInput.value = text.trim();
      detectPlatform(videoUrlInput.value);
      videoUrlInput.focus();
    }
  } catch {
    statusMessage.textContent = 'Press Ctrl+V / Cmd+V inside the box to paste your link.';
  }
});

clearBtn?.addEventListener('click', () => {
  videoUrlInput.value = '';
  detectPlatform('');
  videoUrlInput.focus();
});

// 5. Toggle Video Clip Trimmer
toggleClipperBtn?.addEventListener('click', () => {
  clipperBox.classList.toggle('open');
});

// 6. Format Helper Utilities
function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return 'Auto Size';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function buildClipQuery() {
  const start = clipStartInput?.value.trim();
  const end = clipEndInput?.value.trim();
  let q = '';
  if (start) q += `&start=${encodeURIComponent(start)}`;
  if (end) q += `&end=${encodeURIComponent(end)}`;
  return q;
}

// 7. Render Categorized Format Table (FetchFile-style complexity)
function renderActiveTab() {
  if (!currentMediaData) return;
  const clipQuery = buildClipQuery();
  let rowsHtml = '';

  if (activeTab === 'muxed') {
    const resolutions = currentMediaData.resolutions || [1080, 720, 480, 360];
    const detailedMuxed = currentMediaData.formats?.filter(f => f.category === 'muxed') || [];

    const listToRender = detailedMuxed.length > 0
      ? detailedMuxed
      : resolutions.map(r => ({
          resolution: r,
          ext: 'MP4',
          vcodec: r >= 1080 ? 'H.264 / AVC1 (HD)' : 'H.264 / AVC1',
          fps: 30,
          filesize: null
        }));

    rowsHtml = listToRender.map(item => {
      const res = item.resolution;
      const badgeClass = res >= 2160 ? 'quality-badge uhd' : 'quality-badge';
      const badgeText = res >= 2160 ? '4K UHD' : res >= 1440 ? '2K QHD' : res >= 1080 ? 'Full HD' : res >= 720 ? 'HD' : 'SD';
      const dlHref = `/api/download?url=${encodeURIComponent(currentUrl)}&type=mp4&resolution=${res}${clipQuery}`;

      return `
        <tr>
          <td>
            <strong>${res}p</strong>
            <span class="${badgeClass}">${badgeText}</span>
          </td>
          <td>MP4 (${item.vcodec || 'H.264'} + AAC)</td>
          <td>${item.fps ? `${item.fps} fps` : 'Standard'}</td>
          <td>${formatBytes(item.filesize)}</td>
          <td style="text-align: right;">
            <a href="${dlHref}" class="format-item-btn" data-label="${res}p MP4">
              &#8681; Download MP4
            </a>
          </td>
        </tr>
      `;
    }).join('');
  } else if (activeTab === 'audio') {
    const audioPresets = [
      { bitrate: 320, label: '320 kbps', desc: 'Studio Master MP3', ext: 'MP3', sizeFactor: 2.4 },
      { bitrate: 192, label: '192 kbps', desc: 'High Quality MP3', ext: 'MP3', sizeFactor: 1.5 },
      { bitrate: 128, label: '128 kbps', desc: 'Standard Portable MP3', ext: 'MP3', sizeFactor: 1.0 },
      { bitrate: 'm4a', label: 'Original M4A', desc: 'AAC Direct Audio Stream', ext: 'M4A', sizeFactor: 1.1 }
    ];

    rowsHtml = audioPresets.map(a => {
      const dlHref = `/api/download?url=${encodeURIComponent(currentUrl)}&type=mp3&bitrate=${a.bitrate}${clipQuery}`;
      return `
        <tr>
          <td><strong>${a.label}</strong> <span class="quality-badge">${a.ext}</span></td>
          <td>${a.desc}</td>
          <td>Stereo 44.1kHz</td>
          <td>Fast Conversion</td>
          <td style="text-align: right;">
            <a href="${dlHref}" class="format-item-btn mp3" data-label="${a.label} Audio">
              &#9835; Download ${a.ext}
            </a>
          </td>
        </tr>
      `;
    }).join('');
  } else if (activeTab === 'videoonly') {
    const resolutions = currentMediaData.resolutions || [1080, 720];
    rowsHtml = resolutions.map(res => {
      const dlHref = `/api/download?url=${encodeURIComponent(currentUrl)}&type=videoonly&resolution=${res}${clipQuery}`;
      return `
        <tr>
          <td><strong>${res}p Raw Video</strong> <span class="quality-badge">DASH</span></td>
          <td>MP4 / WebM (No Audio Track)</td>
          <td>High Bitrate Stream</td>
          <td>Direct Stream</td>
          <td style="text-align: right;">
            <a href="${dlHref}" class="format-item-btn secondary" data-label="${res}p Raw Stream">
              &#8681; Save Video Stream
            </a>
          </td>
        </tr>
      `;
    }).join('');
  } else if (activeTab === 'subtitles') {
    const subs = currentMediaData.subtitles || ['en'];
    rowsHtml = subs.map(lang => {
      const dlHref = `/api/download?url=${encodeURIComponent(currentUrl)}&type=subtitles&lang=${encodeURIComponent(lang)}`;
      return `
        <tr>
          <td><strong>${lang.toUpperCase()}</strong> <span class="quality-badge">SRT / VTT</span></td>
          <td>Closed Captions / Auto-Subtitles</td>
          <td>Text Track</td>
          <td>&lt; 100 KB</td>
          <td style="text-align: right;">
            <a href="${dlHref}" class="format-item-btn secondary" data-label="${lang.toUpperCase()} Subtitles">
              &#8681; Download .SRT
            </a>
          </td>
        </tr>
      `;
    }).join('');
  }

  formatTableContainer.innerHTML = `
    <table class="format-table">
      <thead>
        <tr>
          <th>Quality</th>
          <th>Container / Codec</th>
          <th>Stream Info</th>
          <th>Est. Size</th>
          <th style="text-align: right;">Action</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  `;

  formatTableContainer.querySelectorAll('.format-item-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const label = btn.getAttribute('data-label') || 'media';
      statusMessage.classList.remove('error');
      statusMessage.textContent = `Preparing ${label}... Your browser download will begin automatically once processed.`;
    });
  });
}

// Tab Switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.getAttribute('data-tab');
    renderActiveTab();
  });
});

// 8. LocalStorage History Management
function saveToHistory(item) {
  try {
    const existing = JSON.parse(localStorage.getItem('filehunt_history') || '[]');
    const filtered = existing.filter(x => x.url !== item.url);
    filtered.unshift(item);
    localStorage.setItem('filehunt_history', JSON.stringify(filtered.slice(0, 6)));
    renderHistory();
  } catch {}
}

function renderHistory() {
  if (!historySection || !historyGrid) return;
  try {
    const list = JSON.parse(localStorage.getItem('filehunt_history') || '[]');
    if (list.length === 0) {
      historySection.style.display = 'none';
      return;
    }
    historySection.style.display = 'block';
    historyGrid.innerHTML = list.map(item => `
      <div class="history-item" data-url="${encodeURIComponent(item.url)}">
        <img src="${item.thumbnail || 'https://via.placeholder.com/140x80?text=Media'}" alt="Thumb" />
        <div class="history-item-info">
          <div class="history-item-title">${item.title || 'Media File'}</div>
          <div class="history-item-sub">${item.extractor || 'Web'} &bull; ${item.duration || ''}</div>
        </div>
      </div>
    `).join('');

    historyGrid.querySelectorAll('.history-item').forEach(card => {
      card.addEventListener('click', () => {
        const u = decodeURIComponent(card.getAttribute('data-url'));
        videoUrlInput.value = u;
        detectPlatform(u);
        downloadForm.requestSubmit();
      });
    });
  } catch {}
}

clearHistoryBtn?.addEventListener('click', () => {
  localStorage.removeItem('filehunt_history');
  renderHistory();
});

renderHistory();

// 9. Form Submission & Stream Analysis
if (downloadForm) {
  downloadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = videoUrlInput.value.trim();
    if (!url) return;

    currentUrl = url;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Hunting...';
    googleLoader.classList.add('active');
    statusMessage.classList.remove('error');
    statusMessage.textContent = 'Inspecting media streams, codecs, and audio bitrates...';
    resultCard.style.display = 'none';

    try {
      const response = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        statusMessage.classList.add('error');
        statusMessage.textContent = data.error || 'Could not inspect this URL.';
        return;
      }

      currentMediaData = data;
      statusMessage.textContent = '';
      videoTitle.textContent = data.title || 'Untitled Media';
      videoDurationBadge.textContent = data.duration || 'LIVE / N/A';
      videoThumb.src = data.thumbnail || 'https://via.placeholder.com/210x118?text=No+Preview';
      thumbDownloadBtn.href = data.thumbnail || '#';

      // Build Google-style metadata chips
      const chips = [
        `Source: ${data.extractor || 'Detected'}`,
        `Duration: ${data.duration || 'N/A'}`,
        data.uploader ? `Channel: ${data.uploader}` : null,
        data.view_count ? `Views: ${Number(data.view_count).toLocaleString()}` : null,
        `${(data.resolutions || []).length} Video Qualities`
      ].filter(Boolean);

      videoMetaChips.innerHTML = chips.map(c => `<span class="meta-chip">${c}</span>`).join('');

      activeTab = 'muxed';
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-tab') === 'muxed');
      });

      renderActiveTab();
      resultCard.style.display = 'block';

      saveToHistory({
        url,
        title: data.title,
        thumbnail: data.thumbnail,
        extractor: data.extractor,
        duration: data.duration
      });
    } catch (error) {
      statusMessage.classList.add('error');
      statusMessage.textContent = 'Network error: Make sure your Node.js server (server.js) is running.';
    } finally {
      googleLoader.classList.remove('active');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Hunt File';
    }
  });
}