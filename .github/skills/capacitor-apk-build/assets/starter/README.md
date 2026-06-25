# Starter Template Pack

Copy these files into a new repository root, then replace placeholders:

- `__APP_NAME__`
- `__APP_ID__`
- `__WEB_DIR__`

Suggested quick start:

1. Copy `app_config.json`, `capacitor.config.json`, `package.json`.
2. Copy `.github/workflows/android-release.yml`.
3. Add your static-site build command in workflow (`python main.py` or your own).
4. If you need in-app self-update, also add `ApkInstallerPlugin.java` and register it in `MainActivity.java` (see `../../references/apk-installer-plugin.md`).
5. Push tag `v1.0.0` to trigger APK build.
