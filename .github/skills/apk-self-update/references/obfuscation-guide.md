# JavaScript Obfuscation Guide

Protect sensitive URLs (download mirrors, API endpoints) in app-update.js.

## Using javascript-obfuscator

### Install

```bash
npm install -g javascript-obfuscator
# or
npx javascript-obfuscator --version
```

### Python Wrapper Script

```python
#!/usr/bin/env python3
"""Obfuscate JavaScript files to protect sensitive URLs."""
import os
import shutil
import subprocess

def obfuscate_file(input_file, output_file=None):
    """Obfuscate a JS file with strong protection."""
    if output_file is None:
        output_file = input_file
    
    temp_file = input_file + '.temp.js'
    
    cmd = [
        'npx', 'javascript-obfuscator',
        input_file,
        '--output', temp_file,
        '--compact', 'true',
        '--control-flow-flattening', 'true',
        '--control-flow-flattening-threshold', '1',
        '--dead-code-injection', 'true',
        '--dead-code-injection-threshold', '0.4',
        '--debug-protection', 'true',
        '--identifier-names-generator', 'hexadecimal',
        '--string-array', 'true',
        '--string-array-encoding', 'rc4',
        '--string-array-threshold', '1',
        '--transform-object-keys', 'true',
        '--self-defending', 'true',
        '--split-strings', 'true',
        '--split-strings-chunk-length', '5'
    ]
    
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        shutil.move(temp_file, output_file)
        return True
    except subprocess.CalledProcessError as e:
        print(f"Obfuscation failed: {e.stderr}")
        return False

if __name__ == '__main__':
    obfuscate_file('output/js/app-update.js')
```

### CI/CD Integration

```yaml
- name: Obfuscate app-update.js
  run: |
    npm install -g javascript-obfuscator
    python encrypt_app_update.py
    
    # Verify obfuscation (check for hexadecimal identifiers)
    if grep -q "_0x" output/js/app-update.js; then
      echo "Obfuscation verified"
    else
      echo "Obfuscation may have failed"
      exit 1
    fi
    
    # Remove backup to prevent leaking source
    rm -f app-update.js.backup
```

### Web Deploy: Remove app-update.js

For web (PWA) deployment, `app-update.js` is not needed:

```yaml
- name: Remove APK-only files
  run: rm -f output/js/app-update.js
```
