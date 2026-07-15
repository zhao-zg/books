  /* ═══════════════════════════ 自动标注正文 ═══════════════════════════ */
  function annotateInlineRefs() {
    var paras = document.querySelectorAll('.content-text, .bk-paragraph');
    paras.forEach(function (p) {
      // 获取所有文本节点（跳过已有 span 内部的文本）
      var walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, null);
      var textNodes = [];
      var node;
      while (node = walker.nextNode()) {
        // 跳过已在 scripture-ref / verse-ref / fn-ref / xref-ref span 内的文本
        var parent = node.parentElement;
        if (parent && parent.closest && parent.closest('.scripture-ref, .verse-ref, .fn-ref, .xref-ref, .bk-highlight')) continue;
        if (node.textContent.length > 0) textNodes.push(node);
      }

      textNodes.forEach(function (tn) {
        var text = tn.textContent;
        INLINE_REF_RE.lastIndex = 0;
        if (!INLINE_REF_RE.test(text)) return;
        INLINE_REF_RE.lastIndex = 0;
        var frag = document.createDocumentFragment();
        var lastIdx = 0;
        var m;
        /* 单字书卷缩写字符集（用于判断匹配首字是否为经卷缩写） */
        var _bookAbbrChars = '创出利民申书士得撒王代拉尼斯伯诗箴传歌赛耶哀结但何珥摩俄拿弥鸿哈番该亚玛太可路约徒罗林加弗腓西帖提门多来雅彼犹启';
        /* CJK 字符判断 */
        var _isCJK = /[\u4e00-\u9fff]/;
        while ((m = INLINE_REF_RE.exec(text)) !== null) {
          if (m.index > lastIdx) {
            frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
          }
          var matched = m[0];
          /* ── 防误识别过滤 ──
           * 弹框内自动标注的 INLINE_REF_RE 不含 ref-detector 的上下文过滤规则，
           * 需在此补充关键检查，防止普通汉语被误标为经文引用。
           */
          var _skip = false;
          /* 过滤A：匹配首字为单字经卷缩写，且匹配文本完全不含阿拉伯数字
           * → 很可能是普通汉语数量表达（如"约四十卫星""大约四十人""约三百勇士"），
           *   而非经文引用（合法引用必须有阿拉伯节号，如"约四19"）
           */
          if (matched.length >= 2 && _bookAbbrChars.indexOf(matched[0]) >= 0 && !/\d/.test(matched)) {
            _skip = true;
          }
          /* 过滤B：匹配前一个字符为"大/新/旧/圣/和/平/盟/条"等修饰字
           * → 构成复合词（"大约""新约""旧约""圣约""和约""平约""盟约""条约"），
           *   其中的单字并非经卷缩写
           */
          if (!_skip && m.index > 0) {
            var prevChar = text[m.index - 1];
            if (_isCJK.test(prevChar) && '大新旧圣和平盟条协签'.indexOf(prevChar) >= 0
                && _bookAbbrChars.indexOf(matched[0]) >= 0) {
              _skip = true;
            }
          }
          if (_skip) {
            frag.appendChild(document.createTextNode(matched));
          } else {
            var span = document.createElement('span');
            span.className = 'scripture-ref scripture-ref--inline';
            span.setAttribute('data-refs', m[1] || m[0]);
            span.textContent = matched;
            frag.appendChild(span);
          }
          lastIdx = INLINE_REF_RE.lastIndex;
        }
        if (lastIdx < text.length) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        }
        tn.parentNode.replaceChild(frag, tn);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', annotateInlineRefs);
  } else {
    annotateInlineRefs();
  }

  /* ═══════════════════════════ 自动渲染 scripture-block ═══════════════════════════ */
  /* .scripture-block[data-refs] 行内经文块（晨兴喂养等），带注脚和串珠上标 */
  function renderScriptureBlocks() {
    var blocks = document.querySelectorAll('.scripture-block[data-refs]');
    if (!blocks.length) return;
    ensureBibleText(function () {
      blocks.forEach(function (block) {
        if (block.hasAttribute('data-rendered')) return;
        block.setAttribute('data-rendered', '1');
        var refs = (block.dataset.refs || '').trim();
        if (!refs) return;
        block.innerHTML = renderVerseList(refs);
      });
      // 经文块渲染完成后，通知 highlight.js 重新计算字符偏移并恢复划线
      if (window.BKHighlight && window.BKHighlight.rendoHighlights) {
        window.BKHighlight.rendoHighlights();
      }
      // 经文块撑开内容后，通知翻页布局重新计算容器高度（避免 overflow:hidden 截断最后段落）
      document.dispatchEvent(new CustomEvent('cx:scriptureBlocksRendered'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderScriptureBlocks);
  } else {
    renderScriptureBlocks();
  }

  /* ═══════════════════════════ 静态经文块（锚文本对齐注入注解/串珠）═══════════════ */
  /* .scripture-block-static[data-refs]：保留文档原文，从 bible-text.json 找到
   * {N}/[a] 在 JSON 经文中的位置：
   *   - 标记前有文字 → 取末尾 8 字作 lookback，在文档原文中搜索，插在其后
   *   - 标记前无文字 → 取标记后 8 字作 lookahead，在文档原文中搜索，插在其前
   * 找不到对应文字 → 跳过（文档经文不全）。 */
  function renderScriptureStaticBlocks() {
    var blocks = document.querySelectorAll('.scripture-block-static[data-refs]');
    if (!blocks.length) return;
    ensureBibleText(function () {
      blocks.forEach(function (block) {
        if (block.hasAttribute('data-rendered')) return;
        block.setAttribute('data-rendered', '1');
        var refs = (block.dataset.refs || '').trim();
        if (!refs) return;
        var dict = window.BK_SCRIPTURES_DATA || {};
        var docText = block.textContent;
        var ctxBook = getBookFromRef((refs.split(',')[0] || '').trim());
        var refArr = parseAndExpandRefs(refs, dict, ctxBook);

        /* 从所有 ref 的 JSON 文本里，按出现顺序收集注入点 */
        var injections = [];
        refArr.forEach(function (ref) {
          var nr = normalizeRef(ref) || ref;
          var bk = baseKey(nr);
          var raw = dict[nr] || (bk !== nr ? dict[bk] : '');
          if (!raw) return;
          var MRE = /\{(\d+)\}|\[([a-z]+)\]/g, lastEnd = 0, mm;
          while ((mm = MRE.exec(raw)) !== null) {
          /* 剥除 {N}/[a] 标记后再提取锚定文字，避免相邻标记干扰 */
          var STRIP_MARKS = /\{\d+\}|\[[a-z]+\]/g;
          var prefix = raw.slice(lastEnd, mm.index).replace(STRIP_MARKS, '');
          var lookback  = prefix.replace(/[\s\u3000\u00a0]/g, '').slice(-8);
          var suffix    = raw.slice(mm.index + mm[0].length).replace(STRIP_MARKS, '');
            var lookahead = suffix.replace(/[\s\u3000\u00a0]/g, '').slice(0, 8);
            var mhtml = mm[1]
              ? '<sup class="fn-ref" data-vkey="' + esc(nr) + '" data-fn="' + mm[1] + '">' + mm[1] + '</sup>'
              : '<sup class="xref-ref" data-vkey="' + esc(nr) + '" data-xr="' + mm[2] + '">' + mm[2] + '</sup>';
            injections.push({ lookback: lookback, lookahead: lookahead, html: mhtml });
            lastEnd = mm.index + mm[0].length;
          }
        });

        if (!injections.length) { block.innerHTML = esc(docText); return; }

        /* 依次在 docText 中定位每个注入点 */
        var parts = [];
        var searchFrom = 0;

        injections.forEach(function (inj) {
          var insertPos = -1;

          if (inj.lookback) {
            /* 优先用 lookback：在 lookback 文字之后插入 */
            var idx = docText.indexOf(inj.lookback, searchFrom);
            if (idx !== -1) {
              insertPos = idx + inj.lookback.length;
            } else if (inj.lookback.length > 3) {
              idx = docText.indexOf(inj.lookback.slice(-4), searchFrom);
              if (idx !== -1) insertPos = idx + inj.lookback.slice(-4).length;
            }
          }

          if (insertPos === -1 && inj.lookahead) {
            /* lookback 找不到（或为空）→ 用 lookahead：在 lookahead 文字之前插入 */
            /* 依次尝试 8‑字符、4‑字符、2‑字符，处理文档省略号截断的情形 */
            var laFull = inj.lookahead;
            var laTrys = [laFull, laFull.slice(0, 4), laFull.slice(0, 2)];
            for (var _li = 0; _li < laTrys.length; _li++) {
              if (!laTrys[_li]) continue;
              var idx2 = docText.indexOf(laTrys[_li], searchFrom);
              if (idx2 !== -1) { insertPos = idx2; break; }
            }
          }

          if (insertPos !== -1) {
            parts.push({ pos: insertPos, html: inj.html });
            searchFrom = insertPos;
          }
          /* 两者都找不到 → 文档经文不全，跳过 */
        });

        /* 按位置升序排列，拼接最终 HTML */
        parts.sort(function (a, b) { return a.pos - b.pos; });
        var out = '', lastPos = 0;
        parts.forEach(function (part) {
          out += esc(docText.slice(lastPos, part.pos)) + part.html;
          lastPos = part.pos;
        });
        out += esc(docText.slice(lastPos));
        block.innerHTML = out;
      });
      if (window.BKHighlight && window.BKHighlight.rendoHighlights) {
        window.BKHighlight.rendoHighlights();
      }
      document.dispatchEvent(new CustomEvent('cx:scriptureBlocksRendered'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderScriptureStaticBlocks);
  } else {
    renderScriptureStaticBlocks();
  }

