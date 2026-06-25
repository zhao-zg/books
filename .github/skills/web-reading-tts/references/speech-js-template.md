# Speech JS Template

优先使用共享脚本思路：

- 页面只负责传 `getText()`
- `speech.js` 统一处理播放/暂停/语速/兼容性

接口：

```javascript
window.CXSpeech.init({
  getText: function () { return '要朗读的文本'; },
  lang: 'zh-CN'
});

window.CXSpeech.cancel();
```

如需 Capacitor 原生朗读，可在脚本中优先检测：

```javascript
var useCapacitorTTS = !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TextToSpeech);
```
