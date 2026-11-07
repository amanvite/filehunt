(function () {
  const FH = (window.FH = window.FH || {});
  const { useState, useRef } = window.React;
  const html = FH.html;

  FH.App = function App() {
    const [activeView, setActiveView] = useState('home');
    const [selectedSite, setSelectedSite] = useState(null);
    const [inputUnlocked, setInputUnlocked] = useState(false);

    const {
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
    } = FH.useMediaInspector();

    const inputRef = useRef(null);

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
              <${FH.BrandDownloadIcon} />
            </span>
            <span className="brand-name">FileHunt</span>
          </a>
        </div>
        <h1 className="page-subtitle">${subtitle}</h1>
      </div>
    `;

    return html`
      <div style=${{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <main className="app-container">

          ${activeView === 'home' && html`
            <section className="view-panel active">
              <${BrandHeader}
                subtitle=${selectedSite ? `${selectedSite} Video Downloader` : 'Free Online Video Downloader'}
              />

              <div className="search-box-wrap">
                <form className="google-omnibox" onSubmit=${handleFormSubmit} autoComplete="off" noValidate>
                  <${FH.SearchIcon} />
                  <input
                    ref=${inputRef}
                    type="text"
                    inputMode="url"
                    name="fh_stream_target_field"
                    className="omnibox-input"
                    value=${urlInput}
                    readOnly=${!inputUnlocked}
                    onFocus=${() => setInputUnlocked(true)}
                    onChange=${e => setUrlInput(e.target.value)}
                    placeholder=${selectedSite ? `Paste your ${selectedSite} link here` : 'Paste your video link here'}
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
                  <button type="submit" className="omnibox-submit-btn" disabled=${isLoading}>
                    ${isLoading ? 'Loading...' : 'Download'}
                  </button>
                </form>

                <p className="prohibition-notice">
                  Downloading any copyrighted materials is strictly prohibited, please read our${' '}
                  <a onClick=${() => switchView('terms')}>Terms of Service</a>.
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

              ${mediaData && FH.InspectorCard && html`
                <${FH.InspectorCard}
                  mediaData=${mediaData}
                  sourceUrl=${inspectedUrl}
                  onDownloadApology=${msg => setApologyText(msg)}
                />
              `}

              <div className="seo-description-block">
                <p>
                  Want to save your favorite videos for offline viewing? Our powerful ${selectedSite || 'online'} video downloader provides exactly what you're looking for. Get high-quality downloads with rapid processing through a simple and intuitive interface. Our free ${selectedSite || 'FileHunt'} downloader offers ultimate convenience for every user.
                </p>
                <p>
                  Need a dependable ${selectedSite || 'video'} downloader? You've discovered the ideal solution. Our optimized video downloader lets you save authorized, public-domain, and creator-owned videos straight to your device with complete convenience and reliable performance. Choose our top-rated ${selectedSite || 'FileHunt'} downloader for professional-quality results each time.
                </p>
              </div>
            </section>
          `}

          ${activeView === 'sites' && html`
            <section className="view-panel active">
              <${BrandHeader} subtitle="Supported Sites & Format Converters" />
              <${FH.SitesView} sitesCatalog=${sitesCatalog} onSelectSite=${handleSelectSite} />
            </section>
          `}

          ${activeView === 'terms' && html`
            <section className="view-panel active">
              <${BrandHeader} subtitle="Terms of Service & Legal Disclaimer" />
              <${FH.LegalView}
                metaLeft="Document: Binding Terms of Service & Liability Waiver"
                metaRight="Effective Date: November 2026"
                clauses=${FH.TERMS_CLAUSES}
              />
            </section>
          `}

          ${activeView === 'privacy' && html`
            <section className="view-panel active">
              <${BrandHeader} subtitle="Privacy Policy & Data Handling" />
              <${FH.LegalView}
                metaLeft="Architecture: Stateless Zero-Log Processing"
                metaRight="Compliance: DPDP Act (India) • GDPR • CCPA"
                clauses=${FH.PRIVACY_CLAUSES}
              />
            </section>
          `}

        </main>

        <footer className="app-footer">
          <div className="footer-short-divider"></div>
          <nav className="footer-nav-links">
            <a
              className=${activeView === 'home' ? 'active-link' : ''}
              onClick=${() => switchView('home')}
            >
              Home
            </a>
            <a
              className=${activeView === 'sites' ? 'active-link' : ''}
              onClick=${() => switchView('sites')}
            >
              Sites
            </a>
            <a
              className=${activeView === 'terms' ? 'active-link' : ''}
              onClick=${() => switchView('terms')}
            >
              Terms of Service
            </a>
            <a
              className=${activeView === 'privacy' ? 'active-link' : ''}
              onClick=${() => switchView('privacy')}
            >
              Privacy Policy
            </a>
          </nav>
          <div className="footer-copyright">© 2026 FileHunt. All rights reserved.</div>
        </footer>
      </div>
    `;
  };
})();