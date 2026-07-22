/*!
 * pdf-core.js - PDF 渲染核心引擎
 *
 * 职责：
 *   - PDF 文档加载与缓存（带 CJK cMap 配置）
 *   - HiDPI 页面渲染（devicePixelRatio 放大）
 *   - 文本层（选词/复制/搜索）
 *   - 注解层（超链接）
 *   - 虚拟化（懒加载 + 回收）
 *   - 相邻页预渲染（单页模式翻页零白屏）
 *   - 加载 Spinner 与错误 UI
 *
 * 依赖：pdf-state.js 必须先加载
 * 挂载：window.BKPdf._internal.core
 */
(function (win) {
  'use strict';

  var doc = win.document;
  var S = win.BKPdf._internal.state;

  // ==================== 文档加载（带 CJK cMap 配置）====================

  /**
   * 等待 ImportManager 的 PDF 数据存储就绪（带超时）
   */
  function _waitForPdfStore(maxWait) {
    maxWait = maxWait || 10000;
    var start = Date.now();
    return new Promise(function (resolve, reject) {
      function check() {
        var store = (win.ImportManager && typeof win.ImportManager.getPdfDataStore === 'function')
          ? win.ImportManager.getPdfDataStore() : null;
        if (store) { resolve(store); return; }
        if (Date.now() - start > maxWait) {
          reject(new Error('等待 PDF 数据存储超时'));
          return;
        }
        setTimeout(check, 100);
      }
      check();
    });
  }

  /**
   * 获取 PDF 文档（会话内缓存 Promise）
   * 配置 cMapUrl 解决中文 PDF 乱码
   */
  function getPdfDoc(pdfBookId) {
    var cache = S.docCache();
    if (cache[pdfBookId]) return cache[pdfBookId];
    var p = _waitForPdfStore().then(function (pdfStore) {
      return pdfStore.getItem('pdf:' + pdfBookId);
    }).then(function (data) {
      if (!data) return Promise.reject(new Error('PDF 数据未找到: ' + pdfBookId));
      var lib = win.pdfjsLib;
      if (!lib) return Promise.reject(new Error('pdf.js 未加载'));
      return lib.getDocument({
        data: new Uint8Array(data),
        cMapUrl: S.CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: S.STANDARD_FONT_URL
      }).promise;
    });
    p.catch(function () { delete S.docCache()[pdfBookId]; });
    S.docCache()[pdfBookId] = p;
    return p;
  }

  // ==================== 页面 HTML 生成 ====================

  /**
   * 生成页面内部完整结构 HTML（placeholder 含 spinner + canvas-wrap）
   * 供 _ensurePageStructure 在页面进入视口时延迟填充。
   */
  function _pageInnerHTML(pgNum) {
    var safePg = String(parseInt(pgNum, 10) || 1);
    return '' +
      '<div class="bk-pdf-page-placeholder">' +
        '<div class="bk-pdf-spinner" aria-hidden="true">' +
          '<svg class="bk-pdf-spinner-svg" viewBox="0 0 50 50">' +
            '<circle cx="25" cy="25" r="20" fill="none" stroke-width="5" stroke-linecap="round"/>' +
          '</svg>' +
        '</div>' +
        '<span class="bk-pdf-page-num">第 ' + safePg + ' 页</span>' +
      '</div>' +
      '<div class="bk-pdf-canvas-wrap">' +
        '<canvas class="bk-pdf-canvas"></canvas>' +
        '<div class="bk-pdf-text-layer" data-pdf-text-layer></div>' +
        '<div class="bk-pdf-annotation-layer" data-pdf-annotation-layer></div>' +
      '</div>';
  }

  /**
   * 生成 PDF 页面的占位 HTML（供 renderer-content.js / _enterContinuousView 调用）
   * S2 优化：只生成轻量骨架壳（placeholder 仅含页码文字，无 spinner/canvas），
   * 内部完整结构延迟到进入视口时由 _ensurePageStructure 填充。
   * 初次进入连续模式时 300 页从 ~2100 节点降到 ~600 节点，消除 innerHTML 同步阻塞。
   * 配合 CSS content-visibility:auto + contain-intrinsic-size:90vh 保证滚动条不跳动。
   */
  function generatePageHTML(item) {
    var pgNum = item.pageNumber || 1;
    var pdfBkId = item.pdfBookId || '';
    var safePg = String(parseInt(pgNum, 10) || 1);
    var safeId = S.escAttr(pdfBkId);
    return '' +
      '<div class="bk-pdf-page" data-pdf-page="' + safePg + '" data-pdf-book="' + safeId + '">' +
        '<div class="bk-pdf-page-placeholder">' +
          '<span class="bk-pdf-page-num">第 ' + safePg + ' 页</span>' +
        '</div>' +
      '</div>';
  }

  /**
   * S2：确保页面内部结构已填充（幂等）
   * 骨架壳进入视口时由 renderPage 入口调用，填充 placeholder(含spinner) + canvas-wrap，
   * 使后续 canvas/placeholder/textLayer 查询可用。已填充则跳过（O(1) 检测）。
   */
  function _ensurePageStructure(el) {
    if (el.querySelector('.bk-pdf-canvas-wrap')) return; // 已填充完整结构
    var pgNum = parseInt(el.getAttribute('data-pdf-page'), 10) || 1;
    el.innerHTML = _pageInnerHTML(pgNum);
  }

  // ==================== HiDPI 渲染核心 ====================

  function renderPage(el, isRetry) {
    _ensurePageStructure(el);
    var pgNum = parseInt(el.getAttribute('data-pdf-page'), 10) || 1;
    var pdfBkId = el.getAttribute('data-pdf-book') || '';
    var canvas = el.querySelector('.bk-pdf-canvas');
    if (!canvas) return;
    var placeholder = el.querySelector('.bk-pdf-page-placeholder');

    // 取消该页面进行中的渲染任务（cancel 旧 renderTask）
    _cancelRender(el);

    var abort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var sigKey = S.pageKey(el);
    S.renderAbort()[sigKey] = abort;
    // 本轮渲染的唯一令牌：仅当abort仍为本轮时，才允许继续往下走创建renderTask
    // 防止IO回调+预渲染setTimeout几乎同时进入renderPage后，先到的cancel掉后，
    // 后到的ready继续执行覆盖canvas导致 pdf.js 'same canvas' 错误
    var myToken = abort;

    _setRenderingState(el, true);

    var ready = (isRetry || el.getAttribute('data-pdf-rendered') === '1')
      ? Promise.resolve()
      : new Promise(function (resolve) {
          (win.requestAnimationFrame || function (cb) { setTimeout(cb, 16); })(resolve);
        });

    ready.then(function () {
      // 守卫1：rAF 等待期间若已被新的 renderPage 调用 abort，则放弃本次渲染
      if (abort && abort.signal.aborted) return null;
      if (S.renderAbort()[sigKey] !== myToken) return null;
      // 守卫1.5：若该页此前已被其他调用成功渲染，则跳过（避免无谓重渲染撞 canvas）
      if (!isRetry && el.getAttribute('data-pdf-rendered') === '1') {
        // 已渲染：除非显式 retry，否则跳过
        // 但仍要走完 catch 不显示错误
        _setRenderingState(el, false);
        delete S.renderAbort()[sigKey];
        return null;
      }
      return getPdfDoc(pdfBkId);
    }).then(function (pdf) {
      if (!pdf) return null;
      if (abort && abort.signal.aborted) return null;
      if (S.renderAbort()[sigKey] !== myToken) return null;
      return pdf.getPage(pgNum);
    }).then(function (page) {
      if (!page) return null;
      if (abort && abort.signal.aborted) return null;
      if (S.renderAbort()[sigKey] !== myToken) return null;
      var baseViewport = page.getViewport({ scale: 1 });
      var containerWidth = _getContainerWidth(el);
      var containerHeight = _getContainerHeight(el);
      var baseScale = _computeFitScale(baseViewport, containerWidth, containerHeight);

      // 横向 PDF page 标记：让 CSS 启用横向滚动（fit-to-height 渲染后 canvas 比视口宽）
      // 在连续模式 + 横向 PDF 时给 page 元素加 class，无需依赖父容器状态
      if (baseViewport.width > baseViewport.height && S.mode() !== S.MODE_SINGLE) {
        el.classList.add('bk-pdf-landscape-page');
      }
      var zoom = S.zoom(pdfBkId);
      var renderScale = baseScale * zoom;
      var scaledViewport = page.getViewport({ scale: renderScale });

      var outputScale = win.devicePixelRatio || 1;
      canvas.width = Math.floor(scaledViewport.width * outputScale);
      canvas.height = Math.floor(scaledViewport.height * outputScale);
      canvas.style.width = Math.floor(scaledViewport.width) + 'px';
      canvas.style.height = Math.floor(scaledViewport.height) + 'px';

      var ctx = canvas.getContext('2d', { alpha: false });
      var transform = (outputScale !== 1)
        ? [outputScale, 0, 0, outputScale, 0, 0]
        : null;

      // 守卫2：在创建 renderTask 前最后一次确认（这是"同 canvas 多 render"防护关键点）
      if (abort && abort.signal.aborted) return null;
      if (S.renderAbort()[sigKey] !== myToken) return null;

      var renderTask = page.render({
        canvasContext: ctx,
        viewport: scaledViewport,
        transform: transform
      });

      if (abort) {
        abort.signal.addEventListener('abort', function () {
          try { renderTask.cancel(); } catch (e) {}
        });
      }

      return renderTask.promise.then(function () {
        if (abort && abort.signal.aborted) return null;
        if (S.renderAbort()[sigKey] !== myToken) return null;
        return Promise.all([
          _renderTextLayer(el, page, scaledViewport),
          _renderAnnotationLayer(el, page, scaledViewport)
        ]);
      });
    }).then(function (result) {
      if (result === null) return;
      _setRenderingState(el, false);
      delete S.renderAbort()[sigKey];
      el.setAttribute('data-pdf-rendered', '1');
      if (placeholder) placeholder.style.display = 'none';
      canvas.style.opacity = '1';
      _trackActivePage(el);

      // 渲染已保存的高亮标注（仅当前页，精准渲染而非全量）
      var pageNum = parseInt(el.getAttribute('data-pdf-page'), 10) || 0;
      if (pageNum > 0 && win.BKPdf._internal.highlight) {
        var hlMod = win.BKPdf._internal.highlight;
        var fn = hlMod.renderHighlightOnPage || hlMod.renderAllVisibleHighlights;
        if (fn) {
          setTimeout(function () {
            try { fn.call(hlMod, pageNum); } catch (e) {}
          }, 100);
        }
      }

      // 方案 G 兜底：容器宽度抖动自动重渲染
      if (!isRetry) {
        var postContainerWidth = _getContainerWidth(el);
        var renderedWidth = parseFloat(canvas.style.width) || 0;
        if (renderedWidth > 0 && postContainerWidth > 0) {
          var widthDiff = Math.abs(renderedWidth - postContainerWidth) / postContainerWidth;
          if (widthDiff > 0.03) {
            renderPage(el, true);
          }
        }
      }

      // 相邻页预渲染（单页模式下，预渲染前后页以实现零白屏翻页）
      _prerenderAdjacent(el);
    }).catch(function (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      if (abort && abort.signal.aborted) return;
      if (S.renderAbort()[sigKey] !== myToken) return;
      console.warn('[PDF] 页面渲染失败:', pgNum, err);
      _setRenderingState(el, false);
      _showErrorUI(el, pgNum);
    });
  }

  /**
   * 计算适配 scale
   * 单页模式：
   *   - 纵向 PDF（width <= height）：fit-to-width（按宽度适配，高度超出时竖向滚动）
   *   - 横向 PDF（width > height）：fit-to-screen（取 width 和 height 中较小的 scale，让整页可见）
   * 连续模式：
   *   - 纵向 PDF（width <= height）：fit-to-width（按宽度适配）
   *   - 横向 PDF（width > height）：fit-to-height（按高度适配），让横向 PDF 保留可读字号，
   *     超出宽度的部分由容器横向滚动显示
   */
  function _computeFitScale(baseViewport, containerWidth, containerHeight) {
    if (!containerWidth || containerWidth <= 0) return 1;
    var widthScale = containerWidth / baseViewport.width;
    if (S.mode() === S.MODE_SINGLE) {
      // 纵向 PDF（width <= height）：fit-to-width，填满视口宽度，高度超出时竖向滚动
      if (baseViewport.width <= baseViewport.height) {
        return Math.max(0.3, widthScale);
      }
      // 横向 PDF（width > height）：fit-to-screen，确保整页可见
      if (containerHeight && containerHeight > 0) {
        var singleHeightScale = containerHeight / baseViewport.height;
        return Math.max(0.3, Math.min(widthScale, singleHeightScale));
      }
      return Math.max(0.3, widthScale);
    }
    // 连续模式：检测横向 PDF（宽度 > 高度）
    if (containerHeight && containerHeight > 0 && baseViewport.width > baseViewport.height) {
      // 横向 PDF：fit-to-height，保留可读字号，超宽部分横向滚动
      var heightScale = containerHeight / baseViewport.height;
      // 限制不小于 0.3，避免超大页面缩太小；不大于 2.0，避免超小页面放太大
      return Math.max(0.3, Math.min(2.0, heightScale));
    }
    // 纵向 PDF：fit-to-width
    return widthScale;
  }

  function _cancelRender(el) {
    var sigKey = S.pageKey(el);
    var abort = S.renderAbort()[sigKey];
    if (abort) {
      try { abort.abort(); } catch (e) {}
      delete S.renderAbort()[sigKey];
    }
  }

  function _setRenderingState(el, rendering) {
    if (rendering) {
      el.setAttribute('data-pdf-rendering', '1');
    } else {
      el.removeAttribute('data-pdf-rendering');
    }
  }

  function _getContainerWidth(el) {
    var node = el.parentElement;
    while (node) {
      if (node.classList && (node.classList.contains('bk-pdf-page') ||
          node.classList.contains('content') ||
          node.id === 'chapterContent' ||
          node.classList.contains('bk-carousel-page') ||
          node.id === 'bkPdfContinuousView')) {
        void node.offsetWidth;
        var style = win.getComputedStyle(node);
        var pl = parseFloat(style.paddingLeft) || 0;
        var pr = parseFloat(style.paddingRight) || 0;
        var cw = node.clientWidth - pl - pr;
        if (cw > 0) return cw;
        break;
      }
      node = node.parentElement;
    }
    return el.clientWidth || 600;
  }

  /**
   * 获取容器高度（单页模式 fit-to-screen、连续模式横向 PDF fit-to-height 用）
   */
  function _getContainerHeight(el) {
    var node = el.parentElement;
    while (node) {
      if (node.classList && (node.classList.contains('content') ||
          node.id === 'chapterContent' ||
          node.classList.contains('bk-carousel-page') ||
          node.id === 'bkPdfContinuousView')) {
        void node.offsetHeight;
        var style = win.getComputedStyle(node);
        var pt = parseFloat(style.paddingTop) || 0;
        var pb = parseFloat(style.paddingBottom) || 0;
        var ch = node.clientHeight - pt - pb;
        if (ch > 0) return ch;
        break;
      }
      node = node.parentElement;
    }
    // 回退到视口高度
    return win.innerHeight || doc.documentElement.clientHeight || 0;
  }

  // ==================== 文本层（选词/复制/搜索）====================

  function _renderTextLayer(el, page, viewport) {
    var textLayerDiv = el.querySelector('[data-pdf-text-layer]');
    if (!textLayerDiv) return Promise.resolve();
    textLayerDiv.innerHTML = '';
    textLayerDiv.style.width = Math.floor(viewport.width) + 'px';
    textLayerDiv.style.height = Math.floor(viewport.height) + 'px';
    textLayerDiv.style.setProperty('--scale-factor', viewport.scale);

    return page.getTextContent().then(function (textContent) {
      var lib = win.pdfjsLib;
      if (lib && lib.TextLayer) {
        var textLayer = new lib.TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport: viewport
        });
        return textLayer.render();
      }
      if (lib && lib.renderTextLayer) {
        var task = lib.renderTextLayer({
          textContent: textContent,
          container: textLayerDiv,
          viewport: viewport,
          textDivs: []
        });
        return task.promise;
      }
      return Promise.resolve();
    }).catch(function (err) {
      console.warn('[PDF] 文本层渲染失败（不影响阅读）:', err);
    });
  }

  // ==================== 注解层（超链接等）====================

  function _renderAnnotationLayer(el, page, viewport) {
    var annotationDiv = el.querySelector('[data-pdf-annotation-layer]');
    if (!annotationDiv) return Promise.resolve();
    annotationDiv.innerHTML = '';
    annotationDiv.style.width = Math.floor(viewport.width) + 'px';
    annotationDiv.style.height = Math.floor(viewport.height) + 'px';

    var lib = win.pdfjsLib;
    if (!lib || !lib.AnnotationLayer) return Promise.resolve();

    return page.getAnnotations().then(function (annotations) {
      if (!annotations || !annotations.length) return;
      var annotationLayer = new lib.AnnotationLayer({
        div: annotationDiv,
        page: page,
        viewport: viewport
      });
      // linkService 由 pdf-links.js 提供，如果未加载则用空 stub
      var links = win.BKPdf._internal.links;
      var linkService = links ? links.getLinkService() : _noopLinkService;
      return annotationLayer.render({
        annotations: annotations,
        imageResourcesPath: S.IMAGE_RESOURCES_PATH,
        renderForms: false,
        linkService: linkService
      });
    }).catch(function (err) {
      console.warn('[PDF] 注解层渲染失败（不影响阅读）:', err);
    });
  }

  // 空的 linkService stub（links 模块未加载时用）
  var _noopLinkService = {
    externalLinkTarget: 2,
    externalLinkRel: 'noopener noreferrer nofollow',
    externalLinkEnabled: true,
    addLinkAttributes: function () {},
    getDestinationHash: function () { return ''; },
    getAnchorUrl: function (hash) { return hash; },
    goToDestination: function () { return Promise.resolve(); },
    goToPage: function () {},
    setHash: function () {},
    executeNamedAction: function () {},
    executeSetOCGState: function () {}
  };

  // ==================== 相邻页预渲染 ====================

  /**
   * 预渲染当前页的相邻页（单页模式下翻页零白屏）
   * 只预渲染尚未渲染且不在回收区的页面
   */
  function _prerenderAdjacent(el) {
    if (S.mode() !== S.MODE_SINGLE) return;
    var pgNum = parseInt(el.getAttribute('data-pdf-page'), 10) || 1;
    var allPages = doc.querySelectorAll('.bk-pdf-page');
    if (allPages.length <= 1) return;

    // 找到当前位置前后各 PRERENDER_ADJACENT 页
    var elIdx = -1;
    for (var i = 0; i < allPages.length; i++) {
      if (allPages[i] === el) { elIdx = i; break; }
    }
    if (elIdx < 0) return;

    var adj = S.PRERENDER_ADJACENT;
    for (var j = 1; j <= adj; j++) {
      // 后页
      var nextEl = allPages[elIdx + j];
      if (nextEl && nextEl.getAttribute('data-pdf-rendered') !== '1' &&
          nextEl.getAttribute('data-pdf-rendering') !== '1') {
        setTimeout(function (e) { renderPage(e); }, 100 + j * 50, nextEl);
      }
      // 前页
      var prevEl = allPages[elIdx - j];
      if (prevEl && prevEl.getAttribute('data-pdf-rendered') !== '1' &&
          prevEl.getAttribute('data-pdf-rendering') !== '1') {
        setTimeout(function (e) { renderPage(e); }, 100 + j * 50, prevEl);
      }
    }
  }

  // ==================== 虚拟化（懒加载 + 回收）====================

  function _trackActivePage(el) {
    var active = S.activePages();
    if (active.indexOf(el) === -1) {
      active.push(el);
    }
    if (active.length > S.RECYCLE_THRESHOLD) {
      _recycleDistantPages();
    }
  }

  function _recycleDistantPages() {
    var active = S.activePages();
    var keep = [];
    var recycled = 0;
    var vh = win.innerHeight || doc.documentElement.clientHeight;
    for (var i = 0; i < active.length; i++) {
      var el = active[i];
      if (!el || !el.parentNode) {
        recycled++;
        continue;
      }
      var rect = el.getBoundingClientRect();
      // 单页模式横向回收，连续模式纵向回收
      if (S.mode() === S.MODE_SINGLE) {
        var vw = win.innerWidth || doc.documentElement.clientWidth;
        if (rect.right < -vw * 2 || rect.left > vw * 3) {
          _recyclePage(el);
          recycled++;
        } else {
          keep.push(el);
        }
      } else {
        if (rect.bottom < -vh * 2 || rect.top > vh * 3) {
          _recyclePage(el);
          recycled++;
        } else {
          keep.push(el);
        }
      }
    }
    S.setActivePages(keep);
  }

  function _recyclePage(el) {
    _cancelRender(el);
    el.removeAttribute('data-pdf-rendered');
    el.removeAttribute('data-pdf-rendering'); // 修复：cancel 后 promise 链提前 return 不走 _setRenderingState(false)，若不清理则 observer 会因 data-pdf-rendering="1" 跳过该页，导致回收后永不重渲染
    // S2 激进回收：直接清空 innerHTML 恢复为骨架壳，
    // 释放 canvas/textLayer/annotationLayer 等所有子节点内存（含 canvas GPU 纹理，比手动 width=0 更彻底）。
    // CSS content-visibility:auto + contain-intrinsic-size:90vh 保证占位高度不变，滚动条不跳动。
    // 再次进入视口时 renderPage 入口的 _ensurePageStructure 会重新填充完整结构。
    var pgNum = parseInt(el.getAttribute('data-pdf-page'), 10) || 1;
    el.innerHTML =
      '<div class="bk-pdf-page-placeholder">' +
        '<span class="bk-pdf-page-num">第 ' + pgNum + ' 页</span>' +
      '</div>';
    if (S.observer()) {
      S.observer().observe(el);
    }
  }

  // ==================== 错误 UI ====================

  function _showErrorUI(el, pgNum) {
    var placeholder = el.querySelector('.bk-pdf-page-placeholder');
    if (!placeholder) return;
    placeholder.innerHTML =
      '<div class="bk-pdf-error">' +
        '<span class="bk-pdf-error-icon">⚠</span>' +
        '<span class="bk-pdf-error-text">第 ' + S.escText(String(pgNum)) + ' 页加载失败</span>' +
        '<button class="bk-pdf-retry-btn" data-pdf-retry>重试</button>' +
      '</div>';
    placeholder.style.display = '';
    var retryBtn = placeholder.querySelector('[data-pdf-retry]');
    if (retryBtn) {
      retryBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        // 恢复 placeholder 为 spinner
        placeholder.innerHTML =
          '<div class="bk-pdf-spinner" aria-hidden="true">' +
            '<svg class="bk-pdf-spinner-svg" viewBox="0 0 50 50">' +
              '<circle cx="25" cy="25" r="20" fill="none" stroke-width="5" stroke-linecap="round"/>' +
            '</svg>' +
          '</div>' +
          '<span class="bk-pdf-page-num">第 ' + pgNum + ' 页</span>';
        renderPage(el);
      });
    }
  }

  // ==================== 销毁文档缓存 ====================

  function destroyDocCache() {
    var cache = S.docCache();
    var keys = Object.keys(cache);
    for (var j = 0; j < keys.length; j++) {
      var p = cache[keys[j]];
      if (p && typeof p.then === 'function') {
        p.then(function (pdf) {
          if (pdf && pdf.destroy) pdf.destroy();
        }).catch(function () {});
      }
    }
    S.setDocCache({});
  }

  // ==================== 导出 ====================

  win.BKPdf._internal.core = {
    getPdfDoc: getPdfDoc,
    generatePageHTML: generatePageHTML,
    renderPage: renderPage,
    cancelRender: _cancelRender,
    recyclePage: _recyclePage,
    recycleDistantPages: _recycleDistantPages,
    destroyDocCache: destroyDocCache,
    getContainerWidth: _getContainerWidth,
    // 暴露 noopLinkService 供 links 模块参考
    noopLinkService: _noopLinkService
  };

})(window);
