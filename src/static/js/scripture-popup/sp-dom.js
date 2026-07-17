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

    header.appendChild(backBtn);
    header.appendChild(title);
    header.appendChild(closeBtn);

    var body = document.createElement('div');
    body.className = 'scripture-popup-body';
    body.id = 'scripture-popup-body';

    box.appendChild(header);
    box.appendChild(body);

    /* 底部操作栏：复制 / 分享到笔记（Soft Nordic 抽屉风格） */
    var actions = document.createElement('div');
    actions.className = 'scripture-popup-actions';

    var copyBtn = document.createElement('button');
    copyBtn.className = 'bk-btn bk-btn-secondary';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', function () {
      var txt = body.innerText || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).catch(function () {});
      }
    });

    var shareBtn = document.createElement('button');
    shareBtn.className = 'bk-btn bk-btn-primary';
    shareBtn.textContent = '分享到笔记';
    shareBtn.addEventListener('click', function () {
      var txt = body.innerText || '';
      if (window.BKBookmark && window.BKBookmark.add) {
        /* 将经文内容保存为当前页书签的笔记 */
        var path = window.__bkCurrentPath || '';
        var scrollY = window.scrollY || 0;
        var parts = path.split('/').filter(Boolean);
        window.BKBookmark.add({
          path: path,
          scrollY: scrollY,
          title: '经文笔记',
          bookId: parts[0] || '',
          chapterNum: parseInt(parts[1], 10) || 0,
          note: txt
        });
        /* 提示用户已保存 */
        if (window.BK && window.BK.toast) {
          window.BK.toast('已保存到笔记');
        }
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).catch(function () {});
      }
    });

    actions.appendChild(copyBtn);
    actions.appendChild(shareBtn);
    box.appendChild(actions);

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

