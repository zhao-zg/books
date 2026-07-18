'use strict';

  // ── 通用片段：底部控制栏（TTS） ──────────────────────────────────────

  function buildBottomControlBar() {
    return '' +
      '<div class="bottom-control-bar" id="bottomControlBar" style="display:none;">' +
        '<button class="control-btn play-pause-btn" id="playPauseBtn" title="播放/暂停" aria-label="播放">' +
          '<span class="play-icon">▶</span>' +
          '<span class="pause-icon" style="display:none;">⏸</span>' +
        '</button>' +
        '<div class="progress-section">' +
          '<div class="progress-column">' +
            '<input type="range" id="progressBar" class="progress-bar" min="0" max="100" value="0" step="0.1">' +
            '<span class="speech-time" id="speechTime">00:00 / 00:00</span>' +
          '</div>' +
          '<select id="rateSelect" class="control-select" title="语速">' +
            '<option value="0.5">0.5x</option>' +
            '<option value="0.75">0.75x</option>' +
            '<option value="1" selected>1x</option>' +
            '<option value="1.25">1.25x</option>' +
            '<option value="1.5">1.5x</option>' +
            '<option value="2">2x</option>' +
          '</select>' +
        '</div>' +
      '</div>';
  }

  // ── Content → HTML 渲染 ──────────────────────────────────────────────

  function renderContentItem(item, ctx, eager) {
    if (!item) return '';
    var type = item.type || 'paragraph';
    var text = item.text || '';
    var html = '';

    switch (type) {
      case 'heading':
        var level = item.level || 2;
        level = Math.max(1, Math.min(6, level));
        var hStyleAttr = item.style ? ' style="' + escAttr(item.style) + '"' : '';
        var hCls = 'bk-heading bk-h' + level;
        if (item.epubClass) hCls += ' bk-epub-' + item.epubClass;
        html = '<h' + level + ' class="' + hCls + '"' + hStyleAttr + '>' +
          (item.html ? wrapRefsRich(item.html, ctx) : wrapRefs(text, ctx)) + '</h' + level + '>';
        break;

      case 'quote':
        var qStyleAttr = item.style ? ' style="' + escAttr(item.style) + '"' : '';
        var qCls = 'bk-quote';
        if (item.epubClass) qCls += ' bk-epub-' + item.epubClass;
        html = '<blockquote class="' + qCls + '"' + qStyleAttr + '>' +
          '<div class="bk-quote-content">' +
          (item.html ? wrapRefsRich(item.html, ctx) : wrapRefs(text, ctx)) + '</div>' +
          '</blockquote>';
        break;

      case 'image':
        var src = item.src || '';
        var alt = item.attrs && item.attrs.alt || '';
        // 图片链接：[![alt](img)](href) 模式，图片可点击跳转
        var imgLinkUrl = item.linkUrl || '';
        // 预览页（carousel prev/next）需要立即加载图片，否则滑动时视口外图片因 lazy 未加载而显示空白
        var imgLoading = eager ? 'eager' : 'lazy';
        var imgTag = '<img src="' + escAttr(src) + '" alt="' + escAttr(alt || text) + '" loading="' + imgLoading + '">';
        html = '<figure class="bk-figure">' +
          (imgLinkUrl ? '<a href="' + escAttr(imgLinkUrl) + '" target="_blank" rel="noopener noreferrer">' + imgTag + '</a>' : imgTag) +
          (text ? '<figcaption>' + escText(text) + '</figcaption>' : '') +
          '</figure>';
        break;

      case 'list':
        var items = item.items || [];
        var itemHtmls = item.itemHtmls || [];
        var ordered = item.attrs && item.attrs.ordered;
        var checkboxes = item.checkboxes || null;
        var tag = ordered ? 'ol' : 'ul';
        html = '<' + tag + ' class="bk-list">';
        for (var i = 0; i < items.length; i++) {
          var liContent = (itemHtmls[i] != null) ? wrapRefsRich(itemHtmls[i], ctx) : wrapRefs(items[i], ctx);
          // 任务列表：渲染 checkbox
          var cbHtml = '';
          if (checkboxes && i < checkboxes.length) {
            cbHtml = '<input type="checkbox" class="bk-task-checkbox"' + (checkboxes[i] ? ' checked' : '') + ' disabled>';
          }
          html += '<li>' + cbHtml + liContent + '</li>';
        }
        html += '</' + tag + '>';
        break;

      case 'code':
        var lang = (item.attrs && item.attrs.language) || '';
        var codeInner = item.html || escText(text);
        html = '<pre class="bk-code' + (lang ? ' language-' + escAttr(lang) : '') + ' hljs"><code' +
          (lang ? ' class="language-' + escAttr(lang) + '"' : '') + '>' + codeInner + '</code></pre>';
        break;

      case 'mermaid':
        html = '<div class="bk-mermaid"><pre class="mermaid">' + escText(text) + '</pre></div>';
        break;

      case 'math':
        html = '<div class="bk-math">' + (item.html || escText(text)) + '</div>';
        break;

      case 'footnote_ref':
        html = item.html || '';
        break;

      case 'footnotes_section':
        // 兼容旧格式（html 直接渲染）和新格式（footnoteRefs 数组）
        if (item.footnoteRefs && item.footnoteRefs.length) {
          html = '<section class="bk-footnotes-section">';
          html += '<h3 class="bk-footnotes-title">脚注</h3>';
          for (var fnri = 0; fnri < item.footnoteRefs.length; fnri++) {
            var fnr = item.footnoteRefs[fnri];
            var fnrRawId = (fnr.attrs && fnr.attrs.id) || '';
            var fnrDisplayNum = fnri + 1;
            var fnrText = fnr.html || wrapRefs(fnr.text || '', ctx);
            html += '<div class="bk-footnote" id="fn-' + escAttr(fnrRawId || String(fnrDisplayNum)) + '">';
            html += '<span class="bk-fn-number">' + escText(String(fnrDisplayNum)) + '</span>';
            html += '<div class="bk-fn-text">' + fnrText + '</div>';
            html += '</div>';
          }
          html += '</section>';
        } else {
          html = '<section class="bk-footnotes-section">' + (item.html || '') + '</section>';
        }
        break;

      case 'footnote':
        var fnId = (item.attrs && item.attrs.id) || '';
        html = '<div class="bk-footnote" id="fn-' + escAttr(fnId) + '">' +
          '<span class="bk-fn-number">' + escText(fnId) + '</span>' +
          '<div class="bk-fn-text">' + wrapRefs(text, ctx) + '</div>' +
          '</div>';
        break;

      case 'pdf_page':
        var pgNum = item.pageNumber || 1;
        var pdfBkId = item.pdfBookId || '';
        html = '<div class="bk-pdf-page" data-pdf-page="' + pgNum + '" data-pdf-book="' + escAttr(pdfBkId) + '">' +
          '<div class="bk-pdf-page-placeholder"><span>第 ' + pgNum + ' 页</span></div>' +
          '<canvas class="bk-pdf-canvas"></canvas>' +
          '</div>';
        break;

      case 'separator':
        html = '<hr class="bk-separator">';
        break;

      case 'linebreak':
        html = '<br class="bk-linebreak">';
        break;

      case 'table':
        var tRows = item.rows || [];
        if (tRows.length) {
          html = '<table class="bk-table">';
          for (var ri2 = 0; ri2 < tRows.length; ri2++) {
            var row2 = tRows[ri2];
            html += '<tr>';
            var cells2 = row2.cells || [];
            for (var ci4 = 0; ci4 < cells2.length; ci4++) {
              var cell2 = cells2[ci4];
              var cellTag2 = row2.header ? 'th' : 'td';
              var cellContent2 = cell2.html
                ? wrapRefsRich(cell2.html, ctx)
                : wrapRefs(cell2.text || '', ctx);
              html += '<' + cellTag2 + '>' + cellContent2 + '</' + cellTag2 + '>';
            }
            html += '</tr>';
          }
          html += '</table>';
        }
        break;

      case 'paragraph':
      default:
        if (text || item.html) {
          var pStyleAttr = item.style ? ' style="' + escAttr(item.style) + '"' : '';
          // EPUB 语义类：为大纲层级、晨兴等段落添加对应 CSS 类
          var pCls = 'bk-paragraph';
          if (item.epubClass) pCls += ' bk-epub-' + item.epubClass;
          html = '<p class="' + pCls + '"' + pStyleAttr + '>' +
            (item.html ? wrapRefsRich(item.html, ctx) : wrapRefs(text, ctx)) + '</p>';
        }
        break;
    }
    return html;
  }

  function renderChapterContent(chapter, eager) {
    var contentArr = chapter.content || [];
    var html = '';

    // 当页章节标题：固定在正文顶部展示，浮动导航自动收起后仍可见当前章节
    var pageTitle = chapter.title || ('第' + (chapter.number != null ? chapter.number : '') + '章');
    html += '<h1 class="bk-page-title">' + escText(pageTitle) + '</h1>';

    // 从章节标题提取初始经文上下文
    // 例如标题 "约翰福音" → scanCtx 可识别出 "约" 书卷
    // 例如标题 "第十三章" → 在已有书卷基础上识别章号
    var ctx = '';
    if (win.BKRef && win.BKRef.scanCtx) {
      // 先尝试从 chapter 元数据获取 scripture 字段（cx 兼容）
      if (chapter.scripture) {
        ctx = chapter.scripture;
      } else if (chapter.title) {
        // 从标题中提取：如果标题含书卷名（如"约翰福音"、"创世记"）
        ctx = win.BKRef.scanCtx(chapter.title, '');
      }
    }

    // 兼容：如果 content 是字符串（未经转换的纯文本），按 \n 拆分渲染
    if (typeof contentArr === 'string') {
      var lines = contentArr.split('\n');
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (!line) continue;

        // 检测 heading 标记（## 开头）
        var headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
        if (headingMatch) {
          var level = Math.min(headingMatch[1].length, 6);
          var hText = headingMatch[2].trim();
          html += '<h' + level + ' class="bk-heading bk-h' + level + '">' + wrapRefs(hText, ctx) + '</h' + level + '>';
          // heading 通常包含书卷名或章节信息，优先更新上下文
          if (win.BKRef && win.BKRef.scanCtx) {
            ctx = win.BKRef.scanCtx(hText, ctx);
          }
        } else {
          html += '<p class="bk-paragraph">' + wrapRefs(line, ctx) + '</p>';
          // 段落也更新上下文
          if (win.BKRef && win.BKRef.scanCtx) {
            ctx = win.BKRef.scanCtx(line, ctx);
          }
        }
      }
      return html;
    }

    // 预扫描：如果初始 ctx 为空，从第一个 heading 项提取上下文
    if (!ctx && win.BKRef && win.BKRef.scanCtx) {
      for (var pi = 0; pi < contentArr.length; pi++) {
        var pItem = contentArr[pi];
        if (pItem && pItem.type === 'heading' && pItem.text) {
          ctx = win.BKRef.scanCtx(pItem.text, '');
          if (ctx) break;
        }
        // 如果已经遇到非 heading 的内容，停止预扫描
        if (pItem && pItem.type !== 'heading' && pItem.text) break;
      }
    }

    for (var i = 0; i < contentArr.length; i++) {
      var item = contentArr[i];
      html += renderContentItem(item, ctx, eager);
      // 对有文本内容的项更新经文上下文
      if (item && item.text && win.BKRef && win.BKRef.scanCtx) {
        ctx = win.BKRef.scanCtx(item.text, ctx);
      }
    }
    // 脚注区域
    var footnotes = chapter.footnotes || [];
    if (footnotes.length) {
      html += '<div class="bk-footnotes-section">';
      html += '<h3 class="bk-footnotes-title">脚注</h3>';
      for (var fi = 0; fi < footnotes.length; fi++) {
        var fn = footnotes[fi];
        html += '<div class="bk-footnote" id="fn-' + escAttr(fn.id || fi + 1) + '">';
        html += '<span class="bk-fn-number">' + escText(fn.id || (fi + 1)) + '</span>';
        html += '<div class="bk-fn-text">' + wrapRefs(fn.text || '', ctx) + '</div>';
        html += '</div>';
      }
      html += '</div>';
    }
    return html;
  }

  // ── Markdown 增强后处理：代码高亮、Mermaid 渲染、图片 Lightbox ──
  function _applyMdEnhancements(containerEl) {
    if (!containerEl) return;

    // 1. 代码语法高亮：对未高亮的 pre.bk-code > code 调用 hljs
    if (win.hljs) {
      var codeBlocks = containerEl.querySelectorAll('pre.bk-code code');
      for (var cb = 0; cb < codeBlocks.length; cb++) {
        var codeNode = codeBlocks[cb];
        // 如果 code 的子节点包含 span.hljs（已被 marked+hljs 高亮），跳过
        if (codeNode.querySelector('span.hljs-') || codeNode.querySelector('span[class^="hljs-"]')) continue;
        // 移除之前 escText 产生的纯文本内容，用 hljs 重新高亮
        if (!codeNode.hasAttribute('data-hljs-done')) {
          codeNode.setAttribute('data-hljs-done', '1');
          try { win.hljs.highlightElement(codeNode); } catch (e) {}
        }
      }
    }

    // 2. Mermaid 图表渲染
    if (win.mermaid) {
      var mermaidEls = containerEl.querySelectorAll('.bk-mermaid pre.mermaid');
      if (mermaidEls.length) {
        // 确保 mermaid 已初始化
        try {
          if (!win.mermaid._bkInitialized) {
            win.mermaid.initialize({
              startOnLoad: false,
              theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default',
              securityLevel: 'loose'
            });
            win.mermaid._bkInitialized = true;
          }
          win.mermaid.run({ nodes: Array.prototype.slice.call(mermaidEls) });
        } catch (e) {
          // mermaid 渲染失败时保留原始代码文本
        }
      }
    }

    // 3. 图片 Lightbox：点击放大
    var figures = containerEl.querySelectorAll('figure.bk-figure img');
    for (var fi = 0; fi < figures.length; fi++) {
      (function(img) {
        if (img._bkLightboxBound) return;
        img._bkLightboxBound = true;
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          _openLightbox(img.src, img.alt || '');
        });
      })(figures[fi]);
    }

    // 4. EPUB 脚注弹窗：点击 <sup class="bk-epub-fn-ref"> 显示对应脚注内容
    var fnRefs = containerEl.querySelectorAll('sup.bk-epub-fn-ref');
    for (var fnri = 0; fnri < fnRefs.length; fnri++) {
      (function(fnRef) {
        if (fnRef._bkFnBound) return;
        fnRef._bkFnBound = true;
        fnRef.style.cursor = 'pointer';
        fnRef.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          var fnId = fnRef.getAttribute('data-fn-id');
          _openFootnotePopup(fnId, fnRef);
        });
      })(fnRefs[fnri]);
    }
  }

  // EPUB 脚注弹窗
  function _openFootnotePopup(fnId, anchorEl) {
    // 查找对应脚注内容
    var fnEl = fnId ? document.getElementById('fn-' + fnId) : null;
    if (!fnEl) {
      // 降级：尝试通过 ID 直接查找
      fnEl = document.getElementById(fnId);
    }
    var fnText = fnEl ? fnEl.querySelector('.bk-fn-text') : null;
    if (!fnText) return;

    // 创建或复用弹窗
    var popup = document.getElementById('bk-epub-fn-popup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'bk-epub-fn-popup';
      popup.className = 'bk-epub-fn-popup';
      popup.innerHTML = '<div class="bk-epub-fn-popup-content"></div><div class="bk-epub-fn-popup-close">&times;</div>';
      popup.addEventListener('click', function(e) {
        if (e.target === popup || e.target.classList.contains('bk-epub-fn-popup-close')) {
          _closeFootnotePopup();
        }
      });
      document.body.appendChild(popup);

      // 创建遮罩层
      var mask = document.createElement('div');
      mask.id = 'bk-epub-fn-popup-mask';
      mask.className = 'bk-epub-fn-popup-mask';
      mask.addEventListener('click', _closeFootnotePopup);
      document.body.appendChild(mask);

      // 点击弹窗外部关闭
      document.addEventListener('click', _fnPopupOutsideClickHandler);
      // ESC 键关闭
      document.addEventListener('keydown', _fnPopupEscHandler);
      // 滚动关闭（阅读区域滚动时）
      var readerEl = document.querySelector('.bk-carousel-page') || document.querySelector('.bk-reader-content') || document.querySelector('.bk-reader-body') || containerEl;
      if (readerEl) {
        readerEl.addEventListener('scroll', _fnPopupScrollHandler);
      }
      // 同时监听 window scroll 作为兜底
      window.addEventListener('scroll', _fnPopupScrollHandler, true);
    }

    // 填充内容
    var contentDiv = popup.querySelector('.bk-epub-fn-popup-content');
    if (contentDiv) {
      contentDiv.innerHTML = fnText.innerHTML;
    }

    // 定位弹窗（在脚注标记附近）
    if (anchorEl) {
      var rect = anchorEl.getBoundingClientRect();
      var popupWidth = Math.min(480, window.innerWidth - 20);
      var popupHeight = Math.min(360, window.innerHeight * 0.6);
      var popupTop = rect.bottom + 8;
      var popupLeft = rect.left;

      // 右侧空间不足则右对齐
      if (popupLeft + popupWidth > window.innerWidth - 10) {
        popupLeft = window.innerWidth - popupWidth - 10;
      }
      popupLeft = Math.max(10, popupLeft);

      // 下方空间不足则向上弹出
      if (popupTop + popupHeight > window.innerHeight - 10) {
        popupTop = Math.max(10, rect.top - popupHeight - 8);
      }

      popup.style.top = popupTop + 'px';
      popup.style.left = popupLeft + 'px';
    }

    var maskEl = document.getElementById('bk-epub-fn-popup-mask');
    if (maskEl) maskEl.classList.add('bk-epub-fn-popup-mask-active');
    popup.classList.add('bk-epub-fn-popup-active');
  }

  // 关闭脚注弹窗
  function _closeFootnotePopup() {
    var popup = document.getElementById('bk-epub-fn-popup');
    var mask = document.getElementById('bk-epub-fn-popup-mask');
    if (popup) {
      popup.classList.remove('bk-epub-fn-popup-active');
    }
    if (mask) {
      mask.classList.remove('bk-epub-fn-popup-mask-active');
    }
  }

  // 脚注弹窗：点击外部关闭
  // 注意：遮罩层已有独立 click 监听，此处排除遮罩避免重复调用
  function _fnPopupOutsideClickHandler(e) {
    var popup = document.getElementById('bk-epub-fn-popup');
    if (!popup || !popup.classList.contains('bk-epub-fn-popup-active')) return;
    var mask = document.getElementById('bk-epub-fn-popup-mask');
    // 如果点击的不是脚注引用标记，也不是弹窗内部，也不是遮罩层，则关闭
    if (!e.target.closest('sup.bk-epub-fn-ref') &&
        !popup.contains(e.target) &&
        e.target !== mask) {
      _closeFootnotePopup();
    }
  }

  // 脚注弹窗：ESC 键关闭
  function _fnPopupEscHandler(e) {
    if (e.key === 'Escape') {
      _closeFootnotePopup();
    }
  }

  // 脚注弹窗：滚动关闭（阅读区域滚动时）
  // 注意：弹窗自身滚动（overflow-y: auto）不应触发关闭
  function _fnPopupScrollHandler(e) {
    var popup = document.getElementById('bk-epub-fn-popup');
    // 弹窗内部滚动不关闭
    if (popup && popup.contains(e.target)) return;
    _closeFootnotePopup();
  }

  // Lightbox 显示/隐藏
  var _lightboxLockCleanup = null;
  function _closeLightbox() {
    var overlay = document.getElementById('bk-lightbox');
    if (overlay) overlay.classList.remove('bk-lightbox-active');
    if (_lightboxLockCleanup) { _lightboxLockCleanup(); _lightboxLockCleanup = null; }
  }
  function _openLightbox(src, alt) {
    var overlay = document.getElementById('bk-lightbox');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'bk-lightbox';
      overlay.className = 'bk-lightbox-overlay';
      overlay.innerHTML = '<div class="bk-lightbox-container"><img class="bk-lightbox-img" alt=""><div class="bk-lightbox-close">&times;</div></div>';
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay || e.target.classList.contains('bk-lightbox-close')) {
          _closeLightbox();
        }
      });
      document.body.appendChild(overlay);
    }
    var lbImg = overlay.querySelector('.bk-lightbox-img');
    if (lbImg) { lbImg.src = src; lbImg.alt = alt; }
    overlay.classList.add('bk-lightbox-active');
    // 防触摸穿透：锁定遮罩滚动
    if (win.BK && win.BK.lockOverlayScroll) {
      _lightboxLockCleanup = win.BK.lockOverlayScroll(overlay, function() { _closeLightbox(); });
    }
  }

  // ── PDF 页面懒渲染 ──────────────────────────────────────────────────────
  // 使用 IntersectionObserver 在 .bk-pdf-page 元素进入视口时，
  // 用 pdf.js 渲染对应页到内嵌 <canvas>。

  var _pdfDocCache = {};      // pdfBookId → Promise<pdfDocument> (缓存 Promise 避免并发重复加载)
  var _pdfRenderObserver = null; // IntersectionObserver 单例

  function _getPdfDoc(pdfBookId) {
    if (_pdfDocCache[pdfBookId]) return _pdfDocCache[pdfBookId];
    // 从 imported-pdf-data store 读取 Uint8Array
    var pdfStore = (win.ImportManager && win.ImportManager.getPdfDataStore)
      ? win.ImportManager.getPdfDataStore() : null;
    if (!pdfStore) return Promise.reject(new Error('PDF 数据存储不可用'));
    var p = pdfStore.getItem('pdf:' + pdfBookId).then(function (data) {
      if (!data) return Promise.reject(new Error('PDF 数据未找到: ' + pdfBookId));
      var lib = win.pdfjsLib;
      if (!lib) return Promise.reject(new Error('pdf.js 未加载'));
      return lib.getDocument({ data: new Uint8Array(data) }).promise;
    });
    _pdfDocCache[pdfBookId] = p;
    return p;
  }

  function _cleanupPdfCache() {
    var keys = Object.keys(_pdfDocCache);
    for (var i = 0; i < keys.length; i++) {
      // pdfDocument.destroy() 需在 resolve 后调用；这里安全地尝试
      var p = _pdfDocCache[keys[i]];
      if (p && typeof p.then === 'function') {
        p.then(function (pdf) { if (pdf && pdf.destroy) pdf.destroy(); }).catch(function () {});
      }
    }
    _pdfDocCache = {};
    if (_pdfRenderObserver) {
      _pdfRenderObserver.disconnect();
      _pdfRenderObserver = null;
    }
  }

  function _renderPdfPage(el) {
    if (el.getAttribute('data-pdf-rendered') === '1') return;
    var pgNum = parseInt(el.getAttribute('data-pdf-page'), 10) || 1;
    var pdfBkId = el.getAttribute('data-pdf-book') || '';
    var canvas = el.querySelector('.bk-pdf-canvas');
    if (!canvas) return;

    var placeholder = el.querySelector('.bk-pdf-page-placeholder');

    _getPdfDoc(pdfBkId).then(function (pdf) {
      return pdf.getPage(pgNum);
    }).then(function (page) {
      var viewport = page.getViewport({ scale: 1 });
      // 按容器宽度适配缩放
      var containerWidth = el.clientWidth || el.parentElement.clientWidth || 600;
      var scale = containerWidth / viewport.width;
      var scaledViewport = page.getViewport({ scale: scale });

      canvas.width = Math.floor(scaledViewport.width);
      canvas.height = Math.floor(scaledViewport.height);
      canvas.style.width = Math.floor(scaledViewport.width) + 'px';
      canvas.style.height = Math.floor(scaledViewport.height) + 'px';

      var ctx = canvas.getContext('2d');
      return page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    }).then(function () {
      // 渲染完成，标记并隐藏占位
      el.setAttribute('data-pdf-rendered', '1');
      if (placeholder) placeholder.style.display = 'none';
      canvas.style.opacity = '1';
    }).catch(function (err) {
      console.warn('[PDF] 页面渲染失败:', pgNum, err);
      if (placeholder) placeholder.innerHTML = '<span>页面加载失败</span>';
    });
  }

  function initPdfPageLazyRender(containerEl) {
    var pages = containerEl.querySelectorAll('.bk-pdf-page');
    if (!pages.length) return;

    if (!_pdfRenderObserver) {
      _pdfRenderObserver = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            _renderPdfPage(entries[i].target);
            _pdfRenderObserver.unobserve(entries[i].target);
          }
        }
      }, { rootMargin: '200px 0px' });
    }

    for (var i = 0; i < pages.length; i++) {
      _pdfRenderObserver.observe(pages[i]);
    }
  }

  // ── 章节去重辅助 ──────────────────────────────────────────────────

  /**
   * 获取去重后的章节列表（按 number 去重，保留首次出现的章节）
   * 适用于某些书籍数据中同一编号有多条记录的情况（如读经一年一遍的每日两读）
   */
  function _getUniqueChapters(chapters) {
    var seen = {};
    var unique = [];
    for (var i = 0; i < chapters.length; i++) {
      var num = chapters[i].number;
      if (!seen[num]) {
        seen[num] = true;
        unique.push(chapters[i]);
      }
    }
    return unique;
  }

  // ── 键盘快捷键管理 ────────────────────────────────────────────────────

  var _readingKeyHandler = null;

  function _installReadingShortcuts(bookId, uniqueChapters, chapterNum) {
    _removeReadingShortcuts();
    _readingKeyHandler = function (e) {
      // 忽略输入框内的按键
      var tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        // 上一章
        for (var i = 0; i < uniqueChapters.length; i++) {
          if (uniqueChapters[i].number === chapterNum && i > 0) {
            if (win.BKRouter) win.BKRouter.navigate(bookId + '/' + uniqueChapters[i - 1].number);
            break;
          }
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        // 下一章
        for (var i = 0; i < uniqueChapters.length; i++) {
          if (uniqueChapters[i].number === chapterNum && i < uniqueChapters.length - 1) {
            if (win.BKRouter) win.BKRouter.navigate(bookId + '/' + uniqueChapters[i + 1].number);
            break;
          }
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (win.BKRouter) win.BKRouter.navigate('');
      }
    };
    document.addEventListener('keydown', _readingKeyHandler);
  }

  function _removeReadingShortcuts() {
    if (_readingKeyHandler) {
      document.removeEventListener('keydown', _readingKeyHandler);
      _readingKeyHandler = null;
    }
    _removeSwipeHandler();
    _removeChapterLinkHandler();
  }

  // ── 跨章节链接（事件委托） ──────────────────────────────────────────
  var _chapterLinkHandler = null;
  var _chapterLinkBookId = null;

  function _installChapterLinkHandler(bookId) {
    _removeChapterLinkHandler();
    _chapterLinkBookId = bookId;
    _chapterLinkHandler = function (e) {
      var link = e.target.closest('[data-chapter-link]');
      if (!link) return;
      e.preventDefault();
      var targetChapter = parseInt(link.getAttribute('data-chapter-link'), 10);
      if (targetChapter && _chapterLinkBookId && win.BKRouter) {
        win.BKRouter.navigate(_chapterLinkBookId + '/' + targetChapter);
      }
    };
    var app = getApp();
    if (app) app.addEventListener('click', _chapterLinkHandler);
  }

  function _removeChapterLinkHandler() {
    if (_chapterLinkHandler) {
      var app = getApp();
      if (app) app.removeEventListener('click', _chapterLinkHandler);
      _chapterLinkHandler = null;
    }
    _chapterLinkBookId = null;
  }

