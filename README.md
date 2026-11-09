# VideoHunt

**VideoHunt** is a high-speed, local-first web application for inspecting and downloading publicly accessible video and audio streams. Built with Node.js, Express, React 18, `yt-dlp`, and `ffmpeg`, it streams progressive H.264 MP4 video and MP3 audio directly into your browser's native download manager with parallel byte-range prefetching.



## Core Capabilities

- **Instant Browser Download Start**: Flushes `Content-Disposition: attachment` headers immediately so downloads appear in the browser download bar at 0 seconds.
- **Parallel Range-Chunk Accelerator**: Bypasses single-connection CDN throttling by fetching 8 MB byte-range windows with parallel read-ahead prefetching and automatic chunk retry.
- **Real-Time Quality Verification**: Inspects live stream manifests to display only the actual video resolutions (`4K`, `1440p`, `1080p`, `720p`, `480p`, `360p`, `240p`, `144p`) and file sizes available for each link.
- **On-the-Fly FFmpeg Muxing**: Merges separate high-definition DASH video and audio tracks and transcodes MP3 audio streams in real time via local loopback chunk proxying.



## Quick Start

1. Install dependencies:
   npm install

2. Start the server:
   npm start

3. Open http://localhost:3000 in your browser.



## Privacy Policy

- **Zero Personal Data Collection**: VideoHunt operates locally without user accounts, registration, cookies, analytics trackers, or telemetry.
- **Ephemeral In-Memory Processing**: Submitted URLs are cached temporarily in volatile memory (`LruCache`) solely to resolve stream metadata and are automatically purged upon expiration.
- **Direct Stream Piping**: Media streams are piped directly from the source CDN to your browser's download manager without permanent server-side storage or logging.



## Legal Disclaimer

- **Authorized & Educational Use Only**: VideoHunt is provided strictly as a local educational utility for downloading user-owned media, Public Domain works, Creative Commons content, or material for which the user holds explicit permission from the copyright owner.
- **No DRM Circumvention**: VideoHunt processes only publicly accessible HTTP/HTTPS streams and does not decrypt, strip, or bypass Digital Rights Management (DRM), paywalls, or private authentication gates.
- **Limitation of Liability**: This software is provided *"AS IS"* without warranties of any kind. The end user assumes full legal responsibility for complying with applicable copyright laws and the Terms of Service of any third-party website accessed through this tool.



## License

This project is licensed under the [MIT License](LICENSE).
