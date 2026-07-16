---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'a9236388-3770-49fe-9d7b-cdc0782f87a3'
  PropagateID: 'a9236388-3770-49fe-9d7b-cdc0782f87a3'
  ReservedCode1: 'e25f2304-e47f-4d82-b808-63d95c828ea3'
  ReservedCode2: 'e25f2304-e47f-4d82-b808-63d95c828ea3'
---

---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'fda0ae86-7c31-4668-9798-194910d18f34'
  PropagateID: 'fda0ae86-7c31-4668-9798-194910d18f34'
  ReservedCode1: '859e070a-06f3-4244-b497-a7f538c8d737'
  ReservedCode2: '859e070a-06f3-4244-b497-a7f538c8d737'
---

---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '5f34cc7c-28b4-4c5e-9ab4-bb7e6d3a505a'
  PropagateID: '5f34cc7c-28b4-4c5e-9ab4-bb7e6d3a505a'
  ReservedCode1: 'c67fc239-1103-42f2-8e9b-181d2df1edd4'
  ReservedCode2: 'c67fc239-1103-42f2-8e9b-181d2df1edd4'
---

# JavaScript Obfuscation Guide

Protect sensitive URLs (download mirrors, API endpoints) in app-update JS files.

> **Note:** `app-update.js` has been split into 5 sub-files under `output/js/app-update/`.
> Each sub-file is obfuscated independently. Global `var`/`function` declarations are
> preserved because `javascript-obfuscator` defaults to `--renameGlobals false`.

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
    import glob
    # Obfuscate each app-update sub-file independently
    for f in glob.glob('output/js/app-update/*.js'):
        obfuscate_file(f)
```

### CI/CD Integration

The CI workflow (`android-release-offline.yml`) obfuscates `remote-config.js`,
`theme-toggle.js`, and each file in `output/js/app-update/*.js` independently:

```yaml
- name: 🔐 执行 JS 混淆
  run: |
    # Single-file JS
    for f in remote-config.js theme-toggle.js; do
      npx javascript-obfuscator "output/js/$f" --output "output/js/$f" ...
    done
    # app-update sub-files (split into multi-file directory)
    for f in output/js/app-update/*.js; do
      npx javascript-obfuscator "$f" --output "$f" ...
    done

- name: 🔐 验证混淆结果
  run: |
    # Verify single-file JS
    for f in remote-config.js theme-toggle.js; do
      grep -q "_0x" output/js/$f || exit 1
    done
    # Verify app-update sub-files
    for f in output/js/app-update/*.js; do
      grep -q "_0x" "$f" || exit 1
    done
```

### Web Deploy: app-update files

For web (PWA) deployment, app-update sub-files are not needed (APK-only feature):

```yaml
- name: Remove APK-only files
  run: rm -rf output/js/app-update/
```