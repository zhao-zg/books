  /* ═══════════════════════════ DOM 结构 ═══════════════════════════ */
  function createModal() {
    var overlay = document.createElement('div');
    overlay.id = 'scripture-popup-overlay';
    overlay.className = 'scripture-popup-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    var box = document.createElement('div');
    box.className = 'scripture-popup';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    var header = document.createElement('div');
    header.className = 'scripture-popup-header';

    var backBtn = document.createElement('button');
    backBtn.className = 'scripture-popup-back';
    backBtn.setAttribute('aria-label', '返回');
    backBtn.innerHTML = '&#9664;';
    backBtn.style.display = 'none';
    backBtn.addEventListener('click', navBack);

    var title = document.createElement('span');
    title.className = 'scripture-popup-title';
    title.id = 'scripture-popup-title';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'scripture-popup-close';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.innerHTML = '&#10005;';
    closeBtn.addEventListener('click', closeModal);

    var copyBtn = document.createElement('button');
    copyBtn.className = 'scripture-popup-copy';
    copyBtn.setAttribute('aria-label', '复制');
    copyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copyBtn.addEventListener('click', function () {
      var txt = body.innerText || '';
      if (!txt) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () {
          if (win.BK && win.BK.toast) win.BK.toast('已复制');
        }).catch(function () {});
      }
    });

    header.appendChild(backBtn);
    header.appendChild(title);
    header.appendChild(copyBtn);
    header.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'scripture-popup-body';
    body.id = 'scripture-popup-body';

    box.appendChild(header);
    box.appendChild(body);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    /* 点遮罩空白：优先走 history.back()，让 backStack 决定行为（回退 navStack 层或关闭弹框） */
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { e.stopPropagation(); try { history.back(); } catch(e) {} }
    });

    /* 防滚动穿透 + 触摸点遮罩关闭（mobile touchend → history.back） */
    _spLockCleanup = window.BK.lockOverlayScroll(overlay, function() { try { history.back(); } catch(e) {} });

    return { overlay: overlay, title: title, body: body, backBtn: backBtn };
  }

  var _spLockCleanup = null;
  var modal = null;
  function getModal() {
    if (!modal) modal = createModal();
    return modal;
  }

  /* ═══════════════════════════ 导航栈 ═══════════════════════════ */
  var navStack = [];

  /* ── makeScriptureStep: 弹 1 层，每层 navPush 各自对应 1 条 backStack 记录 ── */
  function makeScriptureStep() {
    return function step() {
      if (navStack.length > 1) {
        /* 还有上层 → 回退一帧（本条 backStack 记录已消耗，不再 re-push）*/
        navStack.pop();
        renderFrame(navStack[navStack.length - 1]);
      } else {
        /* 最顶层 → 关闭弹框 */
        navStack = [];
        if (modal) {
          modal.overlay.classList.remove('scripture-popup-overlay--open');
          modal.overlay.setAttribute('aria-hidden', 'true');
        }
        if (_spLockCleanup) { _spLockCleanup(); _spLockCleanup = null; }
      }
    };
  }

  /* navPush: 每层都向 backStack 注册 1 条关闭回调 */
  function navPush(frame) {
    /* 保存当前帧的滚动位置，供返回时恢复 */
    if (navStack.length > 0 && modal) {
      navStack[navStack.length - 1]._scrollTop = modal.body.scrollTop;
    }
    navStack.push(frame);
    renderFrame(frame);
    window.BK.backStack.push(makeScriptureStep());
  }

  /* navBack（← 按钮）: 弹 1 层 + 同步消耗对应的 backStack 记录 */
  function navBack() {
    if (navStack.length <= 1) { closeModal(); return; }
    navStack.pop();
    renderFrame(navStack[navStack.length - 1]);
    window.BK.backStack.pop(); // 跳过 fn 回调，仅消耗 history
  }

