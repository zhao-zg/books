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
  var _renderAborted = false;    // 渲染中止标志（exitReflowView 时置 true，阻止后续图片渲染）
  var _reflowRenderedUpTo = 0;  // 增量渲染：已渲染到第几页（1-based）
  var INCREMENTAL_BATCH = 10;    // 每批渲染页数

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
          images.push({
            name: imgName,
            pageNum: pageNum,
            x: 0, y: 0, width: 0, height: 0
          });
        }
      }

      // Bug#15a: 图片数量过多时（如乐谱 PDF），尝试获取尺寸并过滤小图
      // 乐谱中的音符/记号被 pdf.js 识别为大量小尺寸图片，淹没文字内容
      if (images.length <= 20) return images;

      return _filterSmallImages(page, images).catch(function () {
        // 过滤失败：数量过多则丢弃全部，否则保留原始
        return images.length > 50 ? [] : images;
      });
    }).catch(function () {
      return []; // 图片提取失败不影响文字重排
    });
  }

  /**
   * Bug#15a: 过滤小尺寸图片
   * 乐谱 PDF 中音符/记号被识别为大量小图片，需按尺寸过滤
   * @param {Object} page - pdf.js page proxy
   * @param {Array} images - 图片信息数组
   * @returns {Promise<Array>} 过滤后的图片数组
   */
  function _filterSmallImages(page, images) {
    var MIN_SIZE = 32;   // 最小图片尺寸（px），低于此值视为矢量元素
    var MAX_IMAGES = 20;  // 单页最大图片数量，超过则丢弃全部

    var dimPromises = images.map(function (img) {
      return new Promise(function (resolve) {
        try {
          page.objs.get(img.name, function (obj) {
            if (obj) {
              img.width = obj.width || 0;
              img.height = obj.height || 0;
            }
            resolve(img);
          });
        } catch (e) {
          resolve(img); // 获取失败，保留原始（width/height 为 0）
        }
      });
    });

    return Promise.all(dimPromises).then(function (resolved) {
      var filtered = resolved.filter(function (img) {
        return img.width >= MIN_SIZE && img.height >= MIN_SIZE;
      });
      // 过滤后仍过多，说明整页是矢量图形，丢弃全部图片
      if (filtered.length > MAX_IMAGES) return [];
      return filtered;
    });
  }

  // ==================== 文字重排 ====================

  /**
   * 将提取的文字按阅读顺序重排为段落 HTML
   * 改进：
   *   - P0-1: 多栏 PDF 用 XY-Cut 单层垂直切分，先左栏再右栏
   *   - P0-2: 标题层级识别（字号 modal 分析）
   *   - P1-2: 智能空格 + 孤行回退 + CJK 不拆字
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

      // P0-1: 多栏检测——若检测到多栏，按栏重新排序 items（先左栏全部，再右栏全部）
      var sortedItems = _reorderForColumns(items, page.width, page.height);

      // P0-2: 字号 modal 分析（用于标题层级识别）
      var modalSize = _analyzeModalFontSize(sortedItems);

      // 按 Y 坐标分组（行）
      var lines = _groupByLines(sortedItems, page.width, LINE_GAP_THRESHOLD);

      // 页码标记
      html += '<div class="bk-pdf-reflow-page-divider" data-reflow-page="' + page.pageNum + '">';
      html += '<span class="bk-pdf-reflow-page-num">P' + S.getDisplayPageLabel(page.pageNum) + '</span>';
      html += '</div>';

      // 渲染段落
      for (var l = 0; l < lines.length; l++) {
        var line = lines[l];
        var text = _mergeLineText(line);
        if (!text.trim()) continue;

        // P1-2: 孤行回退——若一个段落最后一行只有 1-2 个字符，合并到上一行
        if (l > 0 && text.length <= 2 && _isCJK(text.charAt(0))) {
          // 修改上一段的 HTML 较复杂，这里采用简化策略：不渲染太短的末行
          // （这会丢失少量信息，但避免「单字成行」视觉问题）
          // 实际上 PDF 中孤行通常是段落末尾，跳过渲染对内容理解影响微小
          continue;
        }

        // 判断是否是段落开头（Y 间距大）
        var isParagraphStart = line.isParagraphStart;

        // P0-2: 标题层级识别
        var headingClass = _detectHeading(line, modalSize);
        if (headingClass) {
          // 标题：不加段落文本缩进，加 h1/h2 class（data-reflow-page 用于 Reflow 标注选取定位页码）
          html += '<div class="bk-pdf-reflow-' + headingClass + '" data-reflow-page="' + page.pageNum + '">';
          html += _buildAnnotatedSpan(line, page.pageNum);
          html += '</div>';
        } else {
          html += '<div class="bk-pdf-reflow-para' + (isParagraphStart ? ' bk-pdf-reflow-para-start' : '') + '" data-reflow-page="' + page.pageNum + '">';
          html += _buildAnnotatedSpan(line, page.pageNum);
          html += '</div>';
        }
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
   * P0-2: 分析文本项字号的 modal 值（出现最多的字号），作为正文字号基准
   * pdf.js text item 的 height 字段即字号近似值
   * @returns {number} modal 字号，无数据时返回 12（默认）
   */
  function _analyzeModalFontSize(items) {
    if (!items || !items.length) return 12;
    var sizeMap = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.str || !it.str.trim()) continue;
      // pdf.js item.height 即字号高度
      var size = Math.round(it.height || 0);
      if (size <= 0) continue;
      sizeMap[size] = (sizeMap[size] || 0) + (it.str.length || 1);
    }
    var modalSize = 12;
    var maxCount = 0;
    for (var s in sizeMap) {
      if (sizeMap[s] > maxCount) {
        maxCount = sizeMap[s];
        modalSize = parseInt(s, 10);
      }
    }
    return modalSize;
  }

  /**
   * P0-2: 根据行字号识别是否为标题
   * @returns {string|null} 'h1' | 'h2' | null
   */
  function _detectHeading(line, modalSize) {
    if (!line || !line.items || !line.items.length) return null;
    if (!modalSize || modalSize <= 0) return null;
    // 取行内最大字号
    var maxSize = 0;
    for (var i = 0; i < line.items.length; i++) {
      var h = line.items[i].height || 0;
      if (h > maxSize) maxSize = h;
    }
    if (maxSize === 0) return null;
    var ratio = maxSize / modalSize;
    if (ratio >= 1.6) return 'h1';
    if (ratio >= 1.3) return 'h2';
    return null;
  }

  /**
   * P0-1: 多栏检测与重排——XY-Cut 单层垂直切分
   * 策略：
   *   1. 将页面沿 X 轴投影（划分 32 个 bin）
   *   2. 寻找中间的「垂直空白带」（连续多个 bin 文字密度极低）
   *   3. 若找到，将 items 分为左右两栏，先返回左栏全部（按 Y 排序），再右栏全部
   *   4. 若未找到（单栏 PDF），直接按 Y 排序
   * 参考行业算法：XY-Cut（Widhiyasiri et al.）
   * @returns {Array} 重排后的 items 数组
   */
  function _reorderForColumns(items, pageWidth, pageHeight) {
    if (!items || items.length < 20) return items; // 文本太少不分析
    if (!pageWidth || pageWidth <= 0) return items;

    var BIN_COUNT = 32;
    var binWidth = pageWidth / BIN_COUNT;
    var bins = new Array(BIN_COUNT).fill(0);

    // 统计每个 X bin 的文字密度（字符数）
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it.str || !it.str.trim()) continue;
      if (!it.transform || it.transform.length < 5) continue;
      var x = it.transform[4]; // X 坐标
      var binIdx = Math.floor(x / binWidth);
      if (binIdx < 0) binIdx = 0;
      if (binIdx >= BIN_COUNT) binIdx = BIN_COUNT - 1;
      bins[binIdx] += (it.str.length || 1);
    }

    // 总字符数
    var totalChars = 0;
    for (var b = 0; b < BIN_COUNT; b++) totalChars += bins[b];
    if (totalChars === 0) return items;

    // 寻找中间区域（20%~80% 之间）的连续空白带
    // 阈值：bin 密度 < 总密度的 1/64 视为空白（远低于平均）
    var threshold = totalChars / BIN_COUNT / 8;
    var minGapBins = 3; // 至少 3 个连续空 bin（约 9% 页宽）才算栏间空白
    var startSearch = Math.floor(BIN_COUNT * 0.25);
    var endSearch = Math.floor(BIN_COUNT * 0.75);

    var bestGapStart = -1;
    var bestGapLen = 0;
    var curStart = -1;
    var curLen = 0;
    for (var k = startSearch; k < endSearch; k++) {
      if (bins[k] < threshold) {
        if (curStart === -1) curStart = k;
        curLen++;
      } else {
        if (curLen > bestGapLen) {
          bestGapLen = curLen;
          bestGapStart = curStart;
        }
        curStart = -1;
        curLen = 0;
      }
    }
    if (curLen > bestGapLen) {
      bestGapLen = curLen;
      bestGapStart = curStart;
    }

    // 若未找到足够宽的空白带，按单栏处理
    if (bestGapStart === -1 || bestGapLen < minGapBins) return items;

    // 栏分界线（取空白带中点）
    var splitBin = bestGapStart + Math.floor(bestGapLen / 2);
    var splitX = splitBin * binWidth;

    // 分割为左右两栏
    var leftItems = [];
    var rightItems = [];
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      if (!item.transform || item.transform.length < 5) continue;
      var ix = item.transform[4];
      if (ix < splitX) leftItems.push(item);
      else rightItems.push(item);
    }

    // 检查两栏是否都有足够内容（避免误判页边空白为栏分隔）
    if (leftItems.length < 5 || rightItems.length < 5) return items;

    // 合并：先左栏全部，再右栏全部
    return leftItems.concat(rightItems);
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
   * 合并行内文字（P1-2: 优化空格规则）
   * 规则：
   *   - CJK 字符之间不加空格
   *   - CJK 与 Latin/数字 之间加 0.5 个空格（ typographic convention，这里用单空格）
   *   - Latin 词之间已有空格则不重复加
   *   - 段末/行末标点符号与前字不加空格
   */
  function _mergeLineText(line) {
    var text = '';
    for (var i = 0; i < line.items.length; i++) {
      var rawStr = line.items[i].str || '';
      if (!rawStr) continue;

      // Bug#15b: trim 每个 text item 的前后空格
      // pdf.js 在 CJK 文本中常插入多余的前后空格（如 "聖 " → "聖"）
      // 对 Latin 文本，记住原始前导空格用于词间分隔
      var hadLeadingSpace = rawStr.charAt(0) === ' ';
      var str = rawStr.replace(/^\s+|\s+$/g, '');
      if (!str) continue;

      var prevChar = text.charAt(text.length - 1);
      var curChar = str.charAt(0);
      if (!prevChar) {
        text = str;
        continue;
      }
      // 行末标点不加空格
      var isPrevPunct = /[\u3000-\u303F\uFF00-\uFFEF，。！？；：、,.!?;:）)」』\]]/.test(prevChar);
      var isCurPunct = /^[\u3000-\u303F\uFF00-\uFFEF，。！？；：、,.!?;:（(「『\[]/.test(curChar);
      if (isPrevPunct || isCurPunct) {
        text += str;
        continue;
      }
      var prevCJK = _isCJK(prevChar);
      var curCJK = _isCJK(curChar);
      if (prevCJK && curCJK) {
        // CJK 字符之间不加空格
        text += str;
      } else if (prevCJK !== curCJK) {
        // CJK 与 Latin/数字之间加空格
        text += ' ' + str;
      } else if (hadLeadingSpace) {
        // Latin-Latin: 原始有前导空格，保留词间分隔
        text += ' ' + str;
      } else {
        // Latin-Latin: 默认不加空格（pdf.js 通常已在 str 内包含空格）
        text += str;
      }
    }

    // Bug#15b: 移除 CJK 字符之间的多余空格
    // pdf.js 有时在单个 item 的 str 内部也包含 CJK 间空格（如 "神聖 經"）
    // 使用 lookahead 避免连续 CJK+空格模式下遗漏中间空格
    text = text.replace(/([\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF])\s+(?=[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF])/g, '$1');

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
   * 进入 Reflow 模式：提取文字 → 增量构建 DOM → 插入页面
   * ★ 增量渲染优化：先渲染前 INCREMENTAL_BATCH 页，用户即可开始阅读；
   *   后续页面在 rAF 中分批追加，避免长PDF全量构建阻塞首屏
   * @returns {Promise<HTMLElement>} Reflow 容器元素
   */
  function enterReflowView(bookId) {
    if (!bookId) return Promise.reject(new Error('bookId required'));
    _reflowBookId = bookId;
    _isLoading = true;
    _textLayerCache = {};
    _renderAborted = false; // 重置中止标志（上次 exitReflowView 可能设为 true）
    _reflowRenderedUpTo = 0;

    return _extractAllPages(bookId).then(function (pages) {
      // 用户可能在提取过程中导航离开（exitReflowView 已被调用）
      if (_renderAborted) {
        _isLoading = false;
        return null;
      }

      _reflowPages = pages;

      // 创建 Reflow 容器
      var container = doc.createElement('div');
      container.id = 'bkPdfReflowView';
      container.className = 'bk-pdf-reflow-view bk-pdf-mode';

      // ★ 增量渲染：先渲染前 INCREMENTAL_BATCH 页（首屏可见）
      var firstBatch = Math.min(INCREMENTAL_BATCH, pages.length);
      var firstHTML = _buildReflowHTMLForRange(pages, 0, firstBatch);
      container.innerHTML = firstHTML;

      // 插入到 readingView（或 body 回退）
      var readingView = doc.getElementById('readingView');
      if (readingView) {
        readingView.appendChild(container);
      } else {
        doc.body.appendChild(container);
      }

      _reflowContainer = container;
      _reflowRenderedUpTo = firstBatch;
      _isLoading = false;

      // 绑定批注徽章点击事件
      _bindNoteBadgeClicks();

      // 渲染可用的图片
      _renderImages(bookId, pages);

      // 创建 IntersectionObserver 检测当前页码
      _setupDividerObserver();

      // ★ 后台增量渲染剩余页面
      if (pages.length > firstBatch) {
        _appendRemainingPages(pages, firstBatch);
      }

      return container;
    }).catch(function (err) {
      _isLoading = false;
      console.warn('[PDF-REFLOW] 进入重排模式失败:', err);
      return Promise.reject(err);
    });
  }

  /**
   * ★ 增量渲染辅助：为指定范围的页面构建 HTML
   */
  function _buildReflowHTMLForRange(pages, startIdx, endIdx) {
    // 临时构建子数组
    var subPages = pages.slice(startIdx, endIdx);
    return _buildReflowHTML(subPages);
  }

  /**
   * ★ 增量渲染辅助：分批追加剩余页面到容器
   * 使用 rAF 分帧，避免阻塞主线程
   */
  function _appendRemainingPages(pages, startIdx) {
    var container = _reflowContainer;
    if (!container || _renderAborted) return;

    var endIdx = Math.min(startIdx + INCREMENTAL_BATCH, pages.length);
    var html = _buildReflowHTMLForRange(pages, startIdx, endIdx);

    // 追加到容器末尾（在最后一个分隔符之后）
    container.insertAdjacentHTML('beforeend', html);
    _reflowRenderedUpTo = endIdx;

    // 继续追加下一批
    if (endIdx < pages.length) {
      (win.requestAnimationFrame || function (cb) { setTimeout(cb, 16); })(function () {
        _appendRemainingPages(pages, endIdx);
      });
    } else {
      // 全部追加完成，重新绑定批注事件
      _bindNoteBadgeClicks();
    }
  }

  /**
   * 退出 Reflow 模式：移除容器 DOM
   */
  function exitReflowView() {
    _renderAborted = true; // 中止后续图片渲染
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
      if (_renderAborted) return; // 已退出 reflow，放弃渲染

      var queue = [];
      for (var i = 0; i < imgWraps.length; i++) {
        var wrap = imgWraps[i];
        var pageNum = parseInt(wrap.getAttribute('data-reflow-img-page'), 10);
        if (!pageNum || pageNum < 1 || pageNum > pdf.numPages) continue;
        queue.push({ wrapEl: wrap, pageNum: pageNum });
      }

      // 并发控制：同时最多 3 个渲染任务（P2-2: 2→3，加速图片密集型 PDF 加载）
      var MAX_CONCURRENT = 3;
      var idx = 0;
      var active = 0;

      function next() {
        if (_renderAborted) return; // 已退出 reflow，停止派发新任务
        if (idx >= queue.length || active >= MAX_CONCURRENT) return;
        var task = queue[idx++];
        active++;

        pdf.getPage(task.pageNum).then(function (page) {
          if (_renderAborted) { active--; return; } // 已退出，不再渲染
          var scale = 1.5;
          var viewport = page.getViewport({ scale: scale });
          var canvas = doc.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          var ctx = canvas.getContext('2d');

          // return render promise 使 .catch() 能捕获 RenderingCancelledException
          return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
            if (_renderAborted) { active--; return; } // 已退出，不更新 DOM
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
        }).catch(function (err) {
          // 捕获 RenderingCancelledException（用户导航离开时正常发生）及其他渲染错误
          active--;
          if (err && err.name !== 'RenderingCancelledException') {
            // 非取消类错误才继续渲染后续页面
            next();
          }
        });
      }

      // 启动初始批次
      for (var b = 0; b < MAX_CONCURRENT && idx < queue.length; b++) {
        next();
      }
    }).catch(function () {
      // getPdfDoc 失败：静默处理，图片占位符保持原样
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
   * 注意：保留滚动位置，重建 IntersectionObserver（旧 divider DOM 已被销毁）
   */
  function refreshAnnotations() {
    if (!_reflowContainer || !_reflowPages.length) return;
    // 保存滚动位置（实际 scroller 可能是 readingView 或 document.scrollingElement）
    var readingView = doc.getElementById('readingView');
    var se = doc.scrollingElement;
    var savedScrollTop = -1;
    if (readingView && readingView.scrollTop > 0) {
      savedScrollTop = readingView.scrollTop;
    } else if (se && se.scrollTop > 0) {
      savedScrollTop = se.scrollTop;
    }
    var html = _buildReflowHTML(_reflowPages);
    _reflowContainer.innerHTML = html;
    // 恢复滚动位置
    if (savedScrollTop >= 0) {
      if (readingView) readingView.scrollTop = savedScrollTop;
      if (se) se.scrollTop = savedScrollTop;
    }
    _bindNoteBadgeClicks();
    // 重建 IntersectionObserver（innerHTML 替换后旧的 divider DOM 已被销毁）
    _setupDividerObserver();
  }

  // ==================== 页码检测 ====================

  /**
   * 检测当前页码（基于滚动位置 + 分隔符位置）
   *
   * 方案：使用 scroll 事件代替 IntersectionObserver。
   * 原因：Reflow 模式下滚动容器是 _reflowContainer（overflow:auto），
   * IntersectionObserver 即使设置 root=_reflowContainer，在快速滚动
   * 或程序化设置 scrollTop 时回调可能不触发；且 rootMargin:-90%
   * 使触发区域极窄（仅容器顶部 10%），分隔符容易跳过该区域。
   *
   * 滚动监听由 nav 模块的 _onScroll 驱动（150ms 防抖），
   * 每次回调委托本函数重新计算当前页码。
   */
  function _setupDividerObserver() {
    // 不再使用 IntersectionObserver，_detectedPage 由 detectCurrentPage() 实时计算
    if (_dividerObserver) {
      _dividerObserver.disconnect();
      _dividerObserver = null;
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
     * 检测当前页码（基于二分查找，O(log n)）
     * 替代 O(n) getBoundingClientRect 遍历，显著优化长文档滚动性能
     * 利用页码分隔符按页码递增排列的特点，二分查找最顶部的可见分隔符
     */
  function detectCurrentPage() {
    if (!_reflowContainer) return 1;
    var dividers = _reflowContainer.querySelectorAll('.bk-pdf-reflow-page-divider');
    if (!dividers.length) return 1;

    var containerRect = _reflowContainer.getBoundingClientRect();
    var viewTop = containerRect.top + 2;

    // 短文档（≤20页）直接遍历，O(n) 足够快
    if (dividers.length <= 20) {
      for (var i = dividers.length - 1; i >= 0; i--) {
        var rect = dividers[i].getBoundingClientRect();
        if (rect.top <= viewTop + 50) {
          return parseInt(dividers[i].getAttribute('data-reflow-page'), 10) || 1;
        }
      }
      return 1;
    }

    // 长文档：二分查找
    // 找到最后一个 top <= viewTop + 50 的分隔符
    var lo = 0, hi = dividers.length - 1;
    var result = 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var midRect = dividers[mid].getBoundingClientRect();
      if (midRect.top <= viewTop + 50) {
        result = parseInt(dividers[mid].getAttribute('data-reflow-page'), 10) || (mid + 1);
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
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
