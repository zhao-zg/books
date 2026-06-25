# Adaptive UI Controls (APK / PWA / Cache)

Use runtime detection to show different action buttons based on environment.

## Goals

- Show `Download APK` in browser (especially Android browser)
- Show `Install PWA` only when install prompt is available and app is not installed
- Show `Cache Data` and `Clear Cache` where Service Worker is available
- Hide irrelevant actions in Capacitor APK app

## HTML

```html
<div class="quick-actions" id="quickActions">
  <button id="btnDownloadApk" hidden>Download APK</button>
  <button id="btnInstallPwa" hidden>Install PWA</button>
  <button id="btnCacheInfo" hidden>Cache Data</button>
  <button id="btnClearCache" hidden>Clear Cache</button>
</div>
<div id="cacheStatus"></div>
```

## JavaScript

```javascript
(function() {
  let deferredInstallPrompt = null;

  const btnDownloadApk = document.getElementById('btnDownloadApk');
  const btnInstallPwa = document.getElementById('btnInstallPwa');
  const btnCacheInfo = document.getElementById('btnCacheInfo');
  const btnClearCache = document.getElementById('btnClearCache');
  const cacheStatus = document.getElementById('cacheStatus');

  function isAndroidBrowser() {
    return /Android/i.test(navigator.userAgent || '');
  }

  function isStandalonePwa() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
  }

  function isCapacitorApp() {
    return Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  function show(el, shouldShow) {
    if (!el) return;
    el.hidden = !shouldShow;
  }

  async function swQuery(type) {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.active) return null;

    return new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data || null);
      reg.active.postMessage({ type }, [channel.port2]);
    });
  }

  async function renderButtons() {
    const capacitor = isCapacitorApp();
    const standalone = isStandalonePwa();
    const androidBrowser = isAndroidBrowser();
    const hasSw = 'serviceWorker' in navigator;

    show(btnDownloadApk, !capacitor && androidBrowser && !standalone);
    show(btnInstallPwa, !capacitor && !standalone && Boolean(deferredInstallPrompt));
    show(btnCacheInfo, hasSw);
    show(btnClearCache, hasSw);
  }

  async function refreshCacheInfo() {
    const info = await swQuery('CACHE_INFO');
    if (!info || !info.ok) {
      cacheStatus.textContent = 'Cache unavailable';
      return;
    }
    cacheStatus.textContent = 'Cached entries: ' + info.entryCount;
  }

  async function clearCache() {
    const result = await swQuery('CLEAR_CACHE');
    if (result && result.ok) {
      await refreshCacheInfo();
      alert('Cache cleared');
    } else {
      alert('Failed to clear cache');
    }
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    renderButtons();
  });

  if (btnInstallPwa) {
    btnInstallPwa.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      renderButtons();
    });
  }

  if (btnDownloadApk) {
    btnDownloadApk.addEventListener('click', () => {
      window.location.href = './latest.apk';
    });
  }

  if (btnCacheInfo) btnCacheInfo.addEventListener('click', refreshCacheInfo);
  if (btnClearCache) btnClearCache.addEventListener('click', clearCache);

  window.addEventListener('load', async () => {
    await renderButtons();
    if ('serviceWorker' in navigator) await refreshCacheInfo();
  });
})();
```

## Button Visibility Matrix

| Environment | Download APK | Install PWA | Cache Data | Clear Cache |
|---|---|---|---|---|
| Android browser (not installed) | Show | Show (if prompt available) | Show | Show |
| Installed PWA | Hide | Hide | Show | Show |
| Capacitor APK app | Hide | Hide | Show | Show |
| iOS Safari (not installed) | Hide | Hide | Show | Show |

## Notes

- `beforeinstallprompt` only fires on supported browsers and installable pages.
- If `btnInstallPwa` does not show, verify HTTPS, manifest.json, and successful service worker registration.
- `latest.apk` can be replaced with dynamic URL from `version.json`.
