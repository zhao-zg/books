# Cloudflare Headers Configuration

## `output/_headers` File

Cloudflare Pages supports a `_headers` file for custom HTTP headers.

```
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin

/sw.js
  Cache-Control: no-cache, no-store, must-revalidate

/version.json
  Cache-Control: no-cache, no-store, must-revalidate
  Access-Control-Allow-Origin: *

/*.apk
  Access-Control-Allow-Origin: *
  Content-Type: application/vnd.android.package-archive
  Cache-Control: public, max-age=86400

/manifest.json
  Cache-Control: no-cache
  Content-Type: application/manifest+json

/trainings.json
  Cache-Control: no-cache, no-store, must-revalidate
```

## Key Rules

- **sw.js**: Always no-cache so updates propagate immediately
- **version.json**: No-cache + CORS for cross-origin version checks from APK
- **.apk files**: CORS enabled + proper content type for APK download
- **manifest.json**: No-cache for PWA manifest updates

## Placement

Place `_headers` in the root of your output directory (same level as `index.html`).
