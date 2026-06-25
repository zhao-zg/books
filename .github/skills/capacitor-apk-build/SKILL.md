---
name: capacitor-apk-build
description: 'Build Android APK from static HTML using Capacitor 6 and GitHub Actions. Use when: build APK, GitHub Actions Android, Capacitor build, generate APK from HTML, Android release APK, CI/CD APK pipeline, signed APK, automated APK build.'
argument-hint: 'Describe your app name, package ID, and static HTML output directory'
---

# Capacitor APK Build via GitHub Actions

## When to Use
- Building an Android APK from a static HTML website
- Setting up GitHub Actions CI/CD for Android builds
- Wrapping a PWA into a native Android app
- Automating APK signing and release

## Overview

This skill creates a complete pipeline to:
1. Wrap static HTML in Capacitor 6 (Android WebView)
2. Build signed APK via GitHub Actions
3. Publish APK to GitHub Releases
4. Support custom native plugins (e.g., APK installer)

## Prerequisites

- Node.js 18+
- Java 17 (JDK)
- Static HTML site in `output/` directory
- GitHub repository with Actions enabled

## Procedure

### Step 0: Use Starter Template Pack (Recommended)

This skill includes a ready-to-copy starter pack in:

`./assets/starter/`

Copy these files into your new repository root:
- `app_config.json`
- `capacitor.config.json`
- `package.json`
- `.github/workflows/android-release.yml`

Then replace placeholders:
- `__APP_NAME__`
- `__APP_ID__`
- `__WEB_DIR__`

### Step 1: Initialize Capacitor Project

Create `package.json`:

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "description": "My App - Android",
  "scripts": {
    "cap:add": "npx cap add android",
    "cap:sync": "npx cap sync",
    "cap:open": "npx cap open android"
  },
  "dependencies": {
    "@capacitor/core": "^6.0.0",
    "@capacitor/app": "^6.0.0",
    "@capacitor/filesystem": "^6.0.0"
  },
  "devDependencies": {
    "@capacitor/cli": "^6.0.0",
    "@capacitor/android": "^6.0.0"
  }
}
```

Create `capacitor.config.json`:

```json
{
  "appId": "com.example.myapp",
  "appName": "MyApp",
  "webDir": "output",
  "android": {
    "allowMixedContent": true,
    "captureInput": true,
    "webContentsDebuggingEnabled": false
  }
}
```

Create `app_config.json`:

```json
{
  "app_name": "MyApp",
  "app_id": "com.example.myapp",
  "version": "1.0.0"
}
```

### Step 2: Create GitHub Actions Workflow

Create the workflow file following the [APK build workflow template](./references/apk-build-workflow.md).

Key workflow steps:
1. Checkout code
2. Setup Python, Node.js, Java 17
3. Generate static site
4. Add Android platform via Capacitor
5. Configure version, icons, signing
6. Build APK with Gradle
7. Upload to GitHub Releases

### Step 3: Configure Signing Key

Generate a keystore (run locally once):

```bash
keytool -genkey -v -keystore app-key.keystore \
  -alias myapp -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass mypassword -keypass mypassword \
  -dname "CN=MyApp, OU=Dev, O=MyOrg, L=City, ST=State, C=CN"
```

Base64 encode and embed in workflow, or store as GitHub Secret.

### Step 4: Android Icons

Pre-generate icons for all densities. See [icon generator reference](./references/android-icons.md).

Place in `android_icons/` directory:
```
android_icons/
├── mipmap-mdpi/ic_launcher.png     (48x48)
├── mipmap-hdpi/ic_launcher.png     (72x72)
├── mipmap-xhdpi/ic_launcher.png    (96x96)
├── mipmap-xxhdpi/ic_launcher.png   (144x144)
└── mipmap-xxxhdpi/ic_launcher.png  (192x192)
```

### Step 5: Version Tagging

Use semantic versioning with git tags to trigger builds:

```bash
# Bump version and create tag
git tag v1.0.1
git push origin v1.0.1
```

The workflow triggers on `v*.*.*` tag pushes.

### Step 6: Custom Plugins

If you need native capabilities beyond WebView, see:
- [APK Installer Plugin](./references/apk-installer-plugin.md) - For in-app APK installation
- [Custom Plugin Setup](./references/custom-plugin-setup.md) - General plugin creation guide

Important:
- For normal web-wrapper APK builds, custom plugins are optional.
- For in-app self-update flow, `ApkInstaller` is required and must be registered in `MainActivity.java`.

## References

- [APK Build Workflow Template](./references/apk-build-workflow.md)
- [Android Icons Setup](./references/android-icons.md)
- [APK Installer Plugin](./references/apk-installer-plugin.md)
- [Custom Plugin Setup](./references/custom-plugin-setup.md)
- [Release Automation](./references/release-automation.md)

## Assets

- [Starter Template Pack](./assets/starter/README.md)
