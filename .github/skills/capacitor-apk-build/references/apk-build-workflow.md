# APK Build Workflow Template

Complete GitHub Actions workflow for building Android APK from static HTML using Capacitor 6.

## Workflow File: `.github/workflows/android-release.yml`

```yaml
name: Build Android APK

on:
  push:
    tags:
      - 'v*.*.*'
  workflow_dispatch:

permissions:
  contents: write
  deployments: write
  actions: write

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '18'

    - name: Setup Java 17
      uses: actions/setup-java@v4
      with:
        distribution: 'temurin'
        java-version: '17'

    - name: Extract version from tag
      run: |
        VERSION=${GITHUB_REF#refs/tags/v}
        if [ -z "$VERSION" ]; then VERSION="0.1.0"; fi
        echo "VERSION=$VERSION" >> $GITHUB_ENV

        # Update app_config.json
        python3 -c "
        import json
        with open('app_config.json', 'r+', encoding='utf-8') as f:
            config = json.load(f)
            config['version'] = '$VERSION'
            f.seek(0); json.dump(config, f, ensure_ascii=False, indent=2); f.truncate()
        "

    - name: Install Node.js dependencies
      run: npm install

    # ===== YOUR BUILD STEP =====
    # Add your static site generation command here, e.g.:
    # - name: Generate static site
    #   run: python main.py

    - name: Add Android platform
      run: |
        # Remove existing android/ if present (will be re-generated)
        rm -rf android
        npx cap add android

    - name: Restore custom plugin files (if any)
      run: |
        # If you have custom Java files tracked in git under android/, restore them:
        # git checkout android/app/src/main/java/com/example/myapp/MainActivity.java
        # git checkout android/app/src/main/java/com/example/myapp/MyPlugin.java
        echo "Restore custom files if needed"

    - name: Configure Android icons
      run: |
        if [ -d "android_icons" ]; then
          cp -r android_icons/* android/app/src/main/res/
          echo "Icons copied"
        fi

    - name: Configure Android version
      run: |
        VERSION=${{ env.VERSION }}
        IFS='.' read -ra PARTS <<< "$VERSION"
        VERSION_CODE=$((${PARTS[0]} * 10000 + ${PARTS[1]:-0} * 100 + ${PARTS[2]:-0}))

        python3 << 'EOF'
        import re, sys
        gradle_file = 'android/app/build.gradle'
        with open(gradle_file, 'r') as f: content = f.read()

        vc, vn = '$VERSION_CODE', '$VERSION'

        if re.search(r'versionCode\s+\d+', content):
            content = re.sub(r'versionCode\s+\d+', f'versionCode {vc}', content)
        else:
            content = re.sub(r'(defaultConfig\s*\{)', rf'\1\n        versionCode {vc}', content)

        if re.search(r'versionName\s+"[^"]*"', content):
            content = re.sub(r'versionName\s+"[^"]*"', f'versionName "{vn}"', content)
        else:
            content = re.sub(r'(defaultConfig\s*\{)', rf'\1\n        versionName "{vn}"', content)

        if not re.search(r'namespace\s+["\']', content):
            content = re.sub(r'(android\s*\{)', r'\1\n    namespace "com.example.myapp"', content)

        with open(gradle_file, 'w') as f: f.write(content)
        EOF

    - name: Sync Capacitor
      run: npx cap sync android

    - name: Re-apply icons after sync
      run: |
        if [ -d "android_icons" ]; then
          rm -rf android/app/src/main/res/mipmap-*
          cp -r android_icons/* android/app/src/main/res/
        fi

    - name: Create signing keystore
      run: |
        # Option 1: Base64-encoded keystore in workflow (for simple projects)
        # echo "$KEYSTORE_BASE64" | base64 -d > android/app-key.keystore
        
        # Option 2: Generate a new one (for testing)
        keytool -genkey -v -keystore android/app-key.keystore \
          -alias myapp -keyalg RSA -keysize 2048 -validity 10000 \
          -storepass changeme -keypass changeme \
          -dname "CN=App, OU=Dev, O=Org, L=City, ST=State, C=CN" 2>/dev/null || true

    - name: Configure signing in build.gradle
      run: |
        python3 << 'EOF'
        import re
        gradle_file = 'android/app/build.gradle'
        with open(gradle_file, 'r') as f: content = f.read()

        signing_config = '''
            signingConfigs {
                release {
                    storeFile file("app-key.keystore")
                    storePassword "changeme"
                    keyAlias "myapp"
                    keyPassword "changeme"
                }
            }
        '''
        content = re.sub(r'(android\s*\{)', r'\1' + signing_config, content, count=1)
        content = re.sub(
            r'(buildTypes\s*\{[^}]*release\s*\{)',
            r'\1\n            signingConfig signingConfigs.release',
            content, count=1
        )

        with open(gradle_file, 'w') as f: f.write(content)
        EOF

    - name: Build APK
      run: |
        chmod +x android/gradlew
        cd android
        ./gradlew clean assembleRelease --stacktrace --no-daemon

    - name: Rename and collect APK
      run: |
        VERSION=${{ env.VERSION }}
        cd android/app/build/outputs/apk/release/
        for apk in *.apk; do
          if [ -f "$apk" ]; then
            APK_NAME="MyApp-v${VERSION}.apk"
            cp "$apk" "../../../../../../$APK_NAME"
            echo "APK: $APK_NAME ($(du -h "$apk" | cut -f1))"
            break
          fi
        done

    - name: Upload APK artifact
      uses: actions/upload-artifact@v4
      with:
        name: android-apk
        path: MyApp-*.apk

    - name: Create GitHub Release
      if: startsWith(github.ref, 'refs/tags/')
      uses: softprops/action-gh-release@v2
      with:
        files: MyApp-*.apk
        body: |
          ## MyApp ${{ github.ref_name }}
          
          ### Download
          - **APK**: `MyApp-${{ github.ref_name }}.apk`
          - Requires Android 5.1+ (API 22)
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Customization Points

| Item | Where to Change |
|------|-----------------|
| App name | `MyApp` in APK rename and release steps |
| Package ID | `com.example.myapp` in namespace config |
| Signing credentials | `storePassword`, `keyAlias`, `keyPassword` |
| Build variant | `assembleRelease` → `assembleDebug` for debug |
| Static site build | Add your generation command before "Add Android platform" |

## Security Note

For production, store keystore and passwords as GitHub Secrets:
- `KEYSTORE_BASE64`: Base64-encoded keystore file
- `KEYSTORE_PASSWORD`: Keystore password
- `KEY_ALIAS`: Key alias
- `KEY_PASSWORD`: Key password

Then reference as `${{ secrets.KEYSTORE_PASSWORD }}` in workflow.
