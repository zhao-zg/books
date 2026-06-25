# Release Automation

## Version Tagging Script

### Windows (release.bat)

```batch
@echo off
setlocal enabledelayedexpansion

:: Read current version from app_config.json
for /f "tokens=2 delims=:," %%a in ('findstr "version" app_config.json') do (
    set "VERSION=%%~a"
    set "VERSION=!VERSION: =!"
    set "VERSION=!VERSION:"=!"
)

echo Current version: %VERSION%

:: Increment patch version
for /f "tokens=1-3 delims=." %%a in ("%VERSION%") do (
    set /a PATCH=%%c+1
    set "NEW_VERSION=%%a.%%b.!PATCH!"
)

echo New version: %NEW_VERSION%

:: Update app_config.json
python -c "import json; f=open('app_config.json','r+',encoding='utf-8'); d=json.load(f); d['version']='%NEW_VERSION%'; f.seek(0); json.dump(d,f,ensure_ascii=False,indent=2); f.truncate()"

:: Git operations
git add -A
git commit -m "Release v%NEW_VERSION%"
git tag v%NEW_VERSION%
git push origin main
git push origin v%NEW_VERSION%

echo Released v%NEW_VERSION%
```

### Auto-versioning in GitHub Actions

```yaml
- name: Bump version
  run: |
    NEW_VERSION=$(python3 -c "
    import json
    with open('app_config.json', 'r+', encoding='utf-8') as f:
        config = json.load(f)
        parts = config['version'].split('.')
        parts[-1] = str(int(parts[-1]) + 1)
        config['version'] = '.'.join(parts)
        f.seek(0); json.dump(config, f, ensure_ascii=False, indent=2); f.truncate()
        print(config['version'])
    ")
    echo "NEW_VERSION=$NEW_VERSION" >> $GITHUB_ENV
```

## Version Code Calculation

Android requires an integer `versionCode`:

```bash
# From semantic version "1.2.3" → versionCode 10203
IFS='.' read -ra PARTS <<< "$VERSION"
VERSION_CODE=$((${PARTS[0]} * 10000 + ${PARTS[1]:-0} * 100 + ${PARTS[2]:-0}))
```

## Workflow Trigger Chain

```
git tag v1.0.1 → push tag
  ↓
android-release.yml (builds APK, creates Release)
  ↓
deploy.yml (triggered by workflow_dispatch or main push)
  ↓
Cloudflare Pages + GitHub Pages deployment
```
