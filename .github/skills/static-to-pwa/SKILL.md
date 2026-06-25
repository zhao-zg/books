---
name: static-to-pwa
description: 'Convert static HTML site to a Progressive Web App (PWA) with offline support. Use when: creating PWA, adding service worker, making website installable, offline-first website, manifest.json, sw.js generation, add-to-homescreen.'
argument-hint: 'Describe your static site structure and desired PWA features'
---

# Static HTML to PWA Conversion

## When to Use
- Converting a static HTML website to a Progressive Web App
- Adding offline functionality to an existing website
- Making a website installable (add to homescreen)
- Generating service worker and manifest.json

## Overview

This skill converts any static HTML output directory into a fully functional PWA with:
- **manifest.json** for installability
- **Service Worker (sw.js)** for offline caching
- **Cache management API** for manual cache/clear actions
- **Icon generation** for multiple resolutions
- **Version tracking** via version.json
- **Adaptive UI controls** for APK/PWA/Cache actions

## Procedure

### Step 1: Create manifest.json

Create `output/manifest.json` in the static site root:

```json
{
  "name": "应用全名",
  "short_name": "短名",
  "description": "应用描述",
  "start_url": "./",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#f6f7fb",
  "icons": [
    {
      "src": "./icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "./icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "./icons/icon.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any"
    }
  ]
}
```

### Step 2: Create Service Worker

Create `output/sw.js` following the [service worker template](./references/service-worker-template.md).

Key features:
- **Cache versioning** with timestamp-based cache names
- **URL normalization** for handling Chinese/Unicode paths
- **Network-first with cache fallback** strategy
- **Automatic old cache cleanup** on activation
- **Core resource pre-caching** on install

### Step 3: Register Service Worker in HTML

Add to main `index.html`:

```html
<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then(reg => console.log('SW registered'))
    .catch(err => console.error('SW registration failed:', err));
}
</script>
```

### Step 4: Create Icons

Generate icons for PWA in `output/icons/`:
- `icon-192.png` (192x192)
- `icon-512.png` (512x512)
- `icon.svg` (scalable)

Use Python with Pillow or a simple SVG icon.

### Step 5: Create version.json

Track versions for update detection:

```json
{
  "version": "1.0.0",
  "apk_version": "1.0.0",
  "apk_file": "App-v1.0.0.apk"
}
```

### Step 6: Add PWA Headers

Create `output/_headers` for Cloudflare Pages:

```
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY

/sw.js
  Cache-Control: no-cache, no-store, must-revalidate

/version.json
  Cache-Control: no-cache, no-store, must-revalidate
  Access-Control-Allow-Origin: *
```

### Step 7: Add Cache Data and Clear Cache Controls

Expose a simple cache management API in your page:

```html
<script>
async function cxCacheInfo() {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg || !reg.active) return { available: false };
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data || {});
    reg.active.postMessage({ type: 'CACHE_INFO' }, [channel.port2]);
  });
}

async function cxClearCache() {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg || !reg.active) return false;
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(Boolean(event.data && event.data.ok));
    reg.active.postMessage({ type: 'CLEAR_CACHE' }, [channel.port2]);
  });
}
</script>
```

This requires adding message handlers in `sw.js` (see service worker reference).

### Step 8: Render Different Buttons by Environment

Render button groups based on runtime:
- **Android browser + not installed**: show `Download APK` and `Install PWA`
- **Installed PWA**: hide `Install PWA`, show `Cache Data` and `Clear Cache`
- **Capacitor APK app**: show `Cache Data` and `Clear Cache`, hide `Download APK`

Use the environment-aware template in [Adaptive UI Controls](./references/ui-adaptive-controls.md).

## References

- [Service Worker Template](./references/service-worker-template.md)
- [Python Icon Generator](./references/icon-generator.md)
- [Version Generator](./references/version-generator.md)
- [Adaptive UI Controls](./references/ui-adaptive-controls.md)
