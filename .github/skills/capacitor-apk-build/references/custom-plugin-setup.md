# Custom Capacitor Plugin Setup

Guide for creating custom native plugins in Capacitor 6 projects.

## Why Custom Plugins?

Capacitor 6 may not have built-in or third-party plugins for:
- APK installation (self-update)
- Custom native file operations
- Platform-specific features

## General Pattern

### 1. Create Plugin Java Class

```java
package com.example.myapp;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MyPlugin")
public class MyPlugin extends Plugin {

    @PluginMethod
    public void myMethod(PluginCall call) {
        String param = call.getString("paramName");
        
        // Do native work...
        
        JSObject ret = new JSObject();
        ret.put("result", "value");
        call.resolve(ret);
    }
}
```

### 2. Register in MainActivity

```java
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MyPlugin.class);  // Before super.onCreate()!
        super.onCreate(savedInstanceState);
    }
}
```

### 3. Call from JavaScript

```javascript
const result = await window.Capacitor.Plugins.MyPlugin.myMethod({
    paramName: 'value'
});
console.log(result);
```

## CI/CD Considerations

Since `npx cap add android` regenerates the `android/` directory:

1. Track custom Java files in git under `android/app/src/main/java/...`
2. In CI/CD, after `cap add` and `cap sync`, restore via `git checkout`:

```bash
git checkout android/app/src/main/java/com/example/myapp/MainActivity.java
git checkout android/app/src/main/java/com/example/myapp/MyPlugin.java
```

## AndroidManifest Modifications

Use Python/sed in CI to modify `AndroidManifest.xml` after `cap sync`:

```python
import re

manifest_file = 'android/app/src/main/AndroidManifest.xml'
with open(manifest_file, 'r') as f:
    content = f.read()

# Ensure custom MainActivity reference
content = re.sub(
    r'android:name="\.MainActivity"',
    'android:name="com.example.myapp.MainActivity"',
    content
)

with open(manifest_file, 'w') as f:
    f.write(content)
```
