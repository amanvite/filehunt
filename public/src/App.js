import React, { useState, useEffect, useRef } from 'react';
import { html, BrandDownloadIcon, SearchIcon } from './components/Icons.js';
import InspectorCard from './components/InspectorCard.js';
import SitesView from './components/SitesView.js';
import LegalView from './components/LegalView.js';
import {
  CORE_SITES_DATA,
  createExtractorEntry,
  TERMS_CLAUSES,
  PRIVACY_CLAUSES
} from './data/sitesData.js';

export default function App() {
  const [activeView, setActiveView] = useState('home');
  const [selectedSite, setSelectedSite] = useState(null);
  const [urlInput, setUrlInput] = useState('');
  const [inputUnlocked, setInputUnlocked] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [isError, setIsError] = useState(false);
  const [mediaData, setMediaData] = useState(null);
  const [inspectedUrl, setInspectedUrl] = useState('');
  const [sitesCatalog, setSitesCatalog] = useState(CORE_SITES_DATA);

  const inputRef = useRef(null);

  // load supported extractors list from backend on mount
  useEffect(() => {
    fetch('/api/extractors')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data.extractors)) {
          const seen = new Set(CORE_SITES_DATA.map(s => s.label.toLowerCase()));
          const extra = data.extractors
            .filter(name => !seen.has(name.toLowerCase()))
            .map(createExtractorEntry);
          setSitesCatalog([...CORE_SITES_DATA, ...extra]);
        }
      })
      .catch(() => {});
  }, []);

  // switch views smoothly without altering the browser URL
  const switchView = (viewName) => {
    setActiveView(viewName);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // handle choosing a specific platform from the Sites view
  const handleSelectSite = (siteLabel) => {
    setSelectedSite(siteLabel);
    switchView('home');
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  // inspect video link and load stream options
  const handleInspectSubmit = async (e) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) {
      inputRef.current?.focus();
      return;
    }

    setIsLoading(true);
    setIsError(false);
    setStatusText('Inspecting available video and audio streams...');
    setMediaData(null);

    try {
      const res = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed })
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setIsError(true);
        setStatusText(data.error || 'Unable to process this link. Verify the URL and try again.');
        return;
      }

      setStatusText('');
      setInspectedUrl(trimmed);
      setMediaData(data);
    } catch {
      setIsError(true);
      setStatusText('Network error: make sure node server.js is running.');
    } finally {
      setIsLoading(false);
    }
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
              <form className="google-omnibox" onSubmit=${handleInspectSubmit} autoComplete="off" noValidate>
                <${SearchIcon} />
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
                      setUrlInput('');
                      setMediaData(null);
                      setStatusText('');
                      inputRef.current?.focus();
                    }}
                  >
                    ×
                  </button>
                `}
                <button type="submit" className="omnibox-submit-btn" disabled=${isLoading}>
                  ${isLoading ? 'Processing...' : 'Download'}
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
              ${statusText && html`
                <div className=${`status-banner ${isError ? 'error' : ''}`}>${statusText}</div>
              `}
            </div>

            <${InspectorCard}
              mediaData=${mediaData}
              sourceUrl=${inspectedUrl}
              onDownloadStart=${(msg, isErr = false) => {
                setIsError(Boolean(isErr));
                setStatusText(msg);
              }}
            />

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
            <${SitesView} sitesCatalog=${sitesCatalog} onSelectSite=${handleSelectSite} />
          </section>
        `}

        ${activeView === 'terms' && html`
          <section className="view-panel active">
            <${BrandHeader} subtitle="Terms of Service & Legal Disclaimer" />
            <${LegalView}
              metaLeft="Document: Binding Terms of Service & Liability Waiver"
              metaRight="Effective Date: November 2026"
              clauses=${TERMS_CLAUSES}
            />
          </section>
        `}

        ${activeView === 'privacy' && html`
          <section className="view-panel active">
            <${BrandHeader} subtitle="Privacy Policy & Data Handling" />
            <${LegalView}
              metaLeft="Architecture: Stateless Zero-Log Processing"
              metaRight="Compliance: DPDP Act (India) • GDPR • CCPA"
              clauses=${PRIVACY_CLAUSES}
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
          <a href="https://github.com/amanvite" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </nav>
        <div className="footer-copyright">© 2026 FileHunt. All rights reserved.</div>
      </footer>
    </div>
  `;
}