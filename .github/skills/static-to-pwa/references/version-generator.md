# Version Generator

Generate `version.json` for PWA update tracking and APK version info.

## Python Script

```python
#!/usr/bin/env python3
"""Generate version.json for PWA/APK version tracking."""
import json
import os

def generate_version_file(output_dir='output', app_version=None, apk_file=None, apk_size=None):
    """Generate version.json file."""
    
    # Read version from app_config.json
    if app_version is None:
        config_file = 'app_config.json'
        if os.path.exists(config_file):
            with open(config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)
                app_version = config.get('version', '0.0.0')
        else:
            app_version = '0.0.0'
    
    if apk_file is None:
        apk_file = f'App-v{app_version}.apk'
    
    version_info = {
        'apk_version': app_version,
        'version': app_version,
        'apk_file': apk_file,
    }
    
    if apk_size is not None:
        version_info['apk_size'] = apk_size
    
    version_file = os.path.join(output_dir, 'version.json')
    with open(version_file, 'w', encoding='utf-8') as f:
        json.dump(version_info, f, ensure_ascii=False, indent=2)
    
    return version_info

if __name__ == '__main__':
    generate_version_file()
```

## app_config.json Format

```json
{
  "app_name": "MyApp",
  "app_id": "com.example.app",
  "version": "1.0.0"
}
```

## version.json Output Format

```json
{
  "apk_version": "1.0.0",
  "version": "1.0.0",
  "apk_file": "App-v1.0.0.apk",
  "apk_size": 52428800
}
```
