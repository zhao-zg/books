  /* ── 暴露给外部（可选）── */
  /* init()：由 renderer.js 的 setContent 在每次 SPA 切换后调用，
   * 重新对动态插入的经文块执行注解/串珠注入和行内引用标注。 */
  function init() {
    annotateInlineRefs();
    renderScriptureBlocks();
    renderScriptureStaticBlocks();
  }
  window.BKScripturePopup = { open: openModal, close: closeModal, init: init,
    // ★ 懒渲染块级入口：只标注指定容器（已渲染块），供 lazy-renderer 每批调用
    annotateBlock: annotateInlineRefs };

  /* ── 空闲预加载：页面加载后利用空闲时间提前解析三个大文件 ──
   * 文件已在 PWA/APK 缓存中，无网络开销；
   * 提前解析后用户首次点击经文时无需等待。
   * 按优先级依次加载：bible-text → bible-notes → bible-xrefs
   */
  function idleLoad(fn) {
    if (window.requestIdleCallback) {
      requestIdleCallback(fn, { timeout: 4000 });
    } else {
      setTimeout(fn, 3000);
    }
  }

  function schedulePreload() {
    idleLoad(function () {
      ensureBibleText(function () {
        idleLoad(function () {
          ensureBibleNotes(function () {
            idleLoad(function () {
              ensureBibleXrefs(function () {});
            });
          });
        });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedulePreload);
  } else {
    schedulePreload();
  }
