const downloadForm = document.getElementById('downloadForm');
const videoUrlInput = document.getElementById('videoUrl');
const submitBtn = document.getElementById('submitBtn');
const pasteBtn = document.getElementById('pasteBtn');
const clearBtn = document.getElementById('clearBtn');
const platformBadge = document.getElementById('platformBadge');
const statusMessage = document.getElementById('statusMessage');
const googleLoader = document.getElementById('googleLoader');
const resultCard = document.getElementById('resultCard');
const engineBadge = document.getElementById('engineBadge');
const licenseBadge = document.getElementById('licenseBadge');
const videoThumb = document.getElementById('videoThumb');
const videoDurationBadge = document.getElementById('videoDurationBadge');
const videoTitle = document.getElementById('videoTitle');
const videoMetaChips = document.getElementById('videoMetaChips');
const thumbDownloadBtn = document.getElementById('thumbDownloadBtn');
const copyJsonBtn = document.getElementById('copyJsonBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const formatTableContainer = document.getElementById('formatTableContainer');
const toggleClipperBtn = document.getElementById('toggleClipperBtn');
const clipperBox = document.getElementById('clipperBox');
const clipStartInput = document.getElementById('clipStart');
const clipEndInput = document.getElementById('clipEnd');
const historySection = document.getElementById('historySection');
const historyGrid = document.getElementById('historyGrid');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const singleModeBtn = document.getElementById('singleModeBtn');
const batchModeBtn = document.getElementById('batchModeBtn');
const batchContainer = document.getElementById('batchContainer');
const batchInput = document.getElementById('batchInput');
const runBatchBtn = document.getElementById('runBatchBtn');
const batchResults = document.getElementById('batchResults');
const toastBox = document.getElementById('toastBox');

let currentMediaData = null;
let currentUrl = '';
let activeTab = 'muxed';

function showToast(msg) {
  if (!toastBox) return;
  toastBox.textContent = msg;
  toastBox.style.display = 'block';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    toastBox.style.display = 'none';
  }, 3200);
}

// 1. Dynamic Service Mode from service.html
const params = new URLSearchParams(window.location.search);
const selectedService = params.get('service');
if (selectedService && videoUrlInput) {
  videoUrlInput.placeholder = `Paste ${selectedService} URL here...`;
  const badge = document.getElementById('activeServiceBadge');
  const seoTitle = document.getElementById('seoTitle');
  if (badge) {
    badge.style.display = 'inline-flex';
    badge.textContent = `${selectedService} Stream Inspector Active`;
  }
  if (seoTitle) {
    seoTitle.textContent = `${selectedService} Media Stream Inspector & Downloader`;
  }
}

// 2. Single vs Batch Mode Switcher
singleModeBtn?.addEventListener('click', () => {
  singleModeBtn.classList.add('active');
  batchModeBtn.classList.remove('active');
  downloadForm.style.display = 'block';
  batchContainer.style.display = 'none';
});

batchModeBtn?.addEventListener('click', () => {
  batchModeBtn.classList.add('active');
  singleModeBtn.classList.remove('active');
  downloadForm.style.display = 'none';
  batchContainer.style.display = 'block';
});

// 3. Keyboard Shortcut '/' to focus URL input
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== videoUrlInput && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    videoUrlInput?.focus();
  }
});

// 4. Platform Auto-Detector
const PLATFORM_RULES = [
  { name: 'Dailymotion', regex: /(dailymotion\.com|dai\.ly)/i },
  { name: 'YouTube', regex: /(youtube\.com|youtu\.be)/i },
  { name: 'TikTok', regex: /tiktok\.com/i },
  { name: 'Instagram', regex: /instagram\.com/i },
  { name: 'X / Twitter', regex: /(twitter\.com|x\.com)/i },
  { name: 'Vimeo', regex: /vimeo\.com/i },
  { name: 'SoundCloud', regex: /soundcloud\.com/i },
  { name: 'Twitch', regex: /twitch\.tv/i },
  { name: 'Facebook', regex: /(facebook\.com|fb\.watch)/i },
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
  platformBadge.textContent = match ? match.name : 'Web Stream';
  platformBadge.classList.add('active');
}

videoUrlInput?.addEventListener('input', (e) => detectPlatform(e.target.value.trim()));

