import { useState, useEffect, useRef, useCallback } from 'react';
import { CORE_SITES_DATA, createExtractorEntry } from '../data/sitesData.js';

// custom React hook managing stream inspection, abort controllers, and extractor catalog hydration
export function useMediaInspector() {
  const [urlInput, setUrlInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
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
        'We apologize, but FileHunt is unable to extract a downloadable video from that link right now. Please try another video URL.'
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
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return false;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setApologyText('');
    setMediaData(null);

    try {
      const res = await fetch('/api/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
        signal: controller.signal
      });

      const rawText = await res.text();
      let data = null;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(
          'We apologize, but FileHunt could not read this link right now. Please check the URL and try again.'
        );
      }

      if (!res.ok || data.error) {
        setApologyText(
          data.error ||
            'We apologize, but FileHunt is unable to process this link right now. Please verify the URL and try again.'
        );
        return false;
      }

      setInspectedUrl(trimmed);
      setMediaData(data);
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      setApologyText(
        err.message ||
          'We apologize, but FileHunt is temporarily unable to reach this video source.'
      );
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const resetInspector = useCallback(() => {
    abortControllerRef.current?.abort();
    setUrlInput('');
    setMediaData(null);
    setApologyText('');
    setIsLoading(false);
  }, []);

  return {
    urlInput,
    setUrlInput,
    isLoading,
    apologyText,
    setApologyText,
    mediaData,
    inspectedUrl,
    sitesCatalog,
    inspectUrl,
    resetInspector
  };
}