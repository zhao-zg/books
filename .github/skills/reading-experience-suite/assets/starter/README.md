# Reading Experience Starter (Copy and Use)

## 1) Copy files

Copy these two files into your project template/static path:

- `reading-controls.html`
- `reading-suite-init.js`

Typical target paths:

- `src/templates/reading-controls.html`
- `src/static/js/reading-suite-init.js`

## 2) Include in base template

Add before `</body>`:

```html
{% include 'reading-controls.html' %}
<script src="js/speech.js"></script>
<script src="js/nav-stack.js"></script>
<script src="js/theme-toggle.js"></script>
<script src="js/font-control.js"></script>
<script src="js/reading-suite-init.js"></script>
```

## 3) Set page type per template

Home page:

```html
<script>window.CXPageType = 'home';</script>
```

Directory page:

```html
<script>window.CXPageType = 'directory';</script>
```

Content page:

```html
<script>window.CXPageType = 'content';</script>
```

## 4) Provide TTS text extractor on content pages

```html
<script>
window.CXSpeechTextProvider = function () {
  var text = '';
  document.querySelectorAll('.content-text').forEach(function (el) {
    var t = (el.textContent || '').trim();
    if (t) text += t + '。';
  });
  return text;
};
</script>
```

## 5) Ensure required base files exist

If missing, generate with these skills first:

- `/static-to-pwa` (must include `CACHE_INFO` / `CLEAR_CACHE` service worker message API)
- `/web-reading-tts`
- `/page-navigation-stack`

## 6) Quick verify

- Browser Android: can see `下载 APK`, maybe `安装 PWA`.
- Installed PWA: hide `安装 PWA`, show cache buttons.
- Capacitor app: back button routes by page type.
- Content page: play TTS works.
