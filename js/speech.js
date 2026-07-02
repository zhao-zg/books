/* Shared speech controls for 书报 (Books)
   Engines:
   - NativeTTS (Capacitor Foreground Service) -- Android APK, background-safe
   - Web Speech API                           -- browser / PWA fallback

   Exposes:
     window.BKSpeech.init({ getElements: () => [{el}], lang?: string })
     window.BKSpeech.cancel()
*/
(function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }

  // ── 统一文本处理管道（适配纯文本 content）──────────────────────────────
  // isPlainText: 若为 true，表示输入已是纯文本（zl-html），不做 HTML 清洗
  function processText(raw, isPlainText) {
    var t = raw || '';

    // 1) 基本空白整理
    t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    if (!isPlainText) {
      // HTML 残留清洗（仅对非纯文本输入）
      t = t.replace(/<[^>]*>/g, '');
      t = t.replace(/&[a-zA-Z]+;/g, ' ');
      t = t.replace(/&#[0-9]+;/g, ' ');
    }

    // 2) 移除控制字符（保留换行用于后续段落处理）
    t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // 3) 将连续换行统一为段落分隔标记
    t = t.replace(/\n{2,}/g, '\n');

    // 4) 将换行转为句号停顿（段落间自然停顿）
    //    如果前一段末尾已有句末标点则不重复添加
    t = t.replace(/\n/g, function (match, offset, str) {
      if (offset === 0) return '';
      var prev = str[offset - 1];
      if (/[。！？；\n]/.test(prev)) return '';
      return '。';
    });

    // 5) 清理多余空白
    t = t.replace(/[ \t]+/g, ' ').trim();

    // 6) 经文引用朗读优化：在缩写引用（如 "约三16"、"创二7"）前后
    //    插入微小停顿标记（逗号），使 TTS 朗读更自然
    //    模式：中文书卷名缩写 + 中文/数字章节号 + 可选节号
    t = t.replace(/((?:[，。！？；：、\s]|^))((?:创|出|利|民|申|书|士|得|撒上|撒下|王上|王下|代上|代下|拉|尼|斯|伯|诗|箴|传|歌|赛|耶|哀|结|但|何|珥|摩|俄|拿|弥|鸿|哈|番|该|亚|玛|太|可|路|约|徒|罗|林前|林后|加|弗|腓|西|帖前|帖后|提前|提后|门|来|雅|彼前|彼后|约壹|约贰|约叁|犹|启|多)[\u4e00-\u9fa5\d]+[章节篇][\u4e00-\u9fa5\d]*[节上下]?)/g,
      function (full, prefix, ref) {
        // 如果引用前面已有标点，不再额外添加
        var pre = /[，。！？；：、]/.test(prefix) ? prefix : prefix + '，';
        return pre + ref;
      });

    return t;
  }

  // ── 内容归一化：将不同格式的 content 统一为文本字符串 ───────────────
  // content 可能是：
  //   - 字符串（zl-html 纯文本，\n 分隔段落）→ 直接使用
  //   - 数组 [{type:'paragraph',text:'...'}, ...] → 拼接所有 text
  //   - 其他 → 返回空字符串
  function normalizeContent(content) {
    if (!content) return '';

    // 字符串：直接返回（zl-html 格式）
    if (typeof content === 'string') return content;

    // 数组：结构化 content
    if (Array.isArray(content)) {
      var parts = [];
      for (var i = 0; i < content.length; i++) {
        var item = content[i];
        if (typeof item === 'string') {
          parts.push(item);
        } else if (item && typeof item === 'object' && item.text) {
          parts.push(item.text);
        }
      }
      return parts.join('\n');
    }

    return String(content);
  }

  // Bible reference expansion
  var _BN = {
    '创': '创世记', '出': '出埃及记', '利': '利未记', '民': '民数记',
    '申': '申命记', '书': '约书亚记', '士': '士师记', '得': '路得记',
    '撒上': '撒母耳记上', '撒下': '撒母耳记下',
    '王上': '列王纪上', '王下': '列王纪下',
    '代上': '历代志上', '代下': '历代志下',
    '拉': '以斯拉记', '尼': '尼希米记', '斯': '以斯帖记',
    '伯': '约伯记', '诗': '诗篇', '箴': '箴言', '传': '传道书',
    '歌': '雅歌', '赛': '以赛亚书', '耶': '耶利米书',
    '哀': '耶利米哀歌', '结': '以西结书', '但': '但以理书',
    '何': '何西阿书', '珥': '约珥书', '摩': '阿摩司书',
    '俄': '俄巴底亚书', '拿': '约拿书', '弥': '弥迦书',
    '鸿': '那鸿书', '哈': '哈巴谷书', '番': '西番雅书',
    '该': '哈该书', '亚': '撒迦利亚书', '玛': '玛拉基书',
    '太': '马太福音', '可': '马可福音', '路': '路加福音',
    '约': '约翰福音', '徒': '使徒行传', '罗': '罗马书',
    '林前': '哥林多前书', '林后': '哥林多后书',
    '加': '加拉太书', '弗': '以弗所书', '腓': '腓立比书',
    '西': '歌罗西书',
    '帖前': '帖撒罗尼迦前书', '帖后': '帖撒罗尼迦后书',
    '提前': '提摩太前书', '提后': '提摩太后书',
    '门': '腓利门书', '来': '希伯来书', '雅': '雅各书',
    '彼前': '彼得前书', '彼后': '彼得后书',
    '约壹': '约翰壹书', '约贰': '约翰贰书', '约叁': '约翰叁书',
    '犹': '犹大书', '启': '启示录', '多': '提多书'
  };

  var _PIAN = { '诗': 1 };

  function _numToCN(n) {
    n = parseInt(n, 10);
    if (isNaN(n) || n <= 0) return String(n);
    var d = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (n < 10) return d[n];
    if (n < 20) return '十' + (n > 10 ? d[n - 10] : '');
    if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
    var h = Math.floor(n / 100), r = n % 100;
    if (r === 0) return d[h] + '百';
    if (r < 10) return d[h] + '百零' + d[r];
    return d[h] + '百' + _numToCN(r);
  }

  function _parseRef(ref) {
    ref = (ref || '').trim();
    var m = ref.match(/^([^\d:]{1,3})(\d+):(\d+)([上下]?)$/);
    if (!m) return null;
    return { book: m[1], chapter: parseInt(m[2], 10), verse: parseInt(m[3], 10), suffix: m[4] };
  }

  function _expandRef(p) {
    var full = _BN[p.book] || p.book;
    var chWord = _PIAN[p.book] ? '篇' : '章';
    if (p.verse === 0) return full + _numToCN(p.chapter) + chWord;
    return full + _numToCN(p.chapter) + chWord + _numToCN(p.verse) + '节' + (p.suffix || '');
  }

  function expandDataRefs(refs) {
    if (!refs) return '';
    var parts = (refs + '').split(',').map(function (r) { return r.trim(); }).filter(Boolean);
    if (!parts.length) return '';
    var result = [], i = 0;
    while (i < parts.length) {
      var p = _parseRef(parts[i]);
      if (!p) { result.push(parts[i]); i++; continue; }
      if (p.verse === 0) { result.push(_expandRef(p)); i++; continue; }
      var j = i + 1;
      while (j < parts.length) {
        var q = _parseRef(parts[j]);
        if (!q || q.book !== p.book || q.chapter !== p.chapter) break;
        j++;
      }
      if (j === i + 1) {
        result.push(_expandRef(p));
      } else {
        var last = _parseRef(parts[j - 1]);
        result.push(_expandRef(p) + '至' + _numToCN(last.verse) + '节' + (last.suffix || ''));
      }
      i = j;
    }
    return result.join('，');
  }

  function formatTime(seconds) {
    var s = Math.max(0, Math.floor(seconds || 0));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function estimateTotalSeconds(text, rate) {
    var r = Math.max(0.1, Number(rate) || 1);
    return Math.max(1, Math.ceil((text || '').length / (250 * r) * 60));
  }

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  // -- Init -----------------------------------------------------------------

  function init(options) {
    var getElements = options && typeof options.getElements === 'function' ? options.getElements : null;
    if (!getElements) return;
    if (window.BKSpeech && typeof window.BKSpeech.cancel === 'function') {
      try { window.BKSpeech.cancel(); } catch(e) {}
    }

    var _sentenceMarkData = [];

    function restoreElement(injected) {
      if (injected._savedParenTN) {
        injected._savedParenTN.forEach(function(s) {
          try { if (s.tn.parentNode) s.tn.nodeValue = s.orig; } catch(e) {}
        });
      }
      var el = injected.el;
      if (!el) return;
      var marks = Array.prototype.slice.call(el.querySelectorAll('mark.bk-tts-sent'));
      marks.forEach(function(mark) {
        var parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      });
      try { el.normalize(); } catch(e) {}
    }

    function clearSentenceMarks() {
      _sentenceMarkData.forEach(function(inj) { try { restoreElement(inj); } catch(e) {} });
      _sentenceMarkData = [];
    }

    function withExpanded(fn) {
      var spans = Array.prototype.slice.call(document.querySelectorAll('.scripture-ref[data-refs]'));
      var tnMap = [];
      spans.forEach(function (span) {
        var txt = (span.textContent || '').trim();
        if (!span.parentNode) { tnMap.push(null); return; }
        var expanded = expandDataRefs(span.getAttribute('data-refs'));
        if (!expanded) { tnMap.push(null); return; }
        var wrapper = document.createElement('span');
        wrapper.className = 'bk-tts-expand-tmp';
        wrapper.textContent = expanded;
        var parent = span.parentNode;
        var next = span.nextSibling;
        parent.replaceChild(wrapper, span);
        tnMap.push({tn: wrapper, span: span, parent: parent, next: next});
      });

      var result = fn();

      spans.forEach(function (span, idx) {
        var item = tnMap[idx];
        if (!item) return;
        if (item.tn && item.tn.parentNode) {
          try { item.tn.parentNode.replaceChild(item.span, item.tn); } catch (e) {}
        }
      });
      return result;
    }

    var lang = (options && options.lang) || 'zh-CN';
    var title = (options && options.title) || document.title || '朗读';

    var controlsDiv  = byId('bottomControlBar') || byId('speechControls');
    var playPauseBtn = byId('playPauseBtn');
    var rateSelect   = byId('rateSelect');
    var speechTime   = byId('speechTime');
    var progressBar  = byId('progressBar');

    if (!playPauseBtn || !rateSelect || !speechTime || !progressBar || !controlsDiv) return;

    // -- Engine detection ---------------------------------------------------

    function getNativeTTS() {
      return window.Capacitor &&
             window.Capacitor.Plugins &&
             window.Capacitor.Plugins.NativeTTS &&
             typeof window.Capacitor.Plugins.NativeTTS.speak === 'function'
        ? window.Capacitor.Plugins.NativeTTS
        : null;
    }

    function detectEngine() {
      var isNative = !!(window.Capacitor &&
                        typeof window.Capacitor.isNativePlatform === 'function' &&
                        window.Capacitor.isNativePlatform());
      var nativeTTS    = getNativeTTS();
      var hasWebSpeech = ('speechSynthesis' in window) && ('SpeechSynthesisUtterance' in window);
      return {
        isNative: isNative,
        useNativeTTS: !!nativeTTS,
        useWebSpeech: !nativeTTS && hasWebSpeech,
        supported: !!nativeTTS || hasWebSpeech
      };
    }

    function showUnsupported(message) {
      playPauseBtn.style.display = 'none';
      progressBar.style.display  = 'none';
      rateSelect.style.display   = 'none';
      speechTime.textContent     = message;
      speechTime.style.color     = '#999';
      speechTime.style.fontSize  = '11px';
      speechTime.style.textAlign = 'center';
    }

    controlsDiv.style.display = 'flex';

    var initAttempts = 0;

    function startInit() {
      var engine = detectEngine();
      if (engine.isNative && !engine.useNativeTTS && initAttempts < 10) {
        initAttempts++;
        setTimeout(startInit, 150);
        return;
      }
      if (!engine.supported) {
        showUnsupported(engine.isNative ? '朗读插件未就绪' : '朗读暂不可用');
        return;
      }

      var useNativeTTS = engine.useNativeTTS;
      var useWebSpeech = engine.useWebSpeech;

      var playIcon  = playPauseBtn.querySelector('.play-icon');
      var pauseIcon = playPauseBtn.querySelector('.pause-icon');

      var savedRate = localStorage.getItem('bk_speechRate');
      if (savedRate) rateSelect.value = savedRate;

      var state = 'idle';
      var fullText = '';
      var totalDuration = 0;
      var elapsedOffset = 0;
      var startTime = 0;
      var progressInterval = null;
      var isSeeking = false;
      var speakGeneration = 0;
      var _segmentMap = [];
      var _prevTTSEl = null;

      function setState(s) {
        state = s;
        var playing = (s === 'playing');
        if (playIcon && pauseIcon) {
          playIcon.style.display  = playing ? 'none' : 'inline';
          pauseIcon.style.display = playing ? 'inline' : 'none';
        }
        playPauseBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
      }

      // -- TTS sentence-level highlighting ----------------------------------

      function injectSentenceMarks(el) {
        var origChildren = Array.prototype.slice.call(el.childNodes);
        if (!origChildren.length) return null;
        var marks = [];
        var frag  = document.createDocumentFragment();
        var cur   = document.createElement('mark');
        cur.className = 'bk-tts-sent';
        var hasContent = false;

        function flushCur() {
          if (!hasContent) return;
          frag.appendChild(cur);
          marks.push(cur);
          cur = document.createElement('mark');
          cur.className = 'bk-tts-sent';
          hasContent = false;
        }

        origChildren.forEach(function(node) {
          if (node.nodeType === 3) {
            var text = node.nodeValue;
            var re = /[。！？；]/g;
            var m, last = 0;
            while ((m = re.exec(text)) !== null) {
              cur.appendChild(document.createTextNode(text.slice(last, m.index + 1)));
              hasContent = true;
              last = m.index + 1;
              flushCur();
            }
            if (last < text.length) {
              cur.appendChild(document.createTextNode(text.slice(last)));
              hasContent = true;
            }
          } else {
            cur.appendChild(node);
            hasContent = true;
            if (/[。！？；]$/.test(node.textContent)) flushCur();
          }
        });
        flushCur();

        if (!marks.length) return null;
        while (el.firstChild) el.removeChild(el.firstChild);
        el.appendChild(frag);
        return {marks: marks, origChildren: origChildren, el: el};
      }

      // ── 构建朗读文本（适配纯文本与结构化 content）──────────────────
      // buildAll 从 DOM 元素中提取文本，构建完整朗读内容。
      // 对于 zl-html 纯文本渲染后的 DOM，同样能正确提取。
      function buildAll() {
        return withExpanded(function() {
          clearSentenceMarks();
          _segmentMap = [];
          fullText = '';
          if (!getElements) return;
          var segs = getElements();
          segs.forEach(function(seg) {
            var el = seg.el;
            // 防御性检查：确保 el 存在且有文本内容
            if (!el) return;
            var rawText = '';
            try {
              var clone = el.cloneNode(true);
              // 移除不需要朗读的元素（按钮、脚本等）
              var removeSelectors = 'button, script, style, .no-tts';
              try {
                clone.querySelectorAll(removeSelectors).forEach(function(s){ s.remove(); });
              } catch(e) {}
              rawText = clone.textContent || '';
            } catch(e) {
              // 降级：直接取 textContent
              rawText = el.textContent || '';
            }

            // 对于纯文本段落（zl-html），标记为纯文本，避免过度清洗
            var filteredText = processText(rawText, true);
            if (!filteredText) return;

            var separator = '';
            if (fullText) {
              var lastChar = fullText[fullText.length - 1];
              separator = /[。！？；]/.test(lastChar) ? '' : '。';
            }
            var start = fullText.length + separator.length;
            fullText += separator + filteredText;
            var end = fullText.length;
            _segmentMap.push({el: el, start: start, end: end, speakText: filteredText});
          });
        });
      }

      function findSegmentAt(charPos) {
        for (var i = 0; i < _segmentMap.length; i++) {
          if (charPos < _segmentMap[i].end) return _segmentMap[i].el;
        }
        return _segmentMap.length ? _segmentMap[_segmentMap.length - 1].el : null;
      }

      function setTTSHighlight(el) {
        if (_prevTTSEl === el) return;
        if (_prevTTSEl) _prevTTSEl.classList.remove('bk-tts-active');
        _prevTTSEl = el;
        if (el) {
          el.classList.add('bk-tts-active');
          try { el.scrollIntoView({behavior: 'smooth', block: 'nearest'}); } catch(e) {}
        }
      }

      function clearTTSHighlight() {
        if (_prevTTSEl) { _prevTTSEl.classList.remove('bk-tts-active'); _prevTTSEl = null; }
        clearSentenceMarks();
        _segmentMap = [];
      }

      // -- Progress helpers ---------------------------------------------------

      function currentElapsedSeconds() {
        if (!totalDuration) return 0;
        if (!startTime) return clamp(elapsedOffset, 0, totalDuration);
        return clamp(elapsedOffset + (Date.now() - startTime) / 1000, 0, totalDuration);
      }

      function updateProgressUI() {
        if (!totalDuration) { progressBar.value = '0'; speechTime.textContent = '00:00 / 00:00'; return; }
        var elapsed = currentElapsedSeconds();
        progressBar.value = String(clamp((elapsed / totalDuration) * 100, 0, 100));
        speechTime.textContent = formatTime(elapsed) + ' / ' + formatTime(totalDuration);
        if (_segmentMap.length && fullText) {
          var ratio = clamp(elapsed / totalDuration, 0, 1);
          var charPos = Math.floor(ratio * fullText.length);
          setTTSHighlight(findSegmentAt(charPos));
        }
      }

      function startProgressUpdate() {
        if (progressInterval) return;
        progressInterval = setInterval(function () { if (!isSeeking) updateProgressUI(); }, 250);
      }

      function stopProgressUpdate() {
        if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
      }

      function resetState() {
        ++speakGeneration;
        stopProgressUpdate();
        clearTTSHighlight();
        if (useNativeTTS) {
          try { getNativeTTS().stop(); } catch(e) {}
        } else {
          try { window.speechSynthesis.cancel(); } catch (e) {}
        }
        fullText = '';
        elapsedOffset = 0; startTime = 0; totalDuration = 0;
        progressBar.value = '0';
        speechTime.textContent = '00:00 / 00:00';
        setState('idle');
      }

      // -- MediaSession ----------------------------------------------------

      function setupMediaSession() {
        if (!('mediaSession' in navigator)) return;
        try {
          navigator.mediaSession.setActionHandler('play', function () {
            if (state !== 'playing') playPauseBtn.click();
          });
          navigator.mediaSession.setActionHandler('pause', function () {
            if (state === 'playing') playPauseBtn.click();
          });
          navigator.mediaSession.setActionHandler('stop', function () {
            if (window.BKSpeech && window.BKSpeech.cancel) window.BKSpeech.cancel();
          });
        } catch (e) {}
      }

      // -- Web Speech path -------------------------------------------------

      function wsPlayChunk(text, startChar, endChar, gen) {
        return new Promise(function(resolve, reject) {
          if (gen !== speakGeneration) return reject('cancelled');
          var utt = new SpeechSynthesisUtterance(text);
          utt.lang = lang;
          utt.rate = Number(rateSelect.value) || 1;

          utt.onboundary = function(evt) {
            if (gen !== speakGeneration) return;
            if (evt.name === 'sentence' || evt.name === 'word') {
              var charPos = startChar + (evt.charIndex || 0);
              setTTSHighlight(findSegmentAt(charPos));
            }
          };

          utt.onend = function() {
            if (gen !== speakGeneration) return reject('cancelled');
            resolve();
          };

          utt.onerror = function(e) {
            if (e.error === 'interrupted' || e.error === 'canceled') return reject('cancelled');
            resolve();
          };

          try { window.speechSynthesis.speak(utt); } catch(e) { resolve(); }
        });
      }

      async function startSpeakingFromPercent(pct) {
        ++speakGeneration;
        var gen = speakGeneration;

        buildAll();
        if (!fullText) {
          speechTime.textContent = '无内容';
          return;
        }

        var rate = Number(rateSelect.value) || 1;
        totalDuration = estimateTotalSeconds(fullText, rate);
        speechTime.textContent = '00:00 / ' + formatTime(totalDuration);

        // 注入句子级标记
        _sentenceMarkData = [];
        _segmentMap.forEach(function(seg) {
          var inj = injectSentenceMarks(seg.el);
          if (inj) _sentenceMarkData.push(inj);
        });

        setState('playing');
        startProgressUpdate();
        setupMediaSession();

        if (useNativeTTS) {
          // NativeTTS — 将完整文本传递给原生插件
          var NativeTTS = getNativeTTS();
          if (NativeTTS) {
            try {
              await NativeTTS.speak({ text: fullText, rate: rate, lang: lang });
            } catch(e) {}
          }
          resetState();
        } else {
          // Web Speech - 分段朗读
          var chunkSize = 200;
          var pos = Math.floor(fullText.length * pct / 100);

          while (pos < fullText.length && gen === speakGeneration) {
            var end = Math.min(pos + chunkSize, fullText.length);
            // 尝试在句子边界切割
            var sentenceEnd = fullText.indexOf('。', pos + 10);
            if (sentenceEnd > 0 && sentenceEnd < end) end = sentenceEnd + 1;

            elapsedOffset = (pos / fullText.length) * totalDuration;
            startTime = Date.now();

            try {
              await wsPlayChunk(fullText.slice(pos, end), pos, end, gen);
            } catch(e) {
              break;
            }
            pos = end;
          }

          if (gen === speakGeneration) resetState();
        }
      }

      // -- Play/Pause button -----------------------------------------------

      playPauseBtn.addEventListener('click', function () {
        if (state === 'idle') {
          localStorage.setItem('bk_speechRate', rateSelect.value);
          startSpeakingFromPercent(0);
        } else if (state === 'playing') {
          elapsedOffset = currentElapsedSeconds();
          startTime = 0;
          if (useWebSpeech) { try { window.speechSynthesis.pause(); } catch(e) {} }
          setState('paused');
          stopProgressUpdate();
        } else if (state === 'paused') {
          startTime = Date.now();
          if (useWebSpeech) {
            try { window.speechSynthesis.resume(); } catch(e) {}
          }
          setState('playing');
          startProgressUpdate();
        }
      });

      rateSelect.addEventListener('change', function () {
        localStorage.setItem('bk_speechRate', rateSelect.value);
        if (state !== 'idle') {
          var pct = totalDuration > 0 ? (currentElapsedSeconds() / totalDuration * 100) : 0;
          resetState();
          startSpeakingFromPercent(pct);
        }
      });

      progressBar.addEventListener('input', function () {
        isSeeking = true;
      });

      progressBar.addEventListener('change', function () {
        isSeeking = false;
        var pct = Number(progressBar.value) || 0;
        if (state !== 'idle') {
          resetState();
          startSpeakingFromPercent(pct);
        }
      });

    } // end startInit

    startInit();

  } // end init

  function cancel() {
    try { window.speechSynthesis.cancel(); } catch(e) {}
    var playPauseBtn = byId('playPauseBtn');
    if (playPauseBtn) {
      var playIcon = playPauseBtn.querySelector('.play-icon');
      var pauseIcon = playPauseBtn.querySelector('.pause-icon');
      if (playIcon) playIcon.style.display = 'inline';
      if (pauseIcon) pauseIcon.style.display = 'none';
    }
  }

  // 导出 normalizeContent 供外部（如章节级 TTS）使用
  window.BKSpeech = { init: init, cancel: cancel, normalizeContent: normalizeContent };

})();