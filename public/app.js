(function () {
  const { useState, useEffect, useRef, useMemo, useCallback } = window.React;
  const html = window.htm.bind(window.React.createElement);

  // 1. Vector Icon Components
  const BrandDownloadIcon = () => html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  `;

  const SearchButtonIcon = () => html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7"></circle>
      <line x1="20" y1="20" x2="16.2" y2="16.2"></line>
    </svg>
  `;

  const YouTubeIcon = () => html`
    <svg viewBox="0 0 24 24">
      <path d="M21.58 7.19c-.23-.86-.91-1.54-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.81.42c-.86.23-1.54.91-1.77 1.77C2 8.75 2 12 2 12s0 3.25.42 4.81c.23.86.91 1.54 1.77 1.77C5.75 19 12 19 12 19s6.25 0 7.81-.42c.86-.23 1.54-.91 1.77-1.77C22 15.25 22 12 22 12s0-3.25-.42-4.81zM10 15V9l5.2 3-5.2 3z" />
    </svg>
  `;

  const InstagramIcon = () => html`
    <svg viewBox="0 0 24 24">
      <path d="M7.8 2h8.4C19.4 2 22 4.6 22 7.8v8.4a5.8 5.8 0 0 1-5.8 5.8H7.8C4.6 22 2 19.4 2 16.2V7.8A5.8 5.8 0 0 1 7.8 2zm-.2 2A3.6 3.6 0 0 0 4 7.6v8.8C4 18.39 5.61 20 7.6 20h8.8a3.6 3.6 0 0 0 3.6-3.6V7.6C20 5.61 18.39 4 16.4 4H7.6zm9.65 1.5a1.25 1.25 0 0 1 1.25 1.25A1.25 1.25 0 0 1 17.25 8 1.25 1.25 0 0 1 16 6.75a1.25 1.25 0 0 1 1.25-1.25zM12 7a5 5 0 0 1 5 5 5 5 0 0 1-5 5 5 5 0 0 1-5-5 5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />
    </svg>
  `;

  const FacebookIcon = () => html`
    <svg viewBox="0 0 24 24">
      <path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c5.05-.5 9-4.76 9-9.95z" />
    </svg>
  `;

  const TikTokIcon = () => html`
    <svg viewBox="0 0 24 24">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z" />
    </svg>
  `;

  // 2. Static Catalog
  const CORE_SITES_DATA = [
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
    { name: 'x.com', label: 'Twitter', badge: 'X', color: 'dark', category: 'social' },
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

  const BADGE_COLOR_PALETTE = ['blue', 'sky', 'vk', 'dark', 'orange', 'red', 'slate', 'green', 'purple'];

  function createExtractorEntry(rawName) {
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

  function normalizeClientUrl(rawInput) {
    if (!rawInput) return '';
    const trimmed = String(rawInput).trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
    return trimmed;
  }

  function detectHostLabel(rawInput) {
    if (!rawInput || rawInput.trim().length < 4) return null;
    try {
      const parsed = new URL(normalizeClientUrl(rawInput));
      if (!parsed.hostname.includes('.')) return null;
      const host = parsed.hostname.replace(/^www\./i, '').split('.')[0];
      if (!host) return null;
      return host.slice(0, 12).toUpperCase();
    } catch {
      return null;
    }
  }

  // 3. Custom Media Inspector Hook
  function useMediaInspector() {
    const [urlInput, setUrlInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [loadingStage, setLoadingStage] = useState('');
    const [apologyText, setApologyText] = useState('');
    const [mediaData, setMediaData] = useState(null);
    const [inspectedUrl, setInspectedUrl] = useState('');
    const [sitesCatalog, setSitesCatalog] = useState(() =>
      [...CORE_SITES_DATA].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      )
    );

    const abortControllerRef = useRef(null);

    useEffect(() => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('apology')) {
        setApologyText(
          'We apologize, but VideoHunt is unable to extract a downloadable video from that link right now. Please try another video URL.'
        );
        window.history.replaceState({}, '', '/');
      }

      fetch('/api/extractors')
        .then(r => r.json())
        .then(data => {
          if (Array.isArray(data.extractors)) {
            const seen = new Set(CORE_SITES_DATA.map(s => s.label.toLowerCase()));
            const extra = data.extractors
              .filter(name => !seen.has(name.toLowerCase()))
              .map(createExtractorEntry);
            const mergedSorted = [...CORE_SITES_DATA, ...extra].sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
            );
            setSitesCatalog(mergedSorted);
          }
        })
        .catch(() => {});

      return () => {
        abortControllerRef.current?.abort();
      };
    }, []);

    const inspectUrl = useCallback(async (rawUrl) => {
      const normalized = normalizeClientUrl(rawUrl);
      if (!normalized) return false;

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setIsLoading(true);
      setLoadingStage('Connecting to media source & inspecting available streams...');
      setApologyText('');
      setMediaData(null);

      const stageTimer = setTimeout(() => {
        setLoadingStage('Deep-scanning video qualities & verifying H.264 stream tracks...');
      }, 2800);

      try {
        const res = await fetch('/api/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: normalized }),
          signal: controller.signal
        });

        const data = await res.json().catch(() => null);
        const hasStreams =
          (Array.isArray(data?.videoFormats) && data.videoFormats.length > 0) ||
          (Array.isArray(data?.resolutions) && data.resolutions.length > 0);

        if (!res.ok || data?.error || !hasStreams) {
          setApologyText(
            data?.error ||
              'We apologize, but VideoHunt could not find any downloadable video streams on this link. Please verify that the URL points directly to a public video.'
          );
          return false;
        }

        setInspectedUrl(data.normalizedUrl || normalized);
        setMediaData(data);
        return true;
      } catch (err) {
        if (err.name === 'AbortError') return false;
        setApologyText(
          err.message ||
            'We apologize, but VideoHunt is temporarily unable to reach this video source.'
        );
        return false;
      } finally {
        clearTimeout(stageTimer);
        setIsLoading(false);
        setLoadingStage('');
      }
    }, []);

    const resetInspector = useCallback(() => {
      abortControllerRef.current?.abort();
      setUrlInput('');
      setMediaData(null);
      setApologyText('');
      setIsLoading(false);
      setLoadingStage('');
    }, []);

    return {
      urlInput,
      setUrlInput,
      isLoading,
      loadingStage,
      apologyText,
      setApologyText,
      mediaData,
      inspectedUrl,
      sitesCatalog,
      inspectUrl,
      resetInspector
    };
  }

  // 4. Studio Media Card Component
  function buildDirectDownloadHref({ url, title, type = 'mp4', resolution = 720, bitrate = 192 }) {
    const params = new URLSearchParams({
      url,
      title: title || 'Video',
      type,
      resolution: String(resolution),
      bitrate: String(bitrate)
    });
    return `/api/download?${params.toString()}`;
  }

  function InspectorCard({ mediaData, sourceUrl }) {
    const videoFormats = Array.isArray(mediaData?.videoFormats)
      ? mediaData.videoFormats
      : (mediaData?.resolutions || []).map(r => ({
          resolution: r,
          ext: 'mp4',
          codec: 'Video (H.264 + AAC)',
          sizeText: null
        }));

    const audioFormats = Array.isArray(mediaData?.audioFormats) ? mediaData.audioFormats : [];

    const defaultPreset = videoFormats.length > 0
      ? `mp4:${videoFormats[0].resolution}`
      : audioFormats.length > 0
      ? `mp3:${audioFormats[0].bitrate}`
      : '';

    const [selectedPreset, setSelectedPreset] = useState(defaultPreset);
    const [thumbFailed, setThumbFailed] = useState(false);

    useEffect(() => {
      const firstVideo = mediaData?.videoFormats?.[0]?.resolution || mediaData?.resolutions?.[0];
      const firstAudio = mediaData?.audioFormats?.[0]?.bitrate;
      if (firstVideo) setSelectedPreset(`mp4:${firstVideo}`);
      else if (firstAudio) setSelectedPreset(`mp3:${firstAudio}`);
      setThumbFailed(false);
    }, [mediaData]);

    if (!mediaData || (videoFormats.length === 0 && audioFormats.length === 0)) return null;

    const [selType, selVal] = selectedPreset.split(':');
    const primaryParams =
      selType === 'mp3'
        ? { url: sourceUrl, title: mediaData.title, type: 'mp3', bitrate: selVal }
        : { url: sourceUrl, title: mediaData.title, type: 'mp4', resolution: selVal };

    const proxiedThumb = mediaData.thumbnail
      ? `/api/proxy-image?url=${encodeURIComponent(mediaData.thumbnail)}`
      : '';

    return html`
      <div className="inspector-card">
        <div className="inspector-top">
          <div className="media-artwork">
            ${proxiedThumb && !thumbFailed
              ? html`
                  <img
                    src=${proxiedThumb}
                    alt=${mediaData.title}
                    onError=${() => setThumbFailed(true)}
                  />
                `
              : html`
                  <div className="thumb-fallback">
                    <span>${mediaData.extractor || 'HD STREAM'}</span>
                  </div>
                `}
            <span className="media-duration-pill">${mediaData.duration || 'HD Video'}</span>
          </div>

          <div className="media-summary-col">
            <h3 className="media-heading">${mediaData.title || 'Video Stream'}</h3>

            <div className="media-badge-row">
              ${mediaData.extractor && html`<span className="meta-pill">Source: ${mediaData.extractor}</span>`}
              ${mediaData.uploader && html`<span className="meta-pill">Channel: ${mediaData.uploader}</span>`}
              <span className="meta-pill verified">
                ${videoFormats.length} Verified ${videoFormats.length === 1 ? 'Quality' : 'Qualities'}
              </span>
            </div>

            <div className="primary-action-bar">
              <select
                className="stream-select"
                value=${selectedPreset}
                onChange=${e => setSelectedPreset(e.target.value)}
                aria-label="Select stream quality"
              >
                ${videoFormats.map(
                  vf => html`
                    <option key=${`mp4:${vf.resolution}`} value=${`mp4:${vf.resolution}`}>
                      MP4 ${vf.resolution}p ${vf.sizeText ? `(${vf.sizeText})` : '(H.264)'}
                    </option>
                  `
                )}
                ${audioFormats.map(
                  af => html`
                    <option key=${`mp3:${af.bitrate}`} value=${`mp3:${af.bitrate}`}>
                      MP3 Audio (${af.label})
                    </option>
                  `
                )}
              </select>

              <a
                href=${buildDirectDownloadHref(primaryParams)}
                className="btn-download-main"
                download
              >
                Download Now
              </a>
            </div>
          </div>
        </div>

        <div className="stream-group-header">
          <span>Available Video Streams (MP4)</span>
          <span>Codec & Size</span>
        </div>

        <div className="stream-bento-list">
          ${videoFormats.map(vf => {
            const res = vf.resolution;
            const isUhd = res >= 1440;
            const badge =
              res >= 2160
                ? '4K UHD'
                : res >= 1440
                ? '2K QHD'
                : res >= 1080
                ? 'Full HD'
                : res >= 720
                ? 'HD'
                : 'SD';
            const rowParams = { url: sourceUrl, title: mediaData.title, type: 'mp4', resolution: res };
            const rowKey = `mp4-${res}`;
            return html`
              <div key=${rowKey} className="stream-bento-row">
                <div className="stream-row-left">
                  <span className="stream-format-name">MP4 ${res}p</span>
                  <span className=${`res-tag ${isUhd ? 'uhd' : ''}`}>${badge}</span>
                  <span className="stream-spec-meta">${vf.codec || 'Video (H.264 + AAC)'}</span>
                  ${vf.sizeText && html`<span className="size-pill">${vf.sizeText}</span>`}
                </div>

                <a
                  href=${buildDirectDownloadHref(rowParams)}
                  className="table-dl-btn"
                  download
                >
                  Download ${res}p MP4
                </a>
              </div>
            `;
          })}
        </div>

        ${audioFormats.length > 0 && html`
          <div className="stream-group-header" style=${{ marginTop: '20px' }}>
            <span>Direct Audio Extraction (MP3)</span>
            <span>Bitrate Profile</span>
          </div>

          <div className="stream-bento-list">
            ${audioFormats.map(item => {
              const rowParams = { url: sourceUrl, title: mediaData.title, type: 'mp3', bitrate: item.bitrate };
              const rowKey = `mp3-${item.bitrate}`;
              return html`
                <div key=${rowKey} className="stream-bento-row">
                  <div className="stream-row-left">
                    <span className="stream-format-name">MP3 ${item.label}</span>
                    <span className="res-tag audio-tag">AUDIO</span>
                    <span className="stream-spec-meta">${item.desc} • All Media Players</span>
                  </div>

                  <a
                    href=${buildDirectDownloadHref(rowParams)}
                    className="table-dl-btn audio-dl-btn"
                    download
                  >
                    Download MP3
                  </a>
                </div>
              `;
            })}
          </div>
        `}
      </div>
    `;
  }

  // 5. Sites Directory View
  function SitesView({ sitesCatalog, onSelectSite, onBackHome }) {
    const [selectedCategory, setSelectedCategory] = useState('all');

    const filteredSites = useMemo(() => {
      return sitesCatalog
        .filter(item => selectedCategory === 'all' || item.category === selectedCategory)
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        );
    }, [sitesCatalog, selectedCategory]);

    return html`
      <div>
        <div className="category-filter-bar">
          <button
            type="button"
            className="cat-filter-pill"
            onClick=${onBackHome}
          >
            ← Back to Downloader
          </button>
          ${[
            { id: 'all', label: 'All Resources' },
            { id: 'social', label: 'Social & Video' },
            { id: 'converter', label: 'Format Converters' },
            { id: 'extractor', label: 'All Extractors' }
          ].map(cat => html`
            <button
              key=${cat.id}
              type="button"
              className=${`cat-filter-pill ${selectedCategory === cat.id ? 'active' : ''}`}
              onClick=${() => setSelectedCategory(cat.id)}
            >
              ${cat.label}
            </button>
          `)}
        </div>

        <div className="sites-section">
          <div className="sites-section-header">
            <span className="sites-section-title">Supported Sites & Converters (A–Z)</span>
            <span className="sites-count-badge">${filteredSites.length} resources</span>
          </div>

          <div className="unified-sites-grid">
            ${filteredSites.map(item => {
              const IconComp = item.icon;
              return html`
                <a
                  key=${item.name}
                  className="site-grid-item"
                  onClick=${e => {
                    e.preventDefault();
                    onSelectSite(item.label);
                  }}
                >
                  <span className=${`site-icon-badge ${item.color}`}>
                    ${IconComp ? html`<${IconComp} />` : item.badge}
                  </span>
                  <span className="site-label-text">${item.name}</span>
                </a>
              `;
            })}
          </div>
        </div>
      </div>
    `;
  }

  // 6. Root Application Component
  function App() {
    const [activeView, setActiveView] = useState('home');
    const [selectedSite, setSelectedSite] = useState(null);
    const [inputUnlocked, setInputUnlocked] = useState(false);

    const {
      urlInput,
      setUrlInput,
      isLoading,
      loadingStage,
      apologyText,
      mediaData,
      inspectedUrl,
      sitesCatalog,
      inspectUrl,
      resetInspector
    } = useMediaInspector();

    const inputRef = useRef(null);
    const detectedHost = useMemo(() => detectHostLabel(urlInput), [urlInput]);

    const switchView = (viewName) => {
      setActiveView(viewName);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleSelectSite = (siteLabel) => {
      setSelectedSite(siteLabel);
      switchView('home');
      setTimeout(() => inputRef.current?.focus(), 100);
    };

    const handleFormSubmit = async (e) => {
      e.preventDefault();
      if (!urlInput.trim()) {
        inputRef.current?.focus();
        return;
      }
      await inspectUrl(urlInput);
    };

    const BrandHeader = ({ subtitle }) => html`
      <div className="brand-header">
        ${selectedSite && activeView === 'home' && html`
          <div className="active-platform-pill visible">
            <span>${selectedSite} Mode</span>
            <button
              type="button"
              title="Reset to universal mode"
              onClick=${() => setSelectedSite(null)}
            >
              ×
            </button>
          </div>
        `}
        <div>
          <a
            className="brand-identity"
            onClick=${e => {
              e.preventDefault();
              switchView('home');
            }}
          >
            <span className="brand-glyph">
              <${BrandDownloadIcon} />
            </span>
            <span className="brand-name">VideoHunt</span>
          </a>
        </div>
        ${subtitle && html`<h1 className="page-subtitle">${subtitle}</h1>`}
      </div>
    `;

    return html`
      <div style=${{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <main className="app-container">

          ${activeView === 'home' && html`
            <section className="view-panel active">
              <${BrandHeader} subtitle=${selectedSite ? `${selectedSite} Video Downloader` : ''} />

              <div className="search-box-wrap">
                <form className="google-omnibox" onSubmit=${handleFormSubmit} autoComplete="off" noValidate>
                  ${detectedHost && html`
                    <span className="detected-host-tag">${detectedHost}</span>
                  `}
                  <input
                    ref=${inputRef}
                    type="text"
                    inputMode="url"
                    name="vh_stream_target_field"
                    className="omnibox-input"
                    value=${urlInput}
                    readOnly=${!inputUnlocked}
                    onFocus=${() => setInputUnlocked(true)}
                    onChange=${e => setUrlInput(e.target.value)}
                    placeholder=${selectedSite ? `Paste your ${selectedSite} link here` : 'Paste your video link here (e.g. youtube.com/watch?v=...)'}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck="false"
                  />
                  ${urlInput && html`
                    <button
                      type="button"
                      className="omnibox-clear-btn"
                      title="Clear link"
                      onClick=${() => {
                        resetInspector();
                        inputRef.current?.focus();
                      }}
                    >
                      ×
                    </button>
                  `}
                  <button
                    type="submit"
                    className="omnibox-search-btn"
                    title="Search video streams"
                    aria-label="Search video streams"
                    disabled=${isLoading}
                  >
                    ${isLoading
                      ? html`<span className="btn-spinner"></span>`
                      : html`<${SearchButtonIcon} />`}
                  </button>
                </form>

                <p className="supported-sites-notice">
                  Compatible with YouTube, Instagram, X, TikTok, Vimeo, and${' '}
                  <a onClick=${() => switchView('sites')}>170+ platforms</a>.
                </p>
              </div>

              <div className="diagnostics-wrap">
                <div className=${`progress-track ${isLoading ? 'active' : ''}`}>
                  <div className="progress-fill"></div>
                </div>
                ${isLoading && loadingStage && html`
                  <div className="stage-status-pill">${loadingStage}</div>
                `}
                ${apologyText && html`
                  <div className="apology-banner">
                    ${apologyText}
                  </div>
                `}
              </div>

              ${mediaData && html`
                <${InspectorCard}
                  mediaData=${mediaData}
                  sourceUrl=${inspectedUrl}
                />
              `}

              <div className="highlights-bento">
                <div className="highlight-card">
                  <span className="highlight-card-badge">INSTANT STREAM</span>
                  <h3>Zero-Wait Browser Download</h3>
                  <p>Streams directly into your browser's download manager from the first millisecond with continuous packet flushing.</p>
                </div>
                <div className="highlight-card">
                  <span className="highlight-card-badge">H.264 + MP3</span>
                  <h3>Native Player Compatibility</h3>
                  <p>Delivers progressive H.264 MP4 video and 320kbps MP3 audio compatible with Windows, Mac, iOS, and Android.</p>
                </div>
                <div className="highlight-card">
                  <span className="highlight-card-badge">REAL QUALITIES</span>
                  <h3>True Stream Verification</h3>
                  <p>Inspects every video link in real time to display only the genuine resolutions and file sizes available.</p>
                </div>
              </div>

              <div className="seo-description-block">
                <p>
                  Want to save your favorite videos for offline viewing? Our powerful ${selectedSite || 'online'} video downloader provides exactly what you're looking for. Get high-quality downloads with rapid processing through a simple and intuitive interface. Our free ${selectedSite || 'VideoHunt'} downloader offers ultimate convenience for every user.
                </p>
                <p>
                  Need a dependable ${selectedSite || 'video'} downloader? You've discovered the ideal solution. Our optimized video downloader lets you save authorized, public-domain, and creator-owned videos straight to your device with complete convenience and reliable performance. Choose our top-rated ${selectedSite || 'VideoHunt'} downloader for professional-quality results each time.
                </p>
              </div>
            </section>
          `}

          ${activeView === 'sites' && html`
            <section className="view-panel active">
              <${BrandHeader} subtitle="Supported Sites & Format Converters" />
              <${SitesView}
                sitesCatalog=${sitesCatalog}
                onSelectSite=${handleSelectSite}
                onBackHome=${() => switchView('home')}
              />
            </section>
          `}

        </main>

        <footer className="app-footer">
          <div className="footer-short-divider"></div>
          <div className="footer-copyright">© 2026 VideoHunt. All rights reserved.</div>
        </footer>
      </div>
    `;
  }

  // 7. Mount Application
  const container = document.getElementById('root');
  if (container) {
    const root = window.ReactDOM.createRoot(container);
    root.render(html`<${App} />`);
  }
})();