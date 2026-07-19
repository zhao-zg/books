/*!
 * renderer-pdf.js - PDF 阅读器渲染模块
 *
 * 功能对标市面主流 PDF 阅读器：
 *   - HiDPI 清晰度（devicePixelRatio 放大渲染）
 *   - CJK 字体支持（cMapUrl + standardFontDataUrl）
 *   - 文本层（选词/复制/搜索）
 *   - 注解层（超链接点击）
 *   - 缩放交互（双击/pinch-zoom/按钮，1x~3x）
 *   - 虚拟化回收（离开视口回收 canvas，减少内存占用）
 *
 * 依赖：pdf.js 4.x (globalThis.pdfjsLib)
 * 挂载：window.BKPdf
 */
(function (win) {
  'use strict';

  var doc = win.document;

  // ==================== 常量 ====================

  var PDF_VENDOR_BASE = './vendor/';
  var CMAP_URL = PDF_VENDOR_BASE + 'cmaps/';
  var STANDARD_FONT_URL = PDF_VENDOR_BASE + 'standard_fonts/';
  var IMAGE_RESOURCES_PATH = PDF_VENDOR_BASE + 'images/';
  var MAX_ZOOM = 3.0;           // 最大放大倍数
  var MIN_ZOOM = 1.0;           // 最小倍数（= fit-to-width）
  var ZOOM_STEP = 0.5;          // 每次缩放步长
  var RECYCLE_THRESHOLD = 8;    // 超过此数量的已渲染页面触发回收

  // ==================== 状态 ====================

  var _pdfDocCache = {};            // pdfBookId → Promise<PDFDocument>
  var _pdfRenderObserver = null;    // IntersectionObserver
  var _pdfZoomState = {};           // pdfBookId → { scale, rootMargin }
  var _pdfActivePages = [];         // 当前已渲染的页面元素列表（用于回收）
  var _pdfRenderAbort = {};         // el → AbortController（取消进行中的渲染）
  var _pdfCurrentBookId = null;     // 当前阅读的 PDF 书 ID（用于控制 zoom）
  var _pdfZoomControls = null;      // zoom 控件 DOM
  var _pdfResizeHandler = null;     // 视口变化重渲染的防抖处理器

  // ==================== 文档加载（带 CJK cMap 配置）====================

  /**
   * 等待 ImportManager 的 PDF 数据存储就绪（带超时）
   * 解决 IntersectionObserver 早于 ImportManager 初始化触发导致的渲染失败
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
    if (_pdfDocCache[pdfBookId]) return _pdfDocCache[pdfBookId];
    var p = _waitForPdfStore().then(function (pdfStore) {
      return pdfStore.getItem('pdf:' + pdfBookId);
    }).then(function (data) {
      if (!data) return Promise.reject(new Error('PDF 数据未找到: ' + pdfBookId));
      var lib = win.pdfjsLib;
      if (!lib) return Promise.reject(new Error('pdf.js 未加载'));
      // 配置 cMap 和标准字体，解决 CJK 字体和标准字体缺失问题
      return lib.getDocument({
        data: new Uint8Array(data),
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: STANDARD_FONT_URL
      }).promise;
    });
    _pdfDocCache[pdfBookId] = p;
    return p;
  }

  // ==================== 页面 HTML 生成 ====================

  /**
   * 生成 PDF 页面的占位 HTML（供 renderer-content.js 调用）
   * 结构：.bk-pdf-page > [placeholder, .bk-pdf-canvas-wrap > canvas + textLayer + annotationLayer]
   */
  function generatePageHTML(item) {
    var pgNum = item.pageNumber || 1;
    var pdfBkId = item.pdfBookId || '';
    var safePg = String(parseInt(pgNum, 10) || 1);
    var safeId = _escAttr(pdfBkId);
    return '' +
      '<div class="bk-pdf-page" data-pdf-page="' + safePg + '" data-pdf-book="' + safeId + '">' +
        '<div class="bk-pdf-page-placeholder"><span>第 ' + safePg + ' 页</span></div>' +
        '<div class="bk-pdf-canvas-wrap">' +
          '<canvas class="bk-pdf-canvas"></canvas>' +
          '<div class="bk-pdf-text-layer" data-pdf-text-layer></div>' +
          '<div class="bk-pdf-annotation-layer" data-pdf-annotation-layer></div>' +
        '</div>' +
      '</div>';
  }

  function _escAttr(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ==================== HiDPI 渲染核心 ====================

  /**
   * 渲染单个 PDF 页面（HiDPI + 文本层 + 注解层）
   * @param {HTMLElement} el - .bk-pdf-page 元素
   * @param {boolean} isRetry - 因 zoom 变化重渲染时为 true
   */
  function renderPage(el, isRetry) {
    var pgNum = parseInt(el.getAttribute('data-pdf-page'), 10) || 1;
    var pdfBkId = el.getAttribute('data-pdf-book') || '';
    var canvas = el.querySelector('.bk-pdf-canvas');
    if (!canvas) return;
    var placeholder = el.querySelector('.bk-pdf-page-placeholder');

    // 取消该元素上正在进行的渲染
    _cancelRender(el);

    var abort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    _pdfRenderAbort[el.dataset.pdfBook + ':' + el.dataset.pdfPage] = abort;
    var sigKey = el.dataset.pdfBook + ':' + el.dataset.pdfPage;

    _setRenderingState(el, true);

    getPdfDoc(pdfBkId).then(function (pdf) {
      return pdf.getPage(pgNum);
    }).then(function (page) {
      // 计算 fit-to-width 基础 scale
      var baseViewport = page.getViewport({ scale: 1 });
      var containerWidth = _getContainerWidth(el);
      var baseScale = containerWidth / baseViewport.width;

      // 叠加用户 zoom
      var zoom = _getZoom(pdfBkId);
      var renderScale = baseScale * zoom;
      var scaledViewport = page.getViewport({ scale: renderScale });

      // HiDPI：canvas 内部分辨率 = CSS 尺寸 × devicePixelRatio
      var outputScale = win.devicePixelRatio || 1;
      canvas.width = Math.floor(scaledViewport.width * outputScale);
      canvas.height = Math.floor(scaledViewport.height * outputScale);
      canvas.style.width = Math.floor(scaledViewport.width) + 'px';
      canvas.style.height = Math.floor(scaledViewport.height) + 'px';

      var ctx = canvas.getContext('2d', { alpha: false });

      // transform 矩阵让 pdf.js 在放大后的 canvas 上正确绘制
      var transform = (outputScale !== 1)
        ? [outputScale, 0, 0, outputScale, 0, 0]
        : null;

      var renderTask = page.render({
        canvasContext: ctx,
        viewport: scaledViewport,
        transform: transform
      });

      // 关联 abort 信号
      if (abort) {
        abort.signal.addEventListener('abort', function () {
          try { renderTask.cancel(); } catch (e) {}
        });
      }

      return renderTask.promise.then(function () {
        // 渲染成功 → 构建文本层和注解层
        return Promise.all([
          _renderTextLayer(el, page, scaledViewport),
          _renderAnnotationLayer(el, page, scaledViewport)
        ]);
      });
    }).then(function () {
      _setRenderingState(el, false);
      // 记录已渲染（用 dataset 替代属性，方便回收后清除）
      el.setAttribute('data-pdf-rendered', '1');
      if (placeholder) placeholder.style.display = 'none';
      canvas.style.opacity = '1';
      _trackActivePage(el);
    }).catch(function (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      console.warn('[PDF] 页面渲染失败:', pgNum, err);
      _setRenderingState(el, false);
      if (placeholder) {
        placeholder.innerHTML = '<span>页面加载失败</span>';
        placeholder.style.display = '';
      }
    });
  }

  function _cancelRender(el) {
    var sigKey = el.dataset.pdfBook + ':' + el.dataset.pdfPage;
    var abort = _pdfRenderAbort[sigKey];
    if (abort) {
      try { abort.abort(); } catch (e) {}
      delete _pdfRenderAbort[sigKey];
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
    // 向上查找第一个有有效内容宽度的祖先元素
    // 注意：clientWidth 包含 padding，需要减去 padding 才是实际可用宽度
    var node = el.parentElement;
    while (node) {
      var style = win.getComputedStyle(node);
      var pl = parseFloat(style.paddingLeft) || 0;
      var pr = parseFloat(style.paddingRight) || 0;
      var cw = node.clientWidth - pl - pr;
      if (cw > 0) return cw;
      node = node.parentElement;
    }
    return el.clientWidth || 600;
  }

  // ==================== 文本层（选词/复制/搜索）====================

  function _renderTextLayer(el, page, viewport) {
    var textLayerDiv = el.querySelector('[data-pdf-text-layer]');
    if (!textLayerDiv) return Promise.resolve();
    // 清空旧内容
    textLayerDiv.innerHTML = '';
    textLayerDiv.style.width = Math.floor(viewport.width) + 'px';
    textLayerDiv.style.height = Math.floor(viewport.height) + 'px';
    textLayerDiv.style.setProperty('--scale-factor', viewport.scale);

    return page.getTextContent().then(function (textContent) {
      var lib = win.pdfjsLib;
      // pdf.js 4.x 优先用 TextLayer 类 API
      if (lib && lib.TextLayer) {
        var textLayer = new lib.TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport: viewport
        });
        return textLayer.render();
      }
      // 回退：旧版 renderTextLayer 函数（兼容）
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
      // 文本层失败不影响阅读
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
      return annotationLayer.render({
        annotations: annotations,
        imageResourcesPath: IMAGE_RESOURCES_PATH,
        renderForms: false,
        linkService: _pdfLinkService
      });
    }).catch(function (err) {
      console.warn('[PDF] 注解层渲染失败（不影响阅读）:', err);
    });
  }

  // LinkTarget 常量（与 pdf.js 官方一致）
  var PDF_LINK_TARGET = { NONE: 0, SELF: 1, BLANK: 2, PARENT: 3, TOP: 4 };
  var PDF_DEFAULT_LINK_REL = 'noopener noreferrer nofollow';

  // LinkService：实现 ILinkService 接口
  // 处理外部超链接（点击打开系统浏览器）；内部跳转暂留接口
  var _pdfLinkService = {
    // 外部链接目标：BLANK 让外链在系统浏览器/新窗口打开
    externalLinkTarget: PDF_LINK_TARGET.BLANK,
    externalLinkRel: PDF_DEFAULT_LINK_REL,
    externalLinkEnabled: true,
    // 给 <a> 标签注入 href / target / rel 属性（与官方 PDFLinkService.addLinkAttributes 一致）
    addLinkAttributes: function (link, url, newWindow) {
      if (!url || typeof url !== 'string') {
        throw new Error('A valid "url" parameter must provided.');
      }
      var target = newWindow ? PDF_LINK_TARGET.BLANK : this.externalLinkTarget;
      if (this.externalLinkEnabled) {
        link.href = link.title = url;
      } else {
        link.href = '';
        link.title = 'Disabled: ' + url;
        link.onclick = function () { return false; };
      }
      var targetStr = '';
      switch (target) {
        case PDF_LINK_TARGET.NONE: break;
        case PDF_LINK_TARGET.SELF: targetStr = '_self'; break;
        case PDF_LINK_TARGET.BLANK: targetStr = '_blank'; break;
        case PDF_LINK_TARGET.PARENT: targetStr = '_parent'; break;
        case PDF_LINK_TARGET.TOP: targetStr = '_top'; break;
      }
      link.target = targetStr;
      link.rel = typeof this.externalLinkRel === 'string' ? this.externalLinkRel : PDF_DEFAULT_LINK_REL;
    },
    // 返回 PDF 内部目的地的 hash 锚点（仅供渲染层显示 href，实际跳转走 goToDestination）
    getDestinationHash: function (dest) {
      if (typeof dest === 'string') {
        if (dest.length > 0) return this.getAnchorUrl('#' + encodeURIComponent(dest));
      } else if (Array.isArray(dest)) {
        var str = JSON.stringify(dest);
        if (str.length > 0) return this.getAnchorUrl('#' + encodeURIComponent(str));
      }
      return this.getAnchorUrl('');
    },
    getAnchorUrl: function (hash) { return hash; },
    // 内部跳转（暂未接入 carousel 页码映射，留接口避免抛错）
    goToDestination: function (dest) {
      console.warn('[PDF] goToDestination 暂未实现内部跳转:', dest);
      return Promise.resolve();
    },
    goToPage: function (val) {
      console.warn('[PDF] goToPage 暂未实现内部跳转:', val);
    },
    setHash: function (hash) { /* no-op */ },
    executeNamedAction: function (action) {
      console.warn('[PDF] executeNamedAction 暂未实现:', action);
    },
    executeSetOCGState: function (action) { /* no-op */ }
  };

  // ==================== 缩放交互 ====================

  function _getZoom(pdfBookId) {
    var st = _pdfZoomState[pdfBookId];
    return st ? st.zoom : 1.0;
  }

  function _setZoom(pdfBookId, zoom) {
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    _pdfZoomState[pdfBookId] = _pdfZoomState[pdfBookId] || {};
    _pdfZoomState[pdfBookId].zoom = zoom;
    _updateZoomControls(zoom);
    return zoom;
  }

  /**
   * 重渲染所有可见的 PDF 页面（缩放变化后调用）
   */
  function _applyZoomToVisible(pdfBookId) {
    var pages = doc.querySelectorAll('.bk-pdf-page[data-pdf-rendered="1"], .bk-pdf-page[data-pdf-rendering="1"]');
    for (var i = 0; i < pages.length; i++) {
      // 重置渲染状态
      pages[i].removeAttribute('data-pdf-rendered');
      renderPage(pages[i], true);
    }
  }

  function zoomIn(pdfBookId) {
    var z = _getZoom(pdfBookId);
    _setZoom(pdfBookId, z + ZOOM_STEP);
    _applyZoomToVisible(pdfBookId);
  }

  function zoomOut(pdfBookId) {
    var z = _getZoom(pdfBookId);
    _setZoom(pdfBookId, z - ZOOM_STEP);
    _applyZoomToVisible(pdfBookId);
  }

  function resetZoom(pdfBookId) {
    _setZoom(pdfBookId, 1.0);
    _applyZoomToVisible(pdfBookId);
  }

  /**
   * 创建/获取浮动的 zoom 控件
   */
  function _ensureZoomControls() {
    if (_pdfZoomControls) return _pdfZoomControls;
    var bar = doc.createElement('div');
    bar.className = 'bk-pdf-zoom-bar';
    bar.innerHTML =
      '<button class="bk-pdf-zoom-btn" data-pdf-zoom="out" aria-label="缩小">−</button>' +
      '<span class="bk-pdf-zoom-value">100%</span>' +
      '<button class="bk-pdf-zoom-btn" data-pdf-zoom="in" aria-label="放大">＋</button>' +
      '<button class="bk-pdf-zoom-btn" data-pdf-zoom="reset" aria-label="重置">⊙</button>';
    doc.body.appendChild(bar);

    bar.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pdf-zoom]');
      if (!btn) return;
      if (!_pdfCurrentBookId) return;
      var action = btn.getAttribute('data-pdf-zoom');
      if (action === 'in') zoomIn(_pdfCurrentBookId);
      else if (action === 'out') zoomOut(_pdfCurrentBookId);
      else if (action === 'reset') resetZoom(_pdfCurrentBookId);
    });

    _pdfZoomControls = bar;
    return bar;
  }

  function _showZoomControls(pdfBookId) {
    _pdfCurrentBookId = pdfBookId;
    var bar = _ensureZoomControls();
    bar.style.display = 'flex';
    _updateZoomControls(_getZoom(pdfBookId));
  }

  function _hideZoomControls() {
    if (_pdfZoomControls) _pdfZoomControls.style.display = 'none';
    _pdfCurrentBookId = null;
  }

  function _updateZoomControls(zoom) {
    if (!_pdfZoomControls) return;
    var val = _pdfZoomControls.querySelector('.bk-pdf-zoom-value');
    if (val) val.textContent = Math.round(zoom * 100) + '%';
  }

  /**
   * 双击切换缩放（1x ↔ 2x），双击位置为中心
   */
  function _setupDoubleTapZoom(el, pdfBookId) {
    var lastTap = 0;
    el.addEventListener('click', function (e) {
      var now = Date.now();
      if (now - lastTap < 350) {
        e.preventDefault();
        e.stopPropagation();
        var cur = _getZoom(pdfBookId);
        if (cur > 1.0) {
          resetZoom(pdfBookId);
        } else {
          _setZoom(pdfBookId, 2.0);
          _applyZoomToVisible(pdfBookId);
        }
      }
      lastTap = now;
    });
  }

  /**
   * 双指 pinch-zoom（移动端）
   */
  function _setupPinchZoom(el, pdfBookId) {
    var pinchStartDist = 0;
    var pinchStartZoom = 1;
    var active = false;

    el.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        e.preventDefault();
        active = true;
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDist = Math.sqrt(dx * dx + dy * dy);
        pinchStartZoom = _getZoom(pdfBookId);
      }
    }, { passive: false });

    el.addEventListener('touchmove', function (e) {
      if (!active || e.touches.length !== 2) return;
      e.preventDefault();
      var dx = e.touches[0].clientX - e.touches[1].clientX;
      var dy = e.touches[0].clientY - e.touches[1].clientY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (pinchStartDist > 0) {
        var ratio = dist / pinchStartDist;
        var newZoom = pinchStartZoom * ratio;
        _setZoom(pdfBookId, newZoom);
      }
    }, { passive: false });

    el.addEventListener('touchend', function (e) {
      if (active) {
        active = false;
        _applyZoomToVisible(pdfBookId);
      }
    });

    el.addEventListener('touchcancel', function () {
      if (active) {
        active = false;
        _applyZoomToVisible(pdfBookId);
      }
    });
  }

  // ==================== 虚拟化（懒加载 + 回收）====================

  function _trackActivePage(el) {
    if (_pdfActivePages.indexOf(el) === -1) {
      _pdfActivePages.push(el);
    }
    // 超过阈值时回收远离视口的页面
    if (_pdfActivePages.length > RECYCLE_THRESHOLD) {
      _recycleDistantPages();
    }
  }

  /**
   * 回收不在视口附近的已渲染页面（释放 canvas 内存）
   */
  function _recycleDistantPages() {
    var keep = [];
    var recycled = 0;
    for (var i = 0; i < _pdfActivePages.length; i++) {
      var el = _pdfActivePages[i];
      if (!el || !el.parentNode) {
        recycled++;
        continue;
      }
      var rect = el.getBoundingClientRect();
      var vh = win.innerHeight || doc.documentElement.clientHeight;
      // 保留视口上下 2 屏内的页面
      if (rect.bottom < -vh * 2 || rect.top > vh * 3) {
        _recyclePage(el);
        recycled++;
      } else {
        keep.push(el);
      }
    }
    _pdfActivePages = keep;
    if (recycled > 0) {
      console.log('[PDF] 回收', recycled, '个离屏页面');
    }
  }

  function _recyclePage(el) {
    _cancelRender(el);
    el.removeAttribute('data-pdf-rendered');
    var canvas = el.querySelector('.bk-pdf-canvas');
    if (canvas) {
      // 释放 canvas 内存
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.opacity = '0';
    }
    var textLayer = el.querySelector('[data-pdf-text-layer]');
    if (textLayer) textLayer.innerHTML = '';
    var annLayer = el.querySelector('[data-pdf-annotation-layer]');
    if (annLayer) annLayer.innerHTML = '';
    var placeholder = el.querySelector('.bk-pdf-page-placeholder');
    if (placeholder) {
      placeholder.style.display = '';
    }
    // 重新纳入观察，以便再次进入视口时渲染
    if (_pdfRenderObserver) {
      _pdfRenderObserver.observe(el);
    }
  }

  // ==================== 懒渲染入口 ====================

  /**
   * 初始化 PDF 页面懒渲染（供 renderer-content.js / renderer-carousel.js 调用）
   * @param {HTMLElement} containerEl - 包含 .bk-pdf-page 的容器
   */
  function init(containerEl) {
    var pages = containerEl.querySelectorAll('.bk-pdf-page');
    if (!pages.length) return;

    // 推断当前 bookId（取第一个页面的 data-pdf-book）
    var pdfBookId = pages[0].getAttribute('data-pdf-book') || '';
    if (pdfBookId) {
      _showZoomControls(pdfBookId);
    }

    if (!_pdfRenderObserver) {
      _pdfRenderObserver = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i];
          if (entry.isIntersecting) {
            // 进入视口 → 渲染
            if (entry.target.getAttribute('data-pdf-rendered') !== '1' &&
                entry.target.getAttribute('data-pdf-rendering') !== '1') {
              renderPage(entry.target);
            }
          } else {
            // 离开视口（且已渲染）→ 延迟回收
            if (entry.target.getAttribute('data-pdf-rendered') === '1') {
              // 不立即回收，交给 _recycleDistantPages 批量处理
            }
          }
        }
      }, {
        rootMargin: '400px 0px',
        threshold: 0
      });
    }

    for (var i = 0; i < pages.length; i++) {
      // 绑定缩放手势
      _setupDoubleTapZoom(pages[i], pdfBookId);
      _setupPinchZoom(pages[i], pdfBookId);
      _pdfRenderObserver.observe(pages[i]);
    }

    // 响应式：视口尺寸变化时重渲染当前可见的 PDF 页面
    // 场景：桌面端窗口缩放、手机旋转屏幕、双栏↔单栏切换导致容器宽度变化。
    // 不重渲染会导致 canvas 仍按旧宽度绘制，与新容器宽度不匹配（页面偏窄/偏宽）。
    if (_pdfResizeHandler) {
      win.removeEventListener('resize', _pdfResizeHandler);
      win.removeEventListener('orientationchange', _pdfResizeHandler);
    }
    var _resizeTimer = null;
    _pdfResizeHandler = function () {
      if (_resizeTimer) clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(function () {
        // 只重渲染当前在视口内的已渲染页面（避免全量重渲染卡顿）
        for (var i = 0; i < _pdfActivePages.length; i++) {
          var el = _pdfActivePages[i];
          if (!el) continue;
          if (el.getAttribute('data-pdf-rendered') !== '1') continue;
          var rect = el.getBoundingClientRect();
          if (rect.bottom > 0 && rect.top < win.innerHeight) {
            // isRetry=true 强制重渲染（重新读取容器宽度）
            renderPage(el, true);
          }
        }
        _resizeTimer = null;
      }, 300);
    };
    win.addEventListener('resize', _pdfResizeHandler);
    win.addEventListener('orientationchange', _pdfResizeHandler);
  }

  // ==================== 清理 ====================

  function cleanup() {
    // 取消所有进行中的渲染
    var keys = Object.keys(_pdfRenderAbort);
    for (var i = 0; i < keys.length; i++) {
      try { _pdfRenderAbort[keys[i]].abort(); } catch (e) {}
    }
    _pdfRenderAbort = {};

    // 销毁 PDF 文档缓存
    var docKeys = Object.keys(_pdfDocCache);
    for (var j = 0; j < docKeys.length; j++) {
      var p = _pdfDocCache[docKeys[j]];
      if (p && typeof p.then === 'function') {
        p.then(function (pdf) {
          if (pdf && pdf.destroy) pdf.destroy();
        }).catch(function () {});
      }
    }
    _pdfDocCache = {};

    // 清理观察器
    if (_pdfRenderObserver) {
      _pdfRenderObserver.disconnect();
      _pdfRenderObserver = null;
    }

    // 释放所有已渲染 canvas
    for (var k = 0; k < _pdfActivePages.length; k++) {
      var el = _pdfActivePages[k];
      if (el) {
        var cv = el.querySelector('.bk-pdf-canvas');
        if (cv) { cv.width = 0; cv.height = 0; }
      }
    }
    _pdfActivePages = [];

    // 移除响应式监听器
    if (_pdfResizeHandler) {
      win.removeEventListener('resize', _pdfResizeHandler);
      win.removeEventListener('orientationchange', _pdfResizeHandler);
      _pdfResizeHandler = null;
    }

    // 隐藏 zoom 控件
    _hideZoomControls();
  }

  // ==================== 导出 ====================

  win.BKPdf = {
    init: init,
    cleanup: cleanup,
    renderPage: renderPage,
    getPdfDoc: getPdfDoc,
    generatePageHTML: generatePageHTML,
    zoomIn: zoomIn,
    zoomOut: zoomOut,
    resetZoom: resetZoom
  };

})(window);
