import React, { useState, useEffect } from 'react';
import { html } from './Icons.js';

function buildPrepareHref({ url, title, type = 'mp4', resolution = 720, bitrate = 192 }) {
  const params = new URLSearchParams({
    url,
    title: title || 'Video',
    type,
    resolution: String(resolution),
    bitrate: String(bitrate),
    prepare: '1'
  });
  return `/api/download?${params.toString()}`;
}

export default function InspectorCard({ mediaData, sourceUrl, onDownloadApology }) {
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
  const [busyKey, setBusyKey] = useState(null);

  useEffect(() => {
    const firstVideo = mediaData?.videoFormats?.[0]?.resolution || mediaData?.resolutions?.[0];
    const firstAudio = mediaData?.audioFormats?.[0]?.bitrate;
    if (firstVideo) setSelectedPreset(`mp4:${firstVideo}`);
    else if (firstAudio) setSelectedPreset(`mp3:${firstAudio}`);
    setThumbFailed(false);
    setBusyKey(null);
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

  const handleDownloadClick = async (e, paramsObj, keyId) => {
    e.preventDefault();
    if (busyKey) return;

    setBusyKey(keyId);
    onDownloadApology('');

    try {
      const prepUrl = buildPrepareHref(paramsObj);
      const res = await fetch(prepUrl);
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok || !data.downloadUrl) {
        onDownloadApology(
          data.apology ||
            'We apologize, but FileHunt is unable to extract a downloadable video from this link right now. Please try another link or resolution.'
        );
        return;
      }

      const a = document.createElement('a');
      a.href = data.downloadUrl;
      a.download = data.filename || `${mediaData.title || 'video'}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      onDownloadApology(
        'We apologize, but FileHunt could not complete the download for this video right now.'
      );
    } finally {
      setBusyKey(null);
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
                  <span>${mediaData.extractor || 'VIDEO'}</span>
                </div>
              `}
          <span className="media-duration-pill">${mediaData.duration || 'Video'}</span>
        </div>

        <div className="media-summary-col">
          <h3 className="media-heading">${mediaData.title || 'Video Stream'}</h3>

          <div className="media-badge-row">
            ${mediaData.extractor && html`<span className="meta-pill">Source: ${mediaData.extractor}</span>`}
            ${mediaData.uploader && html`<span className="meta-pill">Channel: ${mediaData.uploader}</span>`}
            <span className="meta-pill">Duration: ${mediaData.duration || 'Video'}</span>
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
              href="#download"
              className="btn-download-main"
              style=${{ opacity: busyKey ? 0.65 : 1, pointerEvents: busyKey ? 'none' : 'auto' }}
              onClick=${e => handleDownloadClick(e, primaryParams, 'primary')}
            >
              ${busyKey === 'primary' ? 'Preparing...' : 'Download Now'}
            </a>
          </div>
        </div>
      </div>

      <table className="stream-matrix-table" style=${{ marginTop: '14px' }}>
        <thead>
          <tr>
            <th>Format & Quality</th>
            <th>Container / Codec</th>
            <th>Size / Compatibility</th>
            <th style=${{ textAlign: 'right' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          ${videoFormats.map(vf => {
            const res = vf.resolution;
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
              <tr key=${rowKey}>
                <td>
                  <strong>MP4 ${res}p</strong>
                  <span className="res-tag">${badge}</span>
                </td>
                <td>${vf.codec || 'Video (H.264 + AAC)'}</td>
                <td>${vf.sizeText ? `${vf.sizeText} • Windows / Mac / Mobile` : 'Windows / Mac / Mobile'}</td>
                <td style=${{ textAlign: 'right' }}>
                  <a
                    href="#download"
                    className="table-dl-btn"
                    style=${{ opacity: busyKey ? 0.65 : 1, pointerEvents: busyKey ? 'none' : 'auto' }}
                    onClick=${e => handleDownloadClick(e, rowParams, rowKey)}
                  >
                    ${busyKey === rowKey ? 'Preparing...' : 'Download MP4'}
                  </a>
                </td>
              </tr>
            `;
          })}

          ${audioFormats.map(item => {
            const rowParams = { url: sourceUrl, title: mediaData.title, type: 'mp3', bitrate: item.bitrate };
            const rowKey = `mp3-${item.bitrate}`;
            return html`
              <tr key=${rowKey}>
                <td>
                  <strong>MP3 ${item.label}</strong>
                  <span className="res-tag audio-tag">AUDIO</span>
                </td>
                <td>${item.desc}</td>
                <td>All Media Players</td>
                <td style=${{ textAlign: 'right' }}>
                  <a
                    href="#download"
                    className="table-dl-btn audio-dl-btn"
                    style=${{ opacity: busyKey ? 0.65 : 1, pointerEvents: busyKey ? 'none' : 'auto' }}
                    onClick=${e => handleDownloadClick(e, rowParams, rowKey)}
                  >
                    ${busyKey === rowKey ? 'Preparing...' : 'Download MP3'}
                  </a>
                </td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    </div>
  `;
}