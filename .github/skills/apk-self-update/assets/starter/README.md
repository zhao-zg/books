# APK Installer Starter Pack

Copy-and-adapt templates for Capacitor Android in-app APK installation.

## Files

- `ApkInstallerPlugin.java.template`
- `MainActivity.register-plugin.snippet.java`
- `AndroidManifest.apkinstaller.snippet.xml`
- `file_paths.xml.template`
- `ci-restore-custom-files.snippet.yml`

## Quick Use

1. Copy `ApkInstallerPlugin.java.template` to your real package path:
   - Example: `android/app/src/main/java/com/books/app/ApkInstallerPlugin.java`
2. Add registration line from `MainActivity.register-plugin.snippet.java` before `super.onCreate(...)`.
3. Merge `AndroidManifest.apkinstaller.snippet.xml` into `AndroidManifest.xml`.
4. Copy `file_paths.xml.template` to `android/app/src/main/res/xml/file_paths.xml`.
5. Add CI restore step from `ci-restore-custom-files.snippet.yml` if your workflow regenerates `android/`.

## Replace Placeholders

- `__PACKAGE_NAME__` -> your package name, e.g. `com.books.app`
- `__MAIN_ACTIVITY_PATH__` -> your MainActivity path in repository
- `__PLUGIN_PATH__` -> your ApkInstaller plugin path in repository
