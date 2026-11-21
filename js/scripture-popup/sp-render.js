  /* ═══════════════════════════ 渲染经文帧 ═══════════════════════════ */
  /*
   * frame = { type:'verses', refs:'创1:1,创1:2', label:'...' }
   *       | { type:'footnote', verseKey:'创1:1', num:'1' }
   *       | { type:'xrefs', verseKey:'创1:1', letter:'a' }
   */
  function renderFrame(frame) {
    var m = getModal();
    m.backBtn.style.display = navStack.length > 1 ? '' : 'none';

    if (frame.type === 'verses') {
      m.title.textContent = frame.label || (frame.refs || '').replace(/,/g, '、');
      if (window.BK_BIBLE_TEXT_READY) {
        /* 数据已缓存（预加载），直接渲染，避免 loading→内容 双重 innerHTML 导致闪屏 */
        m.body.innerHTML = renderVerseList(frame.refs, frame.verseKey || '', true);
        m.body.scrollTop = frame._scrollTop || 0;
      } else {
        m.body.innerHTML = '<div class="scripture-popup-loading">加载中…</div>';
        ensureBibleText(function () {
          m.body.innerHTML = renderVerseList(frame.refs, frame.verseKey || '', true);
          m.body.scrollTop = frame._scrollTop || 0;
        });
      }
    } else if (frame.type === 'footnote') {
      m.title.textContent = frame.verseKey + ' 注' + frame.num;
      /* renderFootnote: 统一的注解查找与渲染逻辑 */
      function renderFootnote() {
        var notes = window.BK_BIBLE_NOTES || {};
        var noteObj = notes[frame.verseKey] || {};
        /* 若精确键未命中，合并带 上/中/下 后缀的键（如 创1:2 → 创1:2上 + 创1:2下） */
        if (Object.keys(noteObj).length === 0) {
          var suffixes = ['上', '中', '下'];
          var merged = {};
          for (var si = 0; si < suffixes.length; si++) {
            var sk = frame.verseKey + suffixes[si];
            if (notes[sk]) {
              var sObj = notes[sk];
              var sKeys = Object.keys(sObj);
              for (var ski = 0; ski < sKeys.length; ski++) {
                merged[sKeys[ski]] = sObj[sKeys[ski]];
              }
            }
          }
          if (Object.keys(merged).length > 0) noteObj = merged;
        }
        /* 反向回退：若 verseKey 带后缀（如 创1:2上）且未命中，尝试基础键（创1:2） */
        if (Object.keys(noteObj).length === 0 && /[上中下]$/.test(frame.verseKey)) {
          var bk2 = frame.verseKey.replace(/[上中下]$/, '');
          noteObj = notes[bk2] || {};
        }
        /* 尝试多种键格式：原始字符串、去前导零、整数键 */
        var text = noteObj[frame.num];
        if (text === undefined) {
          var parsedNum = parseInt(frame.num, 10);
          text = noteObj[String(parsedNum)];
        }
        if (text === undefined) {
          /* 遍历 noteObj 的键做宽松匹配（兼容数字/字符串键不一致） */
          var numStr = String(parseInt(frame.num, 10));
          var keys = Object.keys(noteObj);
          for (var ki = 0; ki < keys.length; ki++) {
            if (String(parseInt(keys[ki], 10)) === numStr) {
              text = noteObj[keys[ki]];
              break;
            }
          }
        }
        if (text === undefined) {
          var hasData = Object.keys(notes).length > 0;
          text = hasData
            ? '（未找到 ' + frame.verseKey + ' 注' + frame.num + ' 的注解）'
            : '（注解数据加载失败，请稍后重试）';
        }
        return '<div class="scripture-popup-fn-body">' + renderNoteText(text, frame.verseKey) + '</div>';
      }
      if (window.BK_BIBLE_NOTES_READY && window.BK_BIBLE_NOTES) {
        m.body.innerHTML = renderFootnote();
        m.body.scrollTop = frame._scrollTop || 0;
      } else {
        m.body.innerHTML = '<div class="scripture-popup-loading">加载中…</div>';
        ensureBibleNotes(function () {
          m.body.innerHTML = renderFootnote();
          m.body.scrollTop = frame._scrollTop || 0;
        });
      }
    } else if (frame.type === 'xrefs') {
      m.title.textContent = frame.verseKey + ' 串' + frame.letter;
      if (window.BK_BIBLE_XREFS_READY && window.BK_BIBLE_XREFS && window.BK_BIBLE_TEXT_READY) {
        var xrefMap = (window.BK_BIBLE_XREFS || {})[frame.verseKey] || {};
        var refs = xrefMap[frame.letter] || '';
        if (refs) {
          m.body.innerHTML = renderVerseList(refs, frame.verseKey || '');
          m.body.scrollTop = frame._scrollTop || 0;
        } else {
          m.body.innerHTML = '<div class="scripture-popup-empty">（未找到串珠）</div>';
          m.body.scrollTop = 0;
        }
      } else {
        m.body.innerHTML = '<div class="scripture-popup-loading">加载中…</div>';
        ensureBibleXrefs(function () {
          var xrefMap2 = (window.BK_BIBLE_XREFS || {})[frame.verseKey] || {};
          var refs2 = xrefMap2[frame.letter] || '';
          if (refs2) {
            ensureBibleText(function () {
              m.body.innerHTML = renderVerseList(refs2, frame.verseKey || '');
              m.body.scrollTop = frame._scrollTop || 0;
            });
          } else {
            m.body.innerHTML = '<div class="scripture-popup-empty">（未找到串珠）</div>';
            m.body.scrollTop = 0;
          }
        });
      }
    }
  }

  /* 剥除上/下后缀，得到完整节键（用于查找注解/串珠） */
  function baseKey(ref) {
    return ref.replace(/[上中下]$/, '');
  }

  /* 渲染经文列表（支持 {N} → fn-ref, [a] → xref-ref） */
  function renderVerseList(refs, contextRef, withMeta) {
    var dict = window.BK_SCRIPTURES_DATA || {};
    /* 整章展开只从全本圣经 bible-text.json 里取节列表 */
    var bibleDict = window.BK_BIBLE_TEXT_DATA || dict;
    var contextBook = getBookFromRef(contextRef || '');
    /* 展开整章/区间引用，并规范化中文写法 */
    var refArr = parseAndExpandRefs(refs, bibleDict, contextBook);
    if (!refArr.length) return '<div class="scripture-popup-empty">暂无经文</div>';
    var html = refArr.map(function (ref) {
      ref = ref.trim();
      if (!ref) return '';
      var nr = normalizeRef(ref) || ref;
      var bk = baseKey(nr);               /* 去掉上/下，用于查注解/串珠 */
      /* 优先用半节文本，若无则退到完整节文本 */
      /* :0T = 标题专属引用，从 :0 键取内容，与普通经节同样渲染（支持注解/串珠） */
      if (nr.slice(-3) === ':0T') {
        var titleKey = nr.slice(0, -1); /* 诗22:0T → 诗22:0 */
        var titleLabel = titleKey.replace(/:0$/, ':标题'); /* 诗22:0 → 诗22:标题 */
        var titleRaw = dict[titleKey] || '';
        if (titleRaw) {
          return '<div class="scripture-popup-verse" data-vkey="' + esc(titleKey) + '">'
            + '<span class="scripture-popup-ref">' + esc(titleLabel) + '</span>'
            + '<span class="scripture-popup-text">' + renderVerseText(titleRaw, titleKey) + '</span>'
            + '</div>';
        }
        return '<div class="scripture-popup-verse scripture-popup-verse--missing">'
          + '<span class="scripture-popup-ref">' + esc(titleLabel) + '</span>'
          + '<span class="scripture-popup-text">（未收录标题）</span></div>';
      }
      var raw = dict[nr] || (bk !== nr ? dict[bk] : '');
      /* :0 整章引用首位标题行，同样用普通经节样式渲染 */
      if (raw && nr.slice(-2) === ':0') {
        var titleLabel0 = bk.replace(/:0$/, ':标题'); /* 诗22:0 → 诗22:标题 */
        return '<div class="scripture-popup-verse" data-vkey="' + esc(bk) + '">'
          + '<span class="scripture-popup-ref">' + esc(titleLabel0) + '</span>'
          + '<span class="scripture-popup-text">' + renderVerseText(raw, bk) + '</span>'
          + '</div>';
      }
      if (raw) {
        return '<div class="scripture-popup-verse" data-vkey="' + esc(nr) + '">'
          + '<span class="scripture-popup-ref">' + esc(ref) + '</span>'
          + '<span class="scripture-popup-text">' + renderVerseText(raw, bk, nr) + '</span>'
          + '</div>';
      }
      /* 无精确匹配时，尝试上/中/下半节合并显示 */
      if (!/[上中下]$/.test(nr)) {
        var upRaw = dict[nr + '上'], midRaw = dict[nr + '中'], downRaw = dict[nr + '下'];
        if (upRaw || midRaw || downRaw) {
          var combined = '';
          if (upRaw) combined += '<div class="scripture-popup-verse" data-vkey="' + esc(nr + '上') + '">'
            + '<span class="scripture-popup-ref">' + esc(ref + '上') + '</span>'
            + '<span class="scripture-popup-text">' + renderVerseText(upRaw, bk, nr + '上') + '</span></div>';
          if (midRaw) combined += '<div class="scripture-popup-verse" data-vkey="' + esc(nr + '中') + '">'
            + '<span class="scripture-popup-ref">' + esc(ref + '中') + '</span>'
            + '<span class="scripture-popup-text">' + renderVerseText(midRaw, bk, nr + '中') + '</span></div>';
          if (downRaw) combined += '<div class="scripture-popup-verse" data-vkey="' + esc(nr + '下') + '">'
            + '<span class="scripture-popup-ref">' + esc(ref + '下') + '</span>'
            + '<span class="scripture-popup-text">' + renderVerseText(downRaw, bk, nr + '下') + '</span></div>';
          return combined;
        }
      }
      return '<div class="scripture-popup-verse scripture-popup-verse--missing">'
        + '<span class="scripture-popup-ref">' + esc(ref) + '</span>'
        + '<span class="scripture-popup-text">（未收录）</span>'
        + '</div>';
    }).join('');
    if (withMeta) {
      html += '<div class="scripture-popup-meta">'
        + '<div class="scripture-popup-source">' + esc(refs) + '</div>'
        + '<span class="bk-chip-sage">已检测到经文引用</span>'
        + '</div>';
    }
    return html;
  }

  /* 把 {N} 转为注脚上标，[a] 转为串珠上标 */
  /* dataVkey: 用于 fn-ref/xref-ref 的 data-vkey（含上中下后缀，精确匹配 notes/xrefs 键） */
  function renderVerseText(raw, verseKey, dataVkey) {
    var vk = dataVkey || verseKey;
    var text = esc(raw);
    /* {N} → fn-ref */
    text = text.replace(/\{(\d+)\}/g, function (_, n) {
      return '<sup class="fn-ref" data-vkey="' + esc(vk) + '" data-fn="' + n + '">' + n + '</sup>';
    });
    /* [a] → xref-ref */
    text = text.replace(/\[([a-z]+)\]/g, function (_, lr) {
      return '<sup class="xref-ref" data-vkey="' + esc(vk) + '" data-xr="' + lr + '">' + lr + '</sup>';
    });
    return text;
  }

  /* 渲染注解文字（内嵌经文引用变为可点击，verseKey 提供书卷上下文） */
  function renderNoteText(text, verseKey) {
    if (window.BKRef && window.BKRef.wrapRefs) {
      return window.BKRef.wrapRefs(text, verseKey || '', { lockBook: true })
        .replace(/\n/g, '<br>');
    }
    return esc(text)
      .replace(
        INLINE_REF_RE,
        '<span class="verse-ref" data-refs="$1">$1</span>'
      )
      .replace(/\n/g, '<br>');
  }

  /* 确保弹框已打开（fn-ref/xref-ref 可能在弹框外点击）*/
  /* backStack push 由后续 navPush 完成，此处只负责打开 overlay */
  function ensureOpen() {
    var m = getModal();
    if (!m.overlay.classList.contains('scripture-popup-overlay--open')) {
      navStack = [];
      m.overlay.classList.add('scripture-popup-overlay--open');
      m.overlay.setAttribute('aria-hidden', 'false');
    }
  }

