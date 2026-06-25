---
name: reading-experience-suite
description: 'Build a complete reading UX for static sites and PWA: typography controls, theme toggle, TTS read-aloud, page navigation stack, and environment-aware quick actions. Use when: 阅读体验, 字体大小, 夜间模式, 朗读, 翻页, 返回栈, PWA 安装, 下载 APK, 缓存清理.'
argument-hint: 'Describe your page structure (home/directory/content) and target platforms (web/PWA/Capacitor)'
---

# Reading Experience Suite

## When to Use
- 你要给新项目一次性加完整阅读能力
- 需要统一处理 Web / PWA / Capacitor 的交互差异
- 需要朗读、翻页返回、字体和主题控制、缓存管理按钮

## What This Skill Integrates

1. Typography controls (font size)
2. Theme toggle (light/dark or custom themes)
3. Read-aloud (TTS)
4. Navigation stack (home/directory/content back behavior)
5. Environment-aware quick actions:
   - Download APK
   - Install PWA
   - Cache Data
   - Clear Cache

## Procedure

### Step 1: Copy starter files

Copy files from `./assets/starter/`:
- `reading-controls.html`
- `reading-suite-init.js`

### Step 2: Ensure base scripts exist

This suite composes these existing skills:
- `static-to-pwa` (service worker + cache message API)
- `web-reading-tts` (speech.js + TTS controls)
- `page-navigation-stack` (nav-stack.js)

If missing, run these first:
- `/static-to-pwa ...`
- `/web-reading-tts ...`
- `/page-navigation-stack ...`

### Step 3: Insert controls into base template

In your base template/body footer:

```html
{% include 'reading-controls.html' %}
<script src="js/speech.js"></script>
<script src="js/nav-stack.js"></script>
<script src="js/theme-toggle.js"></script>
<script src="js/font-control.js"></script>
<script src="js/reading-suite-init.js"></script>
```

### Step 4: Configure page type init

Set page type in each page template:

```html
<script>
window.CXPageType = 'content';
// 'home' | 'directory' | 'content'
</script>
```

### Step 5: Provide text extractor for TTS

On content pages:

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

### Step 6: Validate behavior matrix

Use checklist: [Integration Checklist](./references/integration-checklist.md)

## Assets

- [Reading Controls HTML](./assets/starter/reading-controls.html)
- [Suite Init Script](./assets/starter/reading-suite-init.js)
- [Starter README](./assets/starter/README.md)

## References

- [Integration Checklist](./references/integration-checklist.md)
- [Runtime Behavior Matrix](./references/runtime-behavior-matrix.md)