// 5. Sample Chips (1-click test including Dailymotion xbtliqi)
document.querySelectorAll('.sample-chip[data-sample]').forEach(chip => {
  chip.addEventListener('click', () => {
    const sampleUrl = chip.getAttribute('data-sample');
    videoUrlInput.value = sampleUrl;
    detectPlatform(sampleUrl);
    downloadForm.requestSubmit();
  });
});

// 6. Paste, Clear & Clipper Controls
pasteBtn?.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      videoUrlInput.value = text.trim();
      detectPlatform(videoUrlInput.value);
      showToast('URL pasted from clipboard');
    }
  } catch {
    showToast('Press Ctrl+V / Cmd+V in the input field');
  }
});

clearBtn?.addEventListener('click', () => {
  videoUrlInput.value = '';
  detectPlatform('');
  videoUrlInput.focus();
});

toggleClipperBtn?.addEventListener('click', () => {
  clipperBox.classList.toggle('open');
});

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

// 7. Render the 6 Studio Tabs
function renderActiveTab() {
  if (!currentMediaData) return;
  const clipQuery = buildClipQuery();
  const durSec = Number(currentMediaData.duration_seconds) || 60;

  if (activeTab === 'muxed') {
    const formats = currentMediaData.formats || [];
    const rowsHtml = formats.map(item => {
      const res = item.resolution;
      const badgeClass = res >= 2160 ? 'quality-badge uhd' : 'quality-badge';
      const badgeText = res >= 2160 ? '4K UHD' : res >= 1440 ? '2K QHD' : res >= 1080 ? 'Full HD' : res >= 720 ? 'HD' : 'SD';
      const dlHref = `/api/download?url=${encodeURIComponent(currentUrl)}&type=mp4&resolution=${res}${clipQuery}`;

      return `
        <tr>
          <td><strong>${res}p</strong> <span class="${badgeClass}">${badgeText}</span></td>
          <td>${(item.ext || 'MP4').toUpperCase()} &bull; ${item.vcodec || 'H.264'} + ${item.acodec || 'AAC'}</td>
          <td>${item.fps || 30} fps ${item.bitrate ? `&bull; ${item.bitrate}` : ''}</td>
          <td>${formatBytes(item.filesize)}</td>
          <td style="text-align: right;">
            <a href="${dlHref}" class="format-item-btn" data-label="${res}p MP4">
              &#8681; Save ${res}p MP4
            </a>
          </td>
        </tr>
      `;
    }).join('');

    formatTableContainer.innerHTML = `
      <table class="format-table">
        <thead>
          <tr>
            <th>Resolution</th>
            <th>Container &amp; Codecs</th>
            <th>Frame Rate / Bitrate</th>
            <th>Est. Size</th>
            <th style="text-align: right;">Stream Action</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
  } else if (activeTab === 'audio') {
    const audioPresets = [
      { bitrate: 320, label: '320 kbps', desc: 'Studio Archival MP3 (LAME V0)', ext: 'MP3', kbps: 320 },
      { bitrate: 256, label: '256 kbps', desc: 'Premium Broadcast MP3', ext: 'MP3', kbps: 256 },
      { bitrate: 192, label: '192 kbps', desc: 'High Quality Stereo MP3', ext: 'MP3', kbps: 192 },
      { bitrate: 128, label: '128 kbps', desc: 'Standard Mobile MP3', ext: 'MP3', kbps: 128 },
      { bitrate: 'm4a', label: 'Original M4A', desc: 'Native AAC Audio Container', ext: 'M4A', kbps: 160 }
    ];

    const rowsHtml = audioPresets.map(a => {
      const estBytes = Math.round(((a.kbps * 1000) / 8) * durSec);
      const dlHref = `/api/download?url=${encodeURIComponent(currentUrl)}&type=mp3&bitrate=${a.bitrate}${clipQuery}`;
      return `
        <tr>
          <td><strong>${a.label}</strong> <span class="quality-badge">${a.ext}</span></td>
          <td>${a.desc}</td>
          <td>44.1 kHz Stereo</td>
          <td>${formatBytes(estBytes)}</td>
          <td style="text-align: right;">
            <a href="${dlHref}" class="format-item-btn mp3" data-label="${a.label} ${a.ext}">
              &#9835; Extract ${a.ext}
            </a>
          </td>
        </tr>
      `;
    }).join('');

    formatTableContainer.innerHTML = `
      <table class="format-table">
        <thead>
          <tr>
            <th>Bitrate</th>
            <th>Audio Profile</th>
            <th>Sample Rate</th>
            <th>Est. Size</th>
            <th style="text-align: right;">Action</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
  } else if (activeTab === 'preview') {
    if (currentMediaData.embed_url) {
      formatTableContainer.innerHTML = `
        <div class="preview-box">
          <iframe src="${currentMediaData.embed_url}" allowfullscreen allow="autoplay; encrypted-media"></iframe>
          <p style="margin-top: 10px; font-size: 0.82rem; color: #475569;">
            Official Embedded Stream Player &bull; Use this preview to find exact timestamps for the Clip Trimmer above.
          </p>
        </div>
      `;
    } else if (currentMediaData.direct_media_url) {
      formatTableContainer.innerHTML = `
        <div class="preview-box">
          <video src="${currentMediaData.direct_media_url}" controls style="width:100%;max-height:360px;border-radius:8px;"></video>
        </div>
      `;
    } else {
      formatTableContainer.innerHTML = `
        <div class="preview-box">
          <p style="margin-bottom: 12px;">Direct iframe embed is restricted by this host, but you can open the source stream directly:</p>
          <a href="${currentUrl}" target="_blank" rel="noopener" class="format-item-btn mp3">Open Source Stream in New Tab &rarr;</a>
        </div>
      `;
    }
  } else if (activeTab === 'thumbnails') {
    const thumbs = currentMediaData.thumbnails?.length
      ? currentMediaData.thumbnails
      : currentMediaData.thumbnail
      ? [{ label: 'Primary Cover Frame', url: currentMediaData.thumbnail }]
      : [];

    if (thumbs.length === 0) {
      formatTableContainer.innerHTML = `<p style="padding:14px;color:#64748b;">No public thumbnail frames detected for this URL.</p>`;
    } else {
      const rowsHtml = thumbs.map(t => `
        <tr>
          <td><strong>${t.label}</strong> <span class="quality-badge">JPG / WEBP</span></td>
          <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.url}</td>
          <td style="text-align: right;">
            <a href="${t.url}" target="_blank" rel="noopener" class="format-item-btn secondary">
              &#128444; View / Save Image
            </a>
          </td>
        </tr>
      `).join('');

      formatTableContainer.innerHTML = `
        <table class="format-table">
          <thead>
            <tr>
              <th>Artwork Variant</th>
              <th>Source CDN URL</th>
              <th style="text-align: right;">Action</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `;
    }
  } else if (activeTab === 'metadata') {
    const subs = currentMediaData.subtitles || ['en'];
    const subButtons = subs.map(lang => {
      const dlHref = `/api/download?url=${encodeURIComponent(currentUrl)}&type=subtitles&lang=${encodeURIComponent(lang)}`;
      return `<a href="${dlHref}" class="format-item-btn secondary">&#8681; Download .SRT (${lang.toUpperCase()})</a>`;
    }).join(' ');

    formatTableContainer.innerHTML = `
      <div style="margin-bottom: 14px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
        <strong style="font-size: 0.85rem;">Captions / Subtitles:</strong>
        ${subButtons}
      </div>
      <pre class="json-pre">${JSON.stringify(currentMediaData, null, 2)}</pre>
    `;
  } else if (activeTab === 'qrcode') {
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(currentUrl)}`;
    formatTableContainer.innerHTML = `
      <div class="preview-box">
        <img src="${qrApiUrl}" alt="QR Code" style="width:180px;height:180px;border:1px solid #e2e8f0;padding:8px;background:#fff;border-radius:12px;" />
        <p style="margin-top: 10px; font-size: 0.86rem; font-weight: 600;">
          Scan with your phone camera to open or save this media stream directly on mobile.
        </p>
      </div>
    `;
  }

  formatTableContainer.querySelectorAll('.format-item-btn[data-label]').forEach(btn => {
    btn.addEventListener('click', () => {
      const label = btn.getAttribute('data-label');
      showToast(`Preparing ${label} stream package...`);
    });
  });
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.getAttribute('data-tab');
    renderActiveTab();
  });
});

// Copy & Export JSON Audit
copyJsonBtn?.addEventListener('click', async () => {
  if (!currentMediaData) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(currentMediaData, null, 2));
    showToast('Stream JSON metadata copied to clipboard!');
  } catch {
    showToast('Unable to copy automatically');
  }
});

// 8. History Storage
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
        <img src="${item.thumbnail || 'https://via.placeholder.com/140x80?text=Stream'}" alt="Thumb" />
        <div class="history-item-info">
          <div class="history-item-title">${item.title || 'Media Stream'}</div>
          <div class="history-item-sub">${item.extractor || 'Web'} &bull; ${item.duration || ''}</div>
        </div>
      </div>
    `).join('');

    historyGrid.querySelectorAll('.history-item').forEach(card => {
      card.addEventListener('click', () => {
        const u = decodeURIComponent(card.getAttribute('data-url'));
        singleModeBtn.click();
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
  showToast('Inspection history cleared');
});

renderHistory();

// 9. Single URL Submit Handler
if (downloadForm) {
  downloadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = videoUrlInput.value.trim();
    if (!url) return;

    currentUrl = url;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Inspecting...';
    googleLoader.classList.add('active');
    statusMessage.classList.remove('error');
    statusMessage.textContent = 'Running 3-tier stream inspection (Public API / oEmbed / OpenGraph)...';
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
      engineBadge.textContent = data.engine || 'Multi-Engine Cloud Inspector';
      licenseBadge.textContent = data.license || 'Public Web Stream';
      videoTitle.textContent = data.title || 'Untitled Media';
      videoDurationBadge.textContent = data.duration || 'Stream';
      videoThumb.src = data.thumbnail || 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=640&q=80';
      thumbDownloadBtn.href = data.thumbnail || currentUrl;
      exportJsonBtn.href = `/api/download?url=${encodeURIComponent(currentUrl)}&type=metadata`;

      const chips = [
        `Platform: ${data.extractor || 'Web'}`,
        `Duration: ${data.duration || 'Stream'}`,
        data.uploader ? `Creator: ${data.uploader}` : null,
        data.view_count ? `Views: ${Number(data.view_count).toLocaleString()}` : null,
        data.upload_date ? `Date: ${data.upload_date}` : null
      ].filter(Boolean);

      videoMetaChips.innerHTML = chips.map(c => `<span class="meta-chip">${c}</span>`).join('');

      activeTab = 'muxed';
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-tab') === 'muxed');
      });

      renderActiveTab();
      resultCard.style.display = 'block';
      showToast(`Resolved via ${data.engine}`);

      saveToHistory({
        url,
        title: data.title,
        thumbnail: data.thumbnail,
        extractor: data.extractor,
        duration: data.duration
      });
    } catch (error) {
      statusMessage.classList.add('error');
      statusMessage.textContent = 'Connection error: Please verify your server is running.';
    } finally {
      googleLoader.classList.remove('active');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Inspect & Hunt';
    }
  });
}

