  /* ═══════════════════════════ 弹框开关 ═══════════════════════════ */
  function openModal(refs, labelText) {
    var m = getModal();
    navStack = [];
    m.overlay.classList.add('scripture-popup-overlay--open');
    m.overlay.setAttribute('aria-hidden', 'false');
    navPush({ type: 'verses', refs: refs, label: labelText || refs.replace(/,/g,'、') });
    /* navPush 内部已调用 backStack.push，无需再次 push */
  }

  function closeModal() {
    if (!modal) return;
    /* 有几层就弹几次，清空对应的 history 记录 */
    var n = navStack.length;
    navStack = [];
    modal.overlay.classList.remove('scripture-popup-overlay--open');
    modal.overlay.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < n; i++) window.BK.backStack.pop();
  }

  /* ── ESC 关闭 ── */
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Escape' || e.keyCode === 27) && modal && modal.overlay.classList.contains('scripture-popup-overlay--open')) {
      closeModal();
    }
  });

  /* ── 平板：点击扩展框外区域关闭 ── */
  document.addEventListener('click', function (e) {
    if (window.innerWidth < 600) return;
    if (!modal || !modal.overlay.classList.contains('scripture-popup-overlay--open')) return;
    /* 点击在弹框本体内 → 不关闭 */
    if (modal.overlay.contains(e.target)) return;
    /* 点击的是经文引用类元素 → 不关闭（由事件委托接管打开新帧） */
    var t = e.target;
    while (t && t !== document) {
      if (t.classList && (
        (t.classList.contains('scripture-ref') && t.dataset && t.dataset.refs) ||
        t.classList.contains('fn-ref') ||
        t.classList.contains('xref-ref')
      )) return;
      t = t.parentNode;
    }
    /* 平板不锁滚动，history.back() 会异步恢复滚动位置，提前保存并还原 */
    var savedScrollY = window.scrollY;
    closeModal();
    /* history.back() 是异步的，用 popstate 之后恢复最可靠 */
    window.addEventListener('popstate', function restoreScroll() {
      window.removeEventListener('popstate', restoreScroll);
      /* 再等一帧，确保浏览器滚动恢复已执行完毕 */
      requestAnimationFrame(function () {
        window.scrollTo(0, savedScrollY);
      });
    }, { once: true });
  }, true); /* capture 保证在事件委托之前执行 */

  /* ═══════════════════════════ 事件委托 ═══════════════════════════ */
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document) {
      /* fn-ref（注脚号）—— 必须在 scripture-ref 之前检查，
       * 因为 ref-detector 生成的 fn-ref span 同时具有 scripture-ref 和 fn-ref 两个 class */
      if (t.classList && t.classList.contains('fn-ref') && t.dataset && t.dataset.vkey) {
        e.preventDefault(); e.stopPropagation();
        ensureOpen();
        navPush({ type: 'footnote', verseKey: t.dataset.vkey, num: t.dataset.fn });
        return;
      }
      /* xref-ref（串珠号）—— 同理，优先于 scripture-ref */
      if (t.classList && t.classList.contains('xref-ref') && t.dataset && t.dataset.vkey) {
        e.preventDefault(); e.stopPropagation();
        ensureOpen();
        navPush({ type: 'xrefs', verseKey: t.dataset.vkey, letter: t.dataset.xr });
        return;
      }
      /* .scripture-ref[data-refs] → 打开弹框，或若已在弹框内则 navPush 导航 */
      if (t.classList && t.classList.contains('scripture-ref') && t.dataset && t.dataset.refs) {
        e.preventDefault(); e.stopPropagation();
        var overlay = document.getElementById('scripture-popup-overlay');
        var insidePopup = overlay && overlay.contains(t);
        if (insidePopup) {
          navPush({ type: 'verses', refs: t.dataset.refs, label: t.textContent.trim() });
        } else {
          openModal(t.dataset.refs, t.textContent.replace(/^[—─\*\s]+/,'').trim());
        }
        return;
      }
      /* verse-ref（注解内经文引用）*/
      if (t.classList && t.classList.contains('verse-ref') && t.dataset && t.dataset.refs) {
        e.preventDefault(); e.stopPropagation();
        navPush({ type: 'verses', refs: t.dataset.refs, label: t.textContent });
        return;
      }
      t = t.parentNode;
    }
  });

