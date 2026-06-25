---
name: web-reading-tts
description: 'Add article read-aloud (TTS) to static pages with unified controls. Use when: 朗读, TTS, 语音播放, 播放暂停, 语速, 进度条, Web Speech API, Capacitor TextToSpeech.'
argument-hint: 'Describe your content selectors and whether you need Capacitor support'
---

# Web Reading TTS

## When to Use
- 静态网页需要朗读功能
- 需要播放/暂停、语速、进度条
- 同时兼容浏览器 Web Speech API 和 Capacitor TextToSpeech

## Procedure

### Step 1: Add control bar UI

在页面里加入统一控件，模板见 [Control Bar Template](./references/control-bar-template.md)。

### Step 2: Add shared `speech.js`

使用共享脚本（模板见 [Speech JS Template](./references/speech-js-template.md)），暴露：
- `window.CXSpeech.init({ getText, lang })`
- `window.CXSpeech.cancel()`

### Step 3: Initialize per page

在具体页面里提供 `getText()`，负责抽取要朗读的正文，示例见 [Page Init Example](./references/page-init-example.md)。

### Step 4: Handle unsupported environments

在不支持 TTS 的环境显示“朗读暂不可用”，隐藏播放控件。

## Assets

- [Speech JS Starter](./assets/speech.js)

## References

- [Control Bar Template](./references/control-bar-template.md)
- [Speech JS Template](./references/speech-js-template.md)
- [Page Init Example](./references/page-init-example.md)
