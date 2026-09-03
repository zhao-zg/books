/*!
 * pdf-links.js - PDF 内部链接跳转 + 跳转后返回栈
 *
 * 职责：
 *   - 实现 PDFLinkService 接口（goToDestination/goToPage/executeNamedAction）
 *   - PDF 内部跳转（目录条目、内文交叉引用）
 *   - 外部 URL 跳转（http/https/mailto/tel 白名单 + XSS 防护）
 *   - NamedAction 处理（FirstPage/LastPage/NextPage/PrevPage）
 *   - 跳转后返回栈（GoBack）
 *
 * 依赖：pdf-state.js, pdf-core.js
 * 挂载：window.BKPdf._internal.links
 */
(function (win) {
  'use strict';

  var doc = win.document;
  var S = win.BKPdf._internal.state;

  // XSS 防护：仅允许安全 scheme
  var SAFE_LINK_SCHEMES = /^(https?:|mailto:|tel:)/i;
  var PDF_LINK_TARGET = { NONE: 0, SELF: 1, BLANK: 2, PARENT: 3, TOP: 4 };
  var PDF_DEFAULT_LINK_REL = 'noopener noreferrer nofollow';

  /**
   * LinkService：实现 pdf.js ILinkService 接口
   * 处理内部跳转 + 外部链接
   */
  var _linkService = {
    externalLinkTarget: PDF_LINK_TARGET.BLANK,
    externalLinkRel: PDF_DEFAULT_LINK_REL,
    externalLinkEnabled: true,

    addLinkAttributes: function (link, url, newWindow) {
      if (!url || typeof url !== 'string') {
        throw new Error('A valid "url" parameter must provided.');
      }
      var isSafeUrl = SAFE_LINK_SCHEMES.test(url);
      var target = newWindow ? PDF_LINK_TARGET.BLANK : this.externalLinkTarget;
      if (this.externalLinkEnabled && isSafeUrl) {
        link.href = link.title = url;
      } else {
        link.href = '';
        link.title = isSafeUrl ? ('Disabled: ' + url) : 'Blocked: unsafe URL scheme';
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

    /**
     * 内部跳转：解析目的地并跳转
     * @param {string|Array} dest - 命名目的地字符串或 [ref, ...] 数组
     */
    goToDestination: function (dest) {
      if (!dest) return Promise.resolve();
      var bookId = S.currentBookId();
      var nav = win.BKPdf._internal.nav;

      // 记录返回栈（跳转前位置）
      _pushBackStack(bookId, S.currentPage());

      var lib = win.pdfjsLib;
      if (!lib || !bookId) return Promise.resolve();

      var pdfDocP = win.BKPdf._internal.core.getPdfDoc(bookId);
      return pdfDocP.then(function (pdf) {
        if (typeof dest === 'string') {
          // 命名目的地：先通过 getDestination 解析为 ref 数组
          return pdf.getDestination(dest).then(function (explicitDest) {
            if (!explicitDest) {
              console.warn('[PDF] 未找到目的地:', dest);
              return;
            }
            _goToExplicitDestination(explicitDest, pdf);
          });
        } else if (Array.isArray(dest)) {
          // 显式目的地数组
          _goToExplicitDestination(dest, pdf);
        }
      }).catch(function (err) {
        console.warn('[PDF] goToDestination 失败:', err);
      });
    },

    /**
     * 跳转到指定页（1-based）
     * @param {number|string} val - 页码或页码标签
     */
    goToPage: function (val) {
      if (!val) return;
      var pageNum;
      if (typeof val === 'number') {
        pageNum = val;
      } else if (typeof val === 'string') {
        // 尝试解析页码标签
        pageNum = parseInt(val, 10);
        if (isNaN(pageNum)) {
          // 可能是页码标签（如 "iv"），尝试通过 pageIndexToNumber 查找
          var labels = S.pageLabels();
          if (labels) {
            for (var i = 0; i < labels.length; i++) {
              if (labels[i] === val) { pageNum = i + 1; break; }
            }
          }
        }
      }
      if (pageNum && pageNum > 0) {
        var bookId = S.currentBookId();
        _pushBackStack(bookId, S.currentPage());
        var nav = win.BKPdf._internal.nav;
        if (nav && nav.goToPage) nav.goToPage(pageNum, true);
      }
    },

    setHash: function (hash) {
      // 解析 hash 跳转（如 #page=5）
      if (!hash) return;
      var match = /page=(\d+)/.exec(hash);
      if (match) {
        this.goToPage(parseInt(match[1], 10));
      }
    },

    /**
     * 执行命名动作
     */
    executeNamedAction: function (action) {
      var nav = win.BKPdf._internal.nav;
      if (!nav) return;
      switch (action) {
        case 'FirstPage':
          if (nav.goToFirst) nav.goToFirst();
          break;
        case 'LastPage':
          if (nav.goToLast) nav.goToLast();
          break;
        case 'NextPage':
          if (nav.goToNext) nav.goToNext();
          break;
        case 'PrevPage':
          if (nav.goToPrev) nav.goToPrev();
          break;
        default:
          console.log('[PDF] 未处理的 NamedAction:', action);
      }
    },

    executeSetOCGState: function (action) { /* no-op */ }
  };

  /**
   * 解析显式目的地数组并跳转
   * @param {Array} explicitDest - [ref, {name}|number, ...] 格式
   * @param {PDFDocument} pdf - PDF 文档对象
   */
  function _goToExplicitDestination(explicitDest, pdf) {
    if (!explicitDest || !explicitDest.length) return;
    var ref = explicitDest[0];
    if (!ref) return;

    var nav = win.BKPdf._internal.nav;
    if (!nav || !nav.goToPage) return;

    // ref 可能是页码对象 {num, gen} 或数字
    if (typeof ref === 'object' && ref !== null) {
      // 通过 ref 获取页码
      pdf.getPageIndex(ref).then(function (pageIndex) {
        var pageNum = pageIndex + 1; // 0-based → 1-based
        nav.goToPage(pageNum, true);
      }).catch(function (err) {
        console.warn('[PDF] 无法解析页面引用:', err);
      });
    } else if (typeof ref === 'number') {
      // 直接是页面索引（0-based in pdf.js spec, but some PDFs use 1-based）
      var pageNum = ref > 0 ? ref : ref + 1;
      nav.goToPage(pageNum, true);
    }
  }

  // ==================== 跳转后返回栈（GoBack）====================

  /**
   * 压入返回栈
   */
  function _pushBackStack(bookId, page) {
    S.backStack().push({ bookId: bookId, page: page, time: Date.now() });
    // 限制栈深度，防止内存泄漏
    if (S.backStack().length > 20) {
      S.backStack().shift();
    }
  }

  /**
   * 返回上一位置
   */
  function goBack() {
    var stack = S.backStack();
    if (!stack.length) return false;
    var last = stack.pop();
    if (!last || !last.page) return false;
    var nav = win.BKPdf._internal.nav;
    if (nav && nav.goToPage) {
      nav.goToPage(last.page, false);
      return true;
    }
    return false;
  }

  /**
   * 是否能返回
   */
  function canGoBack() {
    return S.backStack().length > 0;
  }

  // ==================== init / cleanup ====================

  function init(containerEl, bookId) {
    // LinkService 在渲染注解层时被 core 模块调用，无需额外初始化
    // 返回栈在跳转时自动记录
  }

  function cleanup() {
    // 清空返回栈
    S.backStack().length = 0;
  }

  // ==================== 导出 ====================

  win.BKPdf._internal.links = {
    init: init,
    cleanup: cleanup,
    getLinkService: function () { return _linkService; },
    goBack: goBack,
    canGoBack: canGoBack
  };

})(window);
