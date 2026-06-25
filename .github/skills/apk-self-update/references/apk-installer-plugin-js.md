# APK Installer Plugin JavaScript API

## Calling the Native Plugin

The custom `ApkInstaller` Capacitor plugin exposes a single method:

```javascript
// Install APK from file path
await window.Capacitor.Plugins.ApkInstaller.install({
    filePath: 'file:///path/to/app.apk'
});
```

## Complete Download + Install Flow

```javascript
async function downloadAndInstallApk(downloadUrl, filename) {
    var Filesystem = window.Capacitor.Plugins.Filesystem;
    var ApkInstaller = window.Capacitor.Plugins.ApkInstaller;
    
    // 1. Download APK as blob
    var response = await fetch(downloadUrl);
    var blob = await response.blob();
    
    // 2. Convert to base64
    var arrayBuffer = await blob.arrayBuffer();
    var bytes = new Uint8Array(arrayBuffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 8192) {
        var chunk = bytes.subarray(i, Math.min(i + 8192, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }
    var base64Data = btoa(binary);
    
    // 3. Save to device
    var filePath = 'downloads/' + filename;
    try {
        await Filesystem.mkdir({
            path: 'downloads',
            directory: 'CACHE',
            recursive: true
        });
    } catch (e) { /* already exists */ }
    
    await Filesystem.writeFile({
        path: filePath,
        data: base64Data,
        directory: 'CACHE',
        recursive: true
    });
    
    // 4. Get native file URI
    var uriResult = await Filesystem.getUri({
        path: filePath,
        directory: 'CACHE'
    });
    
    // 5. Trigger system installer
    var result = await ApkInstaller.install({
        filePath: uriResult.uri
    });
    
    console.log('Install triggered:', result);
}
```

## Checking if Running in Capacitor

```javascript
function isCapacitorNative() {
    return window.Capacitor && window.Capacitor.isNativePlatform();
}

// Only show update UI in native app
if (isCapacitorNative()) {
    // Show update button or auto-check
}
```

## Required Capacitor Plugins

In `package.json`:

```json
{
  "dependencies": {
    "@capacitor/core": "^6.0.0",
    "@capacitor/filesystem": "^6.0.0"
  }
}
```

The `ApkInstaller` plugin is a custom Java plugin registered in `MainActivity.java` - see the `capacitor-apk-build` skill for setup.
