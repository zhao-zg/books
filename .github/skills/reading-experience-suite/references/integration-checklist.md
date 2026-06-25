# Integration Checklist

## Required files

- `js/speech.js`
- `js/nav-stack.js`
- `js/theme-toggle.js`
- `js/font-control.js`
- `js/reading-suite-init.js`
- `sw.js` with message API: `CACHE_INFO` and `CLEAR_CACHE`

## Required DOM IDs

- `playPauseBtn`
- `rateSelect`
- `progressBar`
- `speechTime`
- `bottomControlBar` (or `speechControls`)
- `btnDownloadApk`
- `btnInstallPwa`
- `btnCacheInfo`
- `btnClearCache`
- `cacheStatus`

## Runtime checks

1. Browser not installed: can see `下载 APK` and `安装 PWA` (if install prompt available).
2. Installed PWA: `安装 PWA` hidden, cache buttons visible.
3. Capacitor APK: back button behavior works; cache buttons visible.
4. Content page: TTS can read extracted text.
5. Clear cache: click button and cache count updates.
