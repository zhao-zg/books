# APK Installer Native Setup

Use this checklist to enable `window.Capacitor.Plugins.ApkInstaller.install(...)` in Android.

## 1. Create Plugin Class

Create `ApkInstallerPlugin.java` under your app package path.

Example path:

`android/app/src/main/java/com/books/app/ApkInstallerPlugin.java`

Required annotation:

```java
@CapacitorPlugin(name = "ApkInstaller")
```

Required method signature:

```java
@PluginMethod
public void install(PluginCall call)
```

## 2. Register in MainActivity

In `MainActivity.java`, register plugin before `super.onCreate(...)`:

```java
registerPlugin(ApkInstallerPlugin.class);
super.onCreate(savedInstanceState);
```

## 3. AndroidManifest.xml

Add install permission:

```xml
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
```

Inside `<application>`, add FileProvider:

```xml
<provider
    android:name="androidx.core.content.FileProvider"
    android:authorities="${applicationId}.fileprovider"
    android:exported="false"
    android:grantUriPermissions="true">
    <meta-data
        android:name="android.support.FILE_PROVIDER_PATHS"
        android:resource="@xml/file_paths" />
</provider>
```

Optional for Android 11+ package visibility:

```xml
<queries>
    <intent>
        <action android:name="android.intent.action.VIEW" />
        <data android:mimeType="application/vnd.android.package-archive" />
    </intent>
</queries>
```

## 4. file_paths.xml

Create `android/app/src/main/res/xml/file_paths.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <cache-path name="cache" path="." />
    <external-path name="external" path="." />
    <external-cache-path name="external_cache" path="." />
    <external-path name="downloads" path="Download/" />
</paths>
```

## 5. Runtime Smoke Test

```javascript
await window.Capacitor.Plugins.ApkInstaller.install({
    filePath: "file:///path/to/app.apk"
});
```

If this call throws, first check package path mismatch and FileProvider `authorities` mismatch.

## Fast Copy Templates

If you want quick copy-and-edit files, use:

- `../assets/starter/README.md`
- `../assets/starter/ApkInstallerPlugin.java.template`
- `../assets/starter/MainActivity.register-plugin.snippet.java`
- `../assets/starter/AndroidManifest.apkinstaller.snippet.xml`
- `../assets/starter/file_paths.xml.template`
- `../assets/starter/ci-restore-custom-files.snippet.yml`

## See Also

- `capacitor-apk-build` reference: `./../../capacitor-apk-build/references/apk-installer-plugin.md`
- JS API details: `./apk-installer-plugin-js.md`