// 10. Batch Queue Inspector
runBatchBtn?.addEventListener('click', async () => {
  const lines = (batchInput.value || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    showToast('Please paste at least one URL');
    return;
  }

  runBatchBtn.disabled = true;
  runBatchBtn.textContent = 'Inspecting Queue...';
  batchResults.innerHTML = `<p style="font-size:0.85rem;color:#64748b;">Processing ${lines.length} URL(s) in parallel...</p>`;

  try {
    const res = await fetch('/api/batch-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: lines })
    });
    const data = await res.json();
    if (!data.results) {
      batchResults.innerHTML = `<p style="color:#d93025;">Failed to inspect batch.</p>`;
      return;
    }

    batchResults.innerHTML = data.results.map(item => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:8px;background:#f8fafc;">
        <div style="overflow:hidden;padding-right:12px;">
          <div style="font-weight:700;font-size:0.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.data.title || item.url}</div>
          <div style="font-size:0.75rem;color:#64748b;">${item.data.extractor || 'Web'} &bull; ${item.data.engine || 'Resolved'}</div>
        </div>
        <button type="button" class="format-item-btn batch-load-btn" data-url="${encodeURIComponent(item.url)}">
          Open in Inspector &rarr;
        </button>
      </div>
    `).join('');

    batchResults.querySelectorAll('.batch-load-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const u = decodeURIComponent(btn.getAttribute('data-url'));
        singleModeBtn.click();
        videoUrlInput.value = u;
        detectPlatform(u);
        downloadForm.requestSubmit();
      });
    });
  } catch {
    batchResults.innerHTML = `<p style="color:#d93025;">Error running batch inspection.</p>`;
  } finally {
    runBatchBtn.disabled = false;
    runBatchBtn.textContent = 'Inspect All Links';
  }
});