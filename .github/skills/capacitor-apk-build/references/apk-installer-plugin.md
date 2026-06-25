# APK Installer Plugin for Capacitor 6

Custom Capacitor plugin to install APK files from within the app (for self-update functionality).

## Problem

Capacitor 6 has no built-in APK installation capability. Android 7.0+ requires FileProvider for `content://` URIs instead of `file://`.

## Files to Create

### 1. ApkInstallerPlugin.java

Path: `android/app/src/main/java/com/example/myapp/ApkInstallerPlugin.java`

```java
package com.example.myapp;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    @PluginMethod
    public void install(PluginCall call) {
        String filePath = call.getString("filePath");

        if (filePath == null || filePath.isEmpty()) {
            call.reject("File path is required");
            return;
        }

        try {
            if (filePath.startsWith("file://")) {
                filePath = filePath.substring(7);
            }

            File file = new File(filePath);
            if (!file.exists()) {
                call.reject("File not found: " + filePath);
                return;
            }

            Uri uri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    file
                );
            } else {
                uri = Uri.fromFile(file);
            }

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);

            getActivity().startActivity(intent);

            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to open installer: " + e.getMessage());
        }
    }
}
```

### 2. MainActivity.java

Path: `android/app/src/main/java/com/example/myapp/MainActivity.java`

```java
package com.example.myapp;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register plugin BEFORE super.onCreate()
        registerPlugin(ApkInstallerPlugin.class);
        super.onCreate(savedInstanceState);

        // Optional: set status bar color
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Window window = getWindow();
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(0xFFF6F7FB);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                View decorView = window.getDecorView();
                decorView.setSystemUiVisibility(
                    decorView.getSystemUiVisibility() | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                );
            }
        }
    }
}
```

## Required AndroidManifest.xml Permissions

Add these to `AndroidManifest.xml`:

```xml
<!-- APK installation permission (Android 8.0+) -->
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />

<!-- Storage (Android 10 and below) -->
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
```

Add FileProvider inside `<application>`:

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

Add queries for Android 11+:

```xml
<queries>
    <intent>
        <action android:name="android.intent.action.VIEW" />
        <data android:mimeType="application/vnd.android.package-archive" />
    </intent>
</queries>
```

## file_paths.xml

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

## JavaScript Usage

```javascript
// Call from JavaScript
await window.Capacitor.Plugins.ApkInstaller.install({
    filePath: 'file:///path/to/downloaded.apk'
});
```

## CI/CD Integration

In GitHub Actions, after `npx cap add android` and `npx cap sync android`, restore custom files:

```yaml
- name: Restore custom plugin files
  run: |
    git checkout android/app/src/main/java/com/example/myapp/MainActivity.java
    git checkout android/app/src/main/java/com/example/myapp/ApkInstallerPlugin.java
```

This works because these files are tracked in git but the `android/` directory is regenerated during build.
