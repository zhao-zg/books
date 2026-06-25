# Page Init Example

```html
<script src="js/speech.js"></script>
<script>
function initSpeech() {
  window.CXSpeech.init({
    getText: function() {
      var text = '';
      var title = document.querySelector('.chapter-title');
      if (title) text += title.textContent.trim() + '。';

      document.querySelectorAll('.content-text').forEach(function (el) {
        var t = (el.textContent || '').trim();
        if (t) text += t + '。';
      });
      return text;
    },
    lang: 'zh-CN'
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSpeech);
} else {
  initSpeech();
}
</script>
```
