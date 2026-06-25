# Python Icon Generator

Generate PWA and Android icons from a source SVG or PNG.

## PWA Icons (Python + Pillow)

```python
#!/usr/bin/env python3
"""Generate PWA icons from a source image."""
from PIL import Image
import os

def generate_pwa_icons(source_image, output_dir='output/icons'):
    """Generate 192x192 and 512x512 PWA icons."""
    os.makedirs(output_dir, exist_ok=True)
    
    img = Image.open(source_image)
    
    sizes = {
        'icon-192.png': (192, 192),
        'icon-512.png': (512, 512),
    }
    
    for filename, size in sizes.items():
        resized = img.resize(size, Image.LANCZOS)
        resized.save(os.path.join(output_dir, filename))
        print(f'Generated {filename} ({size[0]}x{size[1]})')

if __name__ == '__main__':
    generate_pwa_icons('icon_source.png')
```

## Android Icons (Multiple Densities)

```python
#!/usr/bin/env python3
"""Generate Android launcher icons for all densities."""
from PIL import Image
import os

ANDROID_ICON_SIZES = {
    'mipmap-mdpi':    (48, 48),
    'mipmap-hdpi':    (72, 72),
    'mipmap-xhdpi':   (96, 96),
    'mipmap-xxhdpi':  (144, 144),
    'mipmap-xxxhdpi': (192, 192),
}

def generate_android_icons(source_image, output_dir='android_icons'):
    """Generate Android launcher icons for all densities."""
    img = Image.open(source_image)
    
    for folder, size in ANDROID_ICON_SIZES.items():
        dir_path = os.path.join(output_dir, folder)
        os.makedirs(dir_path, exist_ok=True)
        
        resized = img.resize(size, Image.LANCZOS)
        output_path = os.path.join(dir_path, 'ic_launcher.png')
        resized.save(output_path)
        print(f'Generated {folder}/ic_launcher.png ({size[0]}x{size[1]})')

if __name__ == '__main__':
    generate_android_icons('icon_source.png')
```

## Requirements

```
Pillow>=9.0.0
```
