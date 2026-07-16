---
name: apk-self-update
description: 'Add in-app APK self-update functionality to Capacitor Android apps. Use when: app auto-update, APK download and install, in-app update, version check, self-update mechanism, GitHub Release APK download, mirror download fallback.'
argument-hint: 'Describe your app download URL and version check endpoint'
---

# APK Self-Update for Capacitor Apps

## When to Use
- Adding auto-update capability to an Android APK
- Downloading and installing APK updates from within the app
- Checking for new versions via version.json endpoint
- Supporting GitHub Release + mirror proxy fallback downloads

## Overview

This skill implements a complete in-app update flow:
1. **Version check**: Compare local version with remote `version.json`
2. **APK download**: Download from GitHub Release with mirror fallback
3. **File save**: Save APK to device storage via Capacitor Filesystem
4. **APK install**: Trigger system installer via custom Capacitor plugin

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ version.json │────→│ JS: Check update │────→│ JS: Download APK│
│ (Cloudflare) │     │ Compare versions │     │ (Chunked, mirrors)
└──────────────┘     └──────────────────┘     └────────┬────────┘
                                                       │
                     ┌──────────────────┐     ┌────────▼────────┐
                     │ System Installer │←────│ Capacitor Plugin│
                     │ (Android Intent) │     │ ApkInstaller    │
                     └──────────────────┘     └─────────────────┘
```

## Procedure

### Step 1: Ensure Prerequisites

- Capacitor APK build is set up (see `capacitor-apk-build` skill)
- `version.json` is deployed with your website (see `cloudflare-pages-deploy` skill)
- APK Installer plugin is configured (native + JS):
  - Native setup checklist: [APK Installer Native Setup](./references/apk-installer-native.md)
  - JS calling API: [APK Installer Plugin JS API](./references/apk-installer-plugin-js.md)

### Step 1.5: Verify `ApkInstaller` Native Integration

Before wiring app-update files, confirm Android native plugin wiring is complete:

1. `ApkInstallerPlugin.java` exists under your real package path, e.g. `android/app/src/main/java/com/books/app/ApkInstallerPlugin.java`
2. `MainActivity.java` registers plugin before `super.onCreate(...)`:

```java
registerPlugin(ApkInstallerPlugin.class);
super.onCreate(savedInstanceState);
```

3. `AndroidManifest.xml` contains:
   - `android.permission.REQUEST_INSTALL_PACKAGES`
   - FileProvider `<provider ... authorities="${applicationId}.fileprovider" ... />`
4. `android/app/src/main/res/xml/file_paths.xml` exists and is referenced by FileProvider

If any of these is missing, `window.Capacitor.Plugins.ApkInstaller.install(...)` will fail at runtime.

### Step 1.6: Copy Starter Templates (Fast Path)

If you prefer copy-and-edit instead of manual wiring, use:

- `./assets/starter/README.md`
- `./assets/starter/ApkInstallerPlugin.java.template`
- `./assets/starter/MainActivity.register-plugin.snippet.java`
- `./assets/starter/AndroidManifest.apkinstaller.snippet.xml`
- `./assets/starter/file_paths.xml.template`
- `./assets/starter/ci-restore-custom-files.snippet.yml`

### Step 2: Create app-update module

Create the app-update JavaScript module as multiple sub-files under `js/app-update/` following the [app-update template](./references/app-update-template.md). The module is split into 5 files: `au-utils.js`, `au-core.js`, `au-ui.js`, `au-changelog.js`, `au-init.js`.

Key capabilities:
- Version comparison against remote `version.json`
- Chunked download with progress reporting
- GitHub Release mirror fallback (gh-proxy.com, ghproxy.net, etc.)
- Base64 conversion for Capacitor Filesystem write
- APK installation via custom plugin

### Step 3: Include in HTML

```html
<!-- Only load in Capacitor (native) environment -->
<script>
if (window.Capacitor && window.Capacitor.isNativePlatform()) {
    ['js/app-update/au-utils.js','js/app-update/au-core.js','js/app-update/au-ui.js','js/app-update/au-changelog.js','js/app-update/au-init.js'].forEach(function(src){var s=document.createElement('script');s.src=src;s.async=false;document.head.appendChild(s);});
}
</script>
```

### Step 4: Trigger Update Check

```javascript
// Check on app resume or manual trigger
if (window.AppUpdate) {
    window.AppUpdate.checkForUpdates();
}
```

### Step 5: Obfuscate Sensitive URLs (Optional)

If the APK download URLs contain sensitive information, obfuscate each app-update sub-file:

```bash
for f in output/js/app-update/*.js; do
  npx javascript-obfuscator "$f" \
    --output "$f" \
    --compact true \
    --control-flow-flattening true \
    --string-array true \
    --string-array-encoding rc4
done
```

### Step 6: CI/CD Integration

In GitHub Actions, delete app-update sub-files for web deployments (only needed in APK):

```yaml
- name: Remove APK-only files for web deploy
  run: rm -rf output/js/app-update/
```

## References

- [App Update Template](./references/app-update-template.md)
- [APK Installer Native Setup](./references/apk-installer-native.md)
- [APK Installer Plugin JS API](./references/apk-installer-plugin-js.md)
- [Obfuscation Guide](./references/obfuscation-guide.md)

## Assets

- [APK Installer Starter Pack](./assets/starter/README.md)
