/* Shared speech controls starter */
(function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function safeText(text) { return (text || '').replace(/\s+/g, ' ').trim(); }

  function init(options) {
    var getText = options && typeof options.getText === 'function' ? options.getText : null;
    if (!getText) return;

    var playPauseBtn = byId('playPauseBtn');
    var rateSelect = byId('rateSelect');
    var speechTime = byId('speechTime');
    var progressBar = byId('progressBar');
    var controlsDiv = byId('bottomControlBar') || byId('speechControls');
    if (!playPauseBtn || !rateSelect || !speechTime || !progressBar || !controlsDiv) return;

    var supported = ('speechSynthesis' in window) && ('SpeechSynthesisUtterance' in window);
    controlsDiv.style.display = 'flex';
    if (!supported) {
      playPauseBtn.style.display = 'none';
      rateSelect.style.display = 'none';
      progressBar.style.display = 'none';
      speechTime.textContent = '朗读暂不可用';
      return;
    }

    var isPaused = false;
    var utterance = null;

    function cancel() {
      try { window.speechSynthesis.cancel(); } catch (e) {}
      utterance = null;
      isPaused = false;
      speechTime.textContent = '00:00 / 00:00';
      progressBar.value = '0';
    }

    function play() {
      var text = safeText(getText());
      if (!text) return;
      cancel();
      utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = (options && options.lang) || 'zh-CN';
      utterance.rate = Number(rateSelect.value) || 1;
      speechTime.textContent = '播放中';
      utterance.onend = function() { speechTime.textContent = '00:00 / 00:00'; };
      window.speechSynthesis.speak(utterance);
    }

    playPauseBtn.addEventListener('click', function () {
      if (window.speechSynthesis.speaking && !isPaused) {
        window.speechSynthesis.pause();
        isPaused = true;
        speechTime.textContent = '已暂停';
      } else if (isPaused) {
        window.speechSynthesis.resume();
        isPaused = false;
        speechTime.textContent = '播放中';
      } else {
        play();
      }
    });

    rateSelect.addEventListener('change', function () {
      if (window.speechSynthesis.speaking) play();
    });

    window.addEventListener('beforeunload', cancel);
  }

  window.CXSpeech = {
    init: init,
    cancel: function () {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
  };
})();
