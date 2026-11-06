import React, { useState, useEffect } from 'react';
import { html } from './Icons.js';

// build downloadable endpoint with the actual video title attached
function buildDownloadHref({ url, title, type = 'mp4', resolution = 720, bitrate = 192, lang = 'en' }) {
  const params = new URLSearchParams({
    url,
    title: title || 'Video',
    type,
    resolution: String(resolution),
    bitrate: String(bitrate),
    lang
  });
  return `/api/download?${params.toString()}`;
}

export default function InspectorCard({ mediaData, sourceUrl, onDownloadStart }) {
  const resolutions = mediaData?.resolutions?.length ? mediaData.resolutions : [1080, 720, 480, 360];
  const [selectedPreset, setSelectedPreset] = useState(`mp4:${resolutions[0]}`);
  const [activeTab, setActiveTab] = useState('video');
  const [thumbFailed, setThumbFailed] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState(null);

  useEffect(() => {
    const topRes = mediaData?.resolutions?.[0] || 1080;
    setSelectedPreset(`mp4:${topRes}`);
    setActiveTab('video');
    setThumbFailed(false);
    setDownloadingKey(null);
  }, [mediaData]);

  if (!mediaData) return null;

  const [selType, selVal] = selectedPreset.split(':');
  const primaryHref =
    selType === 'mp3'
      ? buildDownloadHref({ url: sourceUrl, title: mediaData.title, type: 'mp3', bitrate: selVal })
      : buildDownloadHref({ url: sourceUrl, title: mediaData.title, type: 'mp4', resolution: selVal });

  const proxiedThumb = mediaData.thumbnail
    ? `/api/proxy-image?url=${encodeURIComponent(mediaData.thumbnail)}`
    : '';

  // handle file download without navigating the browser tab away to a raw error screen
  const triggerSafeDownload = async (e, downloadHref, labelKey, statusLabel) => {
    e.preventDefault();
    if (downloadingKey) return;

    setDownloadingKey(labelKey);
    onDownloadStart(statusLabel, false);

    try {
      const response = await fetch(downloadHref);
      const contentType = response.headers.get('content-type') || '';

      if (!response.ok || contentType.includes('application/json')) {
        const errData = await response.json().catch(() => ({}));
        onDownloadStart(
          errData.error || 'Could not extract a playable video stream from this page.',
          true
        );
        setDownloadingKey(null);
        return;
      }

      // extract filename from Content-Disposition header
      const disposition = response.headers.get('content-disposition') || '';
      const nameMatch = disposition.match(/filename="([^"]+)"/i);
      const fileName = nameMatch ? nameMatch[1] : `${mediaData.title || 'video'}.mp4`;

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      onDownloadStart(`Saved "${fileName}" to your downloads.`, false);
    } catch {
      onDownloadStart('Download interrupted. Make sure server.js is running.', true);
    } finally {
      setDownloadingKey(null);
    }
  };

  return html`
    <div className="inspector-card" style=${{ display: 'block' }}>
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
                  <span>${mediaData.extractor || 'HD VIDEO'}</span>
                </div>
              `}
          <span className="media-duration-pill">${mediaData.duration || 'HD'}</span>
        </div>

        <div className="media-summary-col">
          <h3 className="media-heading">${mediaData.title || 'Video Stream'}</h3>

          <div className="media-badge-row">
            ${mediaData.extractor && html`<span className="meta-pill">Platform: ${mediaData.extractor}</span>`}
            ${mediaData.uploader && html`<span className="meta-pill">Creator: ${mediaData.uploader}</span>`}
            <span className="meta-pill">Duration: ${mediaData.duration || 'HD'}</span>
          </div>

          <div className="primary-action-bar">
            <select
              className="stream-select"
              value=${selectedPreset}
              onChange=${e => setSelectedPreset(e.target.value)}
              aria-label="Select stream quality"
            >
              ${resolutions.map(
                res => html`<option key=${`mp4:${res}`} value=${`mp4:${res}`}>MP4 ${res}p (H.264)</option>`
              )}
              <option value="mp3:320">MP3 Audio (320kbps)</option>
              <option value="mp3:192">MP3 Audio (192kbps)</option>
            </select>

            <a
              href=${primaryHref}
              className="btn-download-main"
              style=${{ opacity: downloadingKey ? 0.65 : 1, pointerEvents: downloadingKey ? 'none' : 'auto' }}
              onClick=${e =>
                triggerSafeDownload(
                  e,
                  primaryHref,
                  'primary',
                  `Downloading "${mediaData.title}" — preparing file...`
                )}
            >
              ${downloadingKey === 'primary' ? 'Downloading...' : 'Download Now'}
            </a>
          </div>
        </div>
      </div>

      <div className="inspector-tabs">
        <button
          type="button"
          className=${`inspector-tab-btn ${activeTab === 'video' ? 'active' : ''}`}
          onClick=${() => setActiveTab('video')}
        >
          Video Streams (MP4)
        </button>
        <button
          type="button"
          className=${`inspector-tab-btn ${activeTab === 'audio' ? 'active' : ''}`}
          onClick=${() => setActiveTab('audio')}
        >
          Audio Tracks (MP3)
        </button>
        <button
          type="button"
          className=${`inspector-tab-btn ${activeTab === 'subtitles' ? 'active' : ''}`}
          onClick=${() => setActiveTab('subtitles')}
        >
          Subtitles (.SRT)
        </button>
      </div>

      ${activeTab === 'video' &&
      html`
        <table className="stream-matrix-table">
          <thead>
            <tr>
              <th>Quality</th>
              <th>Container & Codec</th>
              <th>Compatibility</th>
              <th style=${{ textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            ${resolutions.map(res => {
              const badge = res >= 2160 ? '4K UHD' : res >= 1440 ? '2K QHD' : res >= 1080 ? 'Full HD' : res >= 720 ? 'HD' : 'SD';
              const dlUrl = buildDownloadHref({ url: sourceUrl, title: mediaData.title, type: 'mp4', resolution: res });
              const rowKey = `mp4-${res}`;
              return html`
                <tr key=${res}>
                  <td>
                    <strong>${res}p</strong>
                    <span className="res-tag">${badge}</span>
                  </td>
                  <td>MP4 (H.264 + AAC)</td>
                  <td>Windows / Mac / Mobile</td>
                  <td style=${{ textAlign: 'right' }}>
                    <a
                      href=${dlUrl}
                      className="table-dl-btn"
                      onClick=${e =>
                        triggerSafeDownload(
                          e,
                          dlUrl,
                          rowKey,
                          `Downloading "${mediaData.title}" (${res}p MP4)...`
                        )}
                    >
                      ${downloadingKey === rowKey ? 'Saving...' : 'Download MP4'}
                    </a>
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      `}

      ${activeTab === 'audio' &&
      html`
        <table className="stream-matrix-table">
          <thead>
            <tr>
              <th>Bitrate</th>
              <th>Profile</th>
              <th>Sample Rate</th>
              <th style=${{ textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            ${[
              { bitrate: 320, label: '320 kbps', desc: 'Studio Archival MP3' },
              { bitrate: 192, label: '192 kbps', desc: 'High Quality Stereo MP3' },
              { bitrate: 128, label: '128 kbps', desc: 'Standard Portable MP3' }
            ].map(item => {
              const dlUrl = buildDownloadHref({ url: sourceUrl, title: mediaData.title, type: 'mp3', bitrate: item.bitrate });
              const rowKey = `mp3-${item.bitrate}`;
              return html`
                <tr key=${item.bitrate}>
                  <td>
                    <strong>${item.label}</strong>
                    <span className="res-tag">MP3</span>
                  </td>
                  <td>${item.desc}</td>
                  <td>44.1 kHz Stereo</td>
                  <td style=${{ textAlign: 'right' }}>
                    <a
                      href=${dlUrl}
                      className="table-dl-btn"
                      onClick=${e =>
                        triggerSafeDownload(
                          e,
                          dlUrl,
                          rowKey,
                          `Extracting "${mediaData.title}" (${item.label} MP3)...`
                        )}
                    >
                      ${downloadingKey === rowKey ? 'Extracting...' : 'Extract MP3'}
                    </a>
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      `}

      ${activeTab === 'subtitles' &&
      html`
        <table className="stream-matrix-table">
          <thead>
            <tr>
              <th>Language</th>
              <th>Format</th>
              <th>Encoding</th>
              <th style=${{ textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            ${[
              { code: 'en', name: 'English' },
              { code: 'es', name: 'Spanish' },
              { code: 'fr', name: 'French' }
            ].map(l => {
              const dlUrl = buildDownloadHref({ url: sourceUrl, title: mediaData.title, type: 'subtitles', lang: l.code });
              const rowKey = `sub-${l.code}`;
              return html`
                <tr key=${l.code}>
                  <td>
                    <strong>${l.name}</strong>
                    <span className="res-tag">${l.code.toUpperCase()}</span>
                  </td>
                  <td>SubRip Subtitle Track (.SRT)</td>
                  <td>UTF-8 Timed Text</td>
                  <td style=${{ textAlign: 'right' }}>
                    <a
                      href=${dlUrl}
                      className="table-dl-btn"
                      onClick=${e =>
                        triggerSafeDownload(
                          e,
                          dlUrl,
                          rowKey,
                          `Saving ${l.name} subtitles (.SRT)...`
                        )}
                    >
                      Save .SRT
                    </a>
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      `}
    </div>
  `;
}