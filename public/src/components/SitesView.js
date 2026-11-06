import React, { useState, useMemo } from 'react';
import { html, SearchIcon } from './Icons.js';

export default function SitesView({ sitesCatalog, onSelectSite }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');

  // filter and sort all sites in strict alphabetical order
  const filteredSites = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sitesCatalog
      .filter(item => {
        const catOk = selectedCategory === 'all' || item.category === selectedCategory;
        const queryOk = !q || item.name.toLowerCase().includes(q) || item.label.toLowerCase().includes(q);
        return catOk && queryOk;
      })
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );
  }, [sitesCatalog, searchQuery, selectedCategory]);

  return html`
    <div>
      <div className="search-box-wrap">
        <div className="google-omnibox">
          <${SearchIcon} />
          <input
            type="text"
            className="omnibox-input"
            value=${searchQuery}
            onChange=${e => setSearchQuery(e.target.value)}
            placeholder="Search sites or converters (e.g. YouTube, Instagram, Dailymotion, Vimeo, MP3)..."
            autoComplete="off"
            spellCheck="false"
          />
        </div>
      </div>

      <div className="category-filter-bar">
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
          <span className="sites-section-title">All resources (A–Z)</span>
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