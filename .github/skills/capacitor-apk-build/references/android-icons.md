# Android Icons Setup

## Directory Structure

```
android_icons/
├── mipmap-mdpi/ic_launcher.png     (48x48)
├── mipmap-hdpi/ic_launcher.png     (72x72)
├── mipmap-xhdpi/ic_launcher.png    (96x96)
├── mipmap-xxhdpi/ic_launcher.png   (144x144)
└── mipmap-xxxhdpi/ic_launcher.png  (192x192)
```

## Generation Script

```python
#!/usr/bin/env python3
from PIL import Image
import os

SIZES = {
    'mipmap-mdpi':    48,
    'mipmap-hdpi':    72,
    'mipmap-xhdpi':   96,
    'mipmap-xxhdpi':  144,
    'mipmap-xxxhdpi': 192,
}

def generate(source='icon_1024.png', output_dir='android_icons'):
    img = Image.open(source)
    for folder, size in SIZES.items():
        path = os.path.join(output_dir, folder)
        os.makedirs(path, exist_ok=True)
        img.resize((size, size), Image.LANCZOS).save(
            os.path.join(path, 'ic_launcher.png')
        )
        print(f'{folder}: {size}x{size}')

if __name__ == '__main__':
    generate()
```

## CI/CD Usage

In GitHub Actions workflow:

```yaml
- name: Configure Android icons
  run: |
    # Copy pre-generated icons
    cp -r android_icons/* android/app/src/main/res/

- name: Re-apply icons after cap sync
  run: |
    # cap sync may overwrite icons, re-copy
    rm -rf android/app/src/main/res/mipmap-*
    cp -r android_icons/* android/app/src/main/res/
```
