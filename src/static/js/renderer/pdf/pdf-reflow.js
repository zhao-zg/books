/*!
 * pdf-reflow.js - PDF 文字重排模式（F6）
 *
 * 职责：
 *   - 从 PDF 提取文字内容（pdf.js getTextContent API）
 *   - 按阅读顺序重排为流式段落，适配移动端窄屏
 *   - 嵌入图片资源（文字与图混排）
 *   - 同步呈现高亮/下划线/删除线标注（百分比坐标 → Reflow DOM 映射）
 *   - 提供进入/退出 Reflow 视图的 DOM 构建与清理
 *
 * 依赖：pdf-state.js, pdf-core.js
 * 挂载：window.BKPdf._internal.reflow
 *
 * 标注映射策略：
 *   原始标注使用百分比坐标 { left, top, width, height }（相对于 text layer）
 *   Reflow 模式下无法直接用百分比定位，改用文本匹配策略：
 *   - 对每条标注，提取其 text 内容
 *   - 在 Reflow 文本中搜索对应文字段
 *   - 对匹配到的 <span> 标记添加对应颜色 class
 *   - 批注以 📝 行内图标呈现，点击弹出批注面板
 */
(function (win) {
  'use strict';

  var doc = win.document;
  var S = win.BKPdf._internal.state;

  // ==================== 状态 ====================

  var _reflowContainer = null;   // Reflow 视图容器 DOM
  var _reflowBookId = null;      // 当前书 ID
  var _reflowPages = [];         // 已提取的页面文字数据 [{ pageNum, items, images }]
  var _isLoading = false;        // 是否正在提取
  var _textLayerCache = {};      // pageNum → textLayer 尺寸缓存（标注映射用）
  var _dividerObserver = null;   // IntersectionObserver 用于检测当前页码
  var _detectedPage = 1;         // IntersectionObserver 检测到的当前页码

  // ==================== 文字提取 ====================

  /**
   * 从 PDF 文档提取所有页面的文字内容
   * @param {string} bookId
   * @returns {Promise<Array>} 页面文字数组
   */
  function _extractAllPages(bookId) {
    var core = win.BKPdf._internal.core;
    if (!core || !core.getPdfDoc) return Promise.reject(new Error('core module not ready'));

    return core.getPdfDoc(bookId).then(function (pdf) {
      var totalPages = pdf.numPages;
      var pages = [];

      function extractPage(pageNum) {
        if (pageNum > totalPages) return pages;
        return pdf.getPage(pageNum).then(function (page) {
          return page.getTextContent({
            includeMarkedContent: false,
            disableCombineTextItems: false
          }).then(function (textContent) {
            // 同时提取页面操作符以获取图片信息
            return _extractPageImages(page, pageNum).then(function (images) {
              pages.push({
                pageNum: pageNum,
                items: textContent.items || [],
                styles: textContent.styles || {},
                viewport: page.getViewport({ scale: 1.0 }),
                images: images,
                width: page.getViewport({ scale: 1.0 }).width,
                height: page.getViewport({ scale: 1.0 }).height
              });
              return extractPage(pageNum + 1);
            });
          });
        });
      }

      return extractPage(1);
    });
  }

  /**
   * 提取页面中的图片对象信息
   * 注意：pdf.js 不直接提供图片提取 API，我们通过操作符列表识别图片位置
   * @returns {Promise<Array>} 图片数组 [{ x, y, width, height, pageNum, objId }]
   */
  function _extractPageImages(page, pageNum) {
    // 使用 getOperatorList 识别图片操作
    return page.getOperatorList().then(function (opList) {
      var images = [];
      var ops = opList.fnArray;
      var args = opList.argsArray;

      // 查找 paintImageXObject / paintJpegXObject 操作
      for (var i = 0; i < ops.length; i++) {
        if (ops[i] === win.pdfjsLib.OPS.paintImageXObject ||
            ops[i] === win.pdfjsLib.OPS.paintJpegXObject) {
          var imgName = args[i][0];
          // 记录图片名和页码，后续渲染时用 page.getObjectProperty 获取
          images.push({
            name: imgName,
            pageNum: pageNum,
            // 精确坐标需要结合当前变换矩阵，先用占位
            x: 0, y: 0, width: 0, height: 0
          });
        }
      }
      return images;
    }).catch(function () {
      return []; // 图片提取失败不影响文字重排
    });
  }

  // ==================== 文字重排 ====================

  /**
   * 将提取的文字按阅读顺序重排为段落 HTML
   * 策略：按 Y 坐标分行，Y 差距 > 阈值分段落
   */
  function _buildReflowHTML(pages) {
    var html = '';
    var LINE_GAP_THRESHOLD = 12; // 行间距 > 此值视为新段落（PDF pt 单位）

    for (var p = 0; p < pages.length; p++) {
      var page = pages[p];
      var items = page.items;
      if (!items || !items.length) {
        // 空白页，加页码分隔
        html += _buildPageDivider(page.pageNum);
        continue;
      }

      // 缓存 text layer 尺寸（用于标注映射）
      _textLayerCache[page.pageNum] = {
        width: page.width,
        height: page.height
      };

      // 按 Y 坐标分组（行）
      var lines = _groupByLines(items, page.width, LINE_GAP_THRESHOLD);

      // 页码标记
      html += '<div class="bk-pdf-reflow-page-divider" data-reflow-page="' + page.pageNum + '">';
      html += '<span class="bk-pdf-reflow-page-num">P' + S.getDisplayPageLabel(page.pageNum) + '</span>';
      html += '</div>';

      // 渲染段落
      for (var l = 0; l < lines.length; l++) {
        var line = lines[l];
        var text = _mergeLineText(line);
        if (!text.trim()) continue;

        // 判断是否是段落开头（Y 间距大）
        var isParagraphStart = line.isParagraphStart;

        html += '<div class="bk-pdf-reflow-para' + (isParagraphStart ? ' bk-pdf-reflow-para-start' : '') + '">';
        html += _buildAnnotatedSpan(line, page.pageNum);
        html += '</div>';
      }

      // 页面图片（如有可用的）
      if (page.images && page.images.length) {
        for (var img = 0; img < page.images.length; img++) {
          // 图片渲染为占位符，后续异步加载
          html += '<div class="bk-pdf-reflow-img-wrap" data-reflow-img-page="' + page.pageNum + '" data-reflow-img-name="' + S.escAttr(page.images[img].name || '') + '">';
          html += '<div class="bk-pdf-reflow-img-placeholder">📷</div>';
          html += '</div>';
        }
      }
    }

    return html;
  }

  /**
   * 按 Y 坐标将文本项分组为行
   * @returns {Array} 行数组，每行 { items, y, isParagraphStart }
   */
  function _groupByLines(items, pageWidth, gapThreshold) {
    if (!items || !items.length) return [];

    // 过滤掉空项，按 Y 排序
    var validItems = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item.str || !item.str.trim()) continue;
      if (!item.transform || item.transform.length < 5) continue;
      validItems.push(item);
    }
    if (!validItems.length) return [];

    // 按 Y 位置排序（PDF 坐标 Y 从下往上递增，需翻转）
    validItems.sort(function (a, b) {
      var ay = a.transform[5];
      var by = b.transform[5];
      if (by !== ay) return by - ay; // Y 大的排前面（页面上方）
      return a.transform[4] - b.transform[4]; // 同行按 X 排序
    });

    var lines = [];
    var currentLine = { items: [validItems[0]], y: validItems[0].transform[5], isParagraphStart: true };

    for (var j = 1; j < validItems.length; j++) {
      var item = validItems[j];
      var y = item.transform[5];
      var gap = Math.abs(y - currentLine.y);

      if (gap < gapThreshold) {
        // 同一行
        currentLine.items.push(item);
        // 更新行 Y 为中位数
        var sumY = 0;
        for (var k = 0; k < currentLine.items.length; k++) sumY += currentLine.items[k].transform[5];
        currentLine.y = sumY / currentLine.items.length;
      } else {
        // 新行
        lines.push(currentLine);
        currentLine = {
          items: [item],
          y: y,
          isParagraphStart: gap >= gapThreshold * 1.8
        };
      }
    }
    lines.push(currentLine);

    return lines;
  }

  /**
   * 合并行内文字
   */
  function _mergeLineText(line) {
    var text = '';
    for (var i = 0; i < line.items.length; i++) {
      var str = line.items[i].str;
      // 智能空格：中文字符间不加空格，英文词间加空格
      var prevChar = text.charAt(text.length - 1);
      var curChar = str.charAt(0);
      if (prevChar && curChar &&
          _isCJK(prevChar) && !_isCJK(curChar)) {
        text += ' ' + str;
      } else if (prevChar && curChar &&
                 !_isCJK(prevChar) && _isCJK(curChar)) {
        text += ' ' + str;
      } else if (prevChar && curChar &&
                 !_isCJK(prevChar) && !_isCJK(curChar) &&
                 prevChar !== ' ' && curChar !== ' ') {
        text += ' ' + str;
      } else {
        text += str;
      }
    }
    return text;
  }

  function _isCJK(ch) {
    var code = ch.charCodeAt(0);
    return (code >= 0x4E00 && code <= 0x9FFF) ||  // CJK Unified
           (code >= 0x3400 && code <= 0x4DBF) ||  // CJK Extension A
           (code >= 0x3000 && code <= 0x303F) ||  // CJK Symbols
           (code >= 0xFF00 && code <= 0xFFEF) ||  // Fullwidth
           (code >= 0x2E80 && code <= 0x2EFF);    // CJK Radicals
  }

  /**
   * 构建带标注的行 HTML
   * 策略：将整行文字包裹在 <span> 中，通过文本匹配查找标注并分段着色
   */
  function _buildAnnotatedSpan(line, pageNum) {
    var fullText = _mergeLineText(line);
    var bookId = S.currentBookId();
    if (!bookId) return S.escText(fullText);

    // 获取当前页的标注
    var highlights = S.highlightsByPage(bookId, pageNum);
    if (!highlights || !highlights.length) {
      return S.escText(fullText);
    }

    // 简化策略：按文本子串匹配标注
    // 对每条标注，尝试在行文字中找到其 text，并标记
    var segments = [{ text: fullText, type: null, color: null, note: null, hlId: null }];

    for (var h = 0; h < highlights.length; h++) {
      var hl = highlights[h];
      var hlText = (hl.text || '').trim();
      if (!hlText) continue;

      // 在各段中搜索标注文本
      var newSegments = [];
      for (var s = 0; s < segments.length; s++) {
        var seg = segments[s];
        // 已标注的段不再拆分（避免重叠标注冲突）
        if (seg.type) {
          newSegments.push(seg);
          continue;
        }

        var idx = seg.text.indexOf(hlText);
        if (idx === -1) {
          newSegments.push(seg);
          continue;
        }

        // 拆分为 3 段：前 | 标注 | 后
        if (idx > 0) {
          newSegments.push({ text: seg.text.substring(0, idx), type: null, color: null, note: null, hlId: null });
        }
        newSegments.push({
          text: hlText,
          type: hl.type || 'highlight',
          color: hl.color || 'yellow',
          note: hl.note || '',
          hlId: hl.id || ''
        });
        if (idx + hlText.length < seg.text.length) {
          newSegments.push({
            text: seg.text.substring(idx + hlText.length),
            type: null, color: null, note: null, hlId: null
          });
        }
      }
      segments = newSegments;
    }

    // 渲染分段 HTML
    var html = '';
    for (var r = 0; r < segments.length; r++) {
      var seg = segments[r];
      if (!seg.text) continue;

      if (seg.type) {
        var cls = 'bk-pdf-reflow-hl bk-pdf-reflow-hl-' + seg.color;
        if (seg.type === 'underline') cls += ' bk-pdf-reflow-underline';
        else if (seg.type === 'strikethrough') cls += ' bk-pdf-reflow-strikethrough';
        var noteAttr = seg.note ? ' data-reflow-note="' + S.escAttr(seg.note) + '"' : '';
        var hlIdAttr = seg.hlId ? ' data-reflow-hl-id="' + S.escAttr(seg.hlId) + '"' : '';
        html += '<span class="' + cls + '"' + noteAttr + hlIdAttr + '>' + S.escText(seg.text);
        if (seg.note && seg.note.trim()) {
          html += '<span class="bk-pdf-reflow-note-badge" data-reflow-note-id="' + S.escAttr(seg.hlId) + '">📝</span>';
        }
        html += '</span>';
      } else {
        html += S.escText(seg.text);
      }
    }
    return html;
  }

  /**
   * 构建页码分隔符
   */
  function _buildPageDivider(pageNum) {
    return '<div class="bk-pdf-reflow-page-divider" data-reflow-page="' + pageNum + '">' +
      '<span class="bk-pdf-reflow-page-num">P' + S.getDisplayPageLabel(pageNum) + '</span>' +
      '</div>';
  }

  // ==================== 进入/退出 Reflow 视图 ====================

  /**
   * 进入 Reflow 模式：提取文字 → 构建 DOM → 插入页面
   * @returns {Promise<HTMLElement>} Reflow 容器元素
   */
  function enterReflowView(bookId) {
    if (!bookId) return Promise.reject(new Error('bookId required'));
    _reflowBookId = bookId;
    _isLoading = true;
    _textLayerCache = {};

    return _extractAllPages(bookId).then(function (pages) {
      _reflowPages = pages;

      var html = _buildReflowHTML(pages);

      // 创建 Reflow 容器
      var container = doc.createElement('div');
      container.id = 'bkPdfReflowView';
      container.className = 'bk-pdf-reflow-view bk-pdf-mode';
      container.innerHTML = html;

      // 插入到 readingView（或 body 回退）
      var readingView = doc.getElementById('readingView');
      if (readingView) {
        readingView.appendChild(container);
      } else {
        doc.body.appendChild(container);
      }

      _reflowContainer = container;
      _isLoading = false;

      // 绑定批注徽章点击事件
      _bindNoteBadgeClicks();

      // 渲染可用的图片
      _renderImages(bookId, pages);

      // 创建 IntersectionObserver 检测当前页码（替代 getBoundingClientRect 遍历）
      _setupDividerObserver();

      return container;
    }).catch(function (err) {
      _isLoading = false;
      console.warn('[PDF-REFLOW] 进入重排模式失败:', err);
      return Promise.reject(err);
    });
  }

  /**
   * 退出 Reflow 模式：移除容器 DOM
   */
  function exitReflowView() {
    if (_dividerObserver) {
      _dividerObserver.disconnect();
      _dividerObserver = null;
    }
    if (_reflowContainer && _reflowContainer.parentNode) {
      _reflowContainer.parentNode.removeChild(_reflowContainer);
    }
    _reflowContainer = null;
    _reflowBookId = null;
    _reflowPages = [];
    _textLayerCache = {};
  }

  // ==================== 图片渲染 ====================

  /**
   * 异步渲染页面图片到 Reflow 视图的图片占位符中
   * 使用 canvas 渲染图片区域，再转 data URL
   * 并发控制：同时最多渲染 2 页，避免内存/耗时压力
   */
  function _renderImages(bookId, pages) {
    var core = win.BKPdf._internal.core;
    if (!core || !core.getPdfDoc) return;

    var imgWraps = _reflowContainer ? _reflowContainer.querySelectorAll('.bk-pdf-reflow-img-wrap') : [];
    if (!imgWraps.length) return;

    core.getPdfDoc(bookId).then(function (pdf) {
      var queue = [];
      for (var i = 0; i < imgWraps.length; i++) {
        var wrap = imgWraps[i];
        var pageNum = parseInt(wrap.getAttribute('data-reflow-img-page'), 10);
        if (!pageNum || pageNum < 1 || pageNum > pdf.numPages) continue;
        queue.push({ wrapEl: wrap, pageNum: pageNum });
      }

      // 并发控制：同时最多 2 个渲染任务
      var MAX_CONCURRENT = 2;
      var idx = 0;
      var active = 0;

      function next() {
        if (idx >= queue.length || active >= MAX_CONCURRENT) return;
        var task = queue[idx++];
        active++;

        pdf.getPage(task.pageNum).then(function (page) {
          var scale = 1.5;
          var viewport = page.getViewport({ scale: scale });
          var canvas = doc.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          var ctx = canvas.getContext('2d');

          page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
            try {
              var dataUrl = canvas.toDataURL('image/jpeg', 0.75);
              task.wrapEl.innerHTML = '<img class="bk-pdf-reflow-img" src="' + dataUrl + '" alt="P' + task.pageNum + ' 插图">';
            } catch (e) {
              // canvas 污染（跨域图片）时保留占位符
            }
            canvas.width = 0;
            canvas.height = 0;
            active--;
            next(); // 继续下一个
          });
        }).catch(function () {
          active--;
          next();
        });
      }

      // 启动初始批次
      for (var b = 0; b < MAX_CONCURRENT && idx < queue.length; b++) {
        next();
      }
    });
  }

  // ==================== 批注交互 ====================

  function _bindNoteBadgeClicks() {
    if (!_reflowContainer) return;
    var badges = _reflowContainer.querySelectorAll('.bk-pdf-reflow-note-badge');
    for (var i = 0; i < badges.length; i++) {
      badges[i].addEventListener('click', function (e) {
        e.stopPropagation();
        var hlId = e.target.getAttribute('data-reflow-note-id');
        var bookId = S.currentBookId();
        if (!bookId || !hlId) return;
        var hlArr = S.highlights(bookId);
        var found = null;
        for (var j = 0; j < hlArr.length; j++) {
          if (hlArr[j].id === hlId) { found = hlArr[j]; break; }
        }
        if (found && found.note) {
          var badgeRect = e.target.getBoundingClientRect();
          var notePanel = win.BKPdf._internal.highlight;
          if (notePanel && notePanel.showNotePanel) {
            notePanel.showNotePanel(hlId, found.note, badgeRect);
          }
        }
      });
    }
  }

  // ==================== Reflow 模式下刷新标注 ====================

  /**
   * 标注变更后刷新 Reflow 视图中的标注渲染
   * 策略：重新构建 HTML 并替换容器内容
   */
  function refreshAnnotations() {
    if (!_reflowContainer || !_reflowPages.length) return;
    var html = _buildReflowHTML(_reflowPages);
    _reflowContainer.innerHTML = html;
    _bindNoteBadgeClicks();
  }

  // ==================== IntersectionObserver 页码检测 ====================

  /**
   * 设置 IntersectionObserver 监听页码分隔符，实时检测当前页码
   * 当分隔符进入视口顶部附近时更新 _detectedPage
   */
  function _setupDividerObserver() {
    if (_dividerObserver) _dividerObserver.disconnect();
    _dividerObserver = null;

    var dividers = _reflowContainer ? _reflowContainer.querySelectorAll('.bk-pdf-reflow-page-divider') : [];
    if (!dividers.length) return;

    // rootMargin: 视口顶部向上 0px，向下 50px（视口顶部偏移容差）
    _dividerObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.isIntersecting) {
          var page = parseInt(entry.target.getAttribute('data-reflow-page'), 10) || 1;
          if (page > _detectedPage || page === 1) {
            _detectedPage = page;
          }
        }
      }
      // 向下滚动时，最后一个 intersecting 的就是当前页
      // 重新扫描所有 intersecting entries 取最大的页码
      var maxPage = 0;
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].isIntersecting) {
          var p = parseInt(entries[j].target.getAttribute('data-reflow-page'), 10) || 0;
          if (p > maxPage) maxPage = p;
        }
      }
      if (maxPage > 0) _detectedPage = maxPage;
    }, {
      root: null,
      rootMargin: '0px 0px -90% 0px',
      threshold: 0
    });

    for (var k = 0; k < dividers.length; k++) {
      _dividerObserver.observe(dividers[k]);
    }
  }

  // ==================== 滚动到指定页 ====================

  /**
   * 在 Reflow 视图中滚动到指定页码的分隔符位置
   */
  function scrollToPage(pageNum) {
    if (!_reflowContainer) return;
    var divider = _reflowContainer.querySelector('.bk-pdf-reflow-page-divider[data-reflow-page="' + pageNum + '"]');
    if (divider) {
      divider.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ==================== 检测当前页码 ====================

  /**
   * 检测当前页码（由 IntersectionObserver 实时维护）
   * 兼容：如 observer 未设置则回退到 getBoundingClientRect 遍历
   */
  function detectCurrentPage() {
    if (_dividerObserver) return _detectedPage || 1;

    // 回退方案
    if (!_reflowContainer) return 1;
    var dividers = _reflowContainer.querySelectorAll('.bk-pdf-reflow-page-divider');
    if (!dividers.length) return 1;

    var containerRect = _reflowContainer.getBoundingClientRect();
    var viewTop = containerRect.top + 2;
    var currentPage = 1;

    for (var i = dividers.length - 1; i >= 0; i--) {
      var rect = dividers[i].getBoundingClientRect();
      if (rect.top <= viewTop + 50) {
        currentPage = parseInt(dividers[i].getAttribute('data-reflow-page'), 10) || 1;
        break;
      }
    }

    return currentPage;
  }

  // ==================== init / cleanup ====================

  function init() {
    // Reflow 模式的初始化由 enterReflowView 完成
    // init 在 renderer-pdf.js 中按需调用
  }

  function cleanup() {
    exitReflowView();
    _isLoading = false;
  }

  // ==================== 导出 ====================

  win.BKPdf._internal.reflow = {
    init: init,
    cleanup: cleanup,
    enterReflowView: enterReflowView,
    exitReflowView: exitReflowView,
    refreshAnnotations: refreshAnnotations,
    scrollToPage: scrollToPage,
    detectCurrentPage: detectCurrentPage,
    isLoading: function () { return _isLoading; },
    container: function () { return _reflowContainer; }
  };

})(window);
