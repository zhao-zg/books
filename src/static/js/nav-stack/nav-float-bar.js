
// ——— 浮动导航栏（顶栏 + 底栏） ———
(function() {
    'use strict';

    var _el = null;         // 顶部浮动导航
    var _bottomEl = null;   // 底部浮动栏
    var _ttsEl = null;
    var _timer = null;
    var HIDE_DELAY = 7000;
    var _ttsSyncCleanup = null;
    var _ttsBarVisible = false;   // 浮动朗读栏当前是否显示
    var _ttsActive = false;       // 朗读栏是否已激活（用户开启过朗读，需随底栏出现）

    // 检测当前页面类型：reading | catalog | null
    // 注意：仅书籍阅读 / 章节目录页才返回非 null；App 顶层页（书架/书城/我的/书签/设置）
    // 以及 #/series/<id> 系列列表页都有自身的顶栏与底栏，不应显示阅读浮动导航。
    var _APP_ROUTES = ['shelf', 'city', 'my', 'me', 'bookmarks'];

    function getPageType() {
        var hash = window.location.hash || '';
        var m = hash.match(/^#\/([^\/]+)(?:\/([^\/]+))?/);
        if (!m) return null;
        var seg0 = m[1];
        var seg1 = m[2];

        // #/series/<id> 是书城系列书籍列表，不是阅读视图
        if (seg0 === 'series') return null;

        // 两段路由且第二段为纯数字 → 阅读视图
        if (seg1 != null && /^\d+$/.test(seg1)) return 'reading';

        // 单段路由：可能是书籍目录，也可能是 App 顶层页
        if (seg1 == null) {
            if (_APP_ROUTES.indexOf(seg0) !== -1) return null;
            return 'catalog';
        }
        return null;
    }

    // 判断是否为 PDF 书籍（PDF 走自带 outline 目录，禁用通用目录按钮）
    function _isPdfBook(bookId) {
        var books = window.__bkBooks || [];
        for (var i = 0; i < books.length; i++) {
            var b = books[i];
            if (b && (b.id === bookId || b.bookId === bookId)) {
                return b.format === 'pdf';
            }
        }
        return false;
    }

    // ── 顶部浮动栏 ──────────────────────────────────────────

    function ensureEl() {
        if (!_el) {
            _el = document.createElement('div');
            _el.className = 'bk-float-nav';
            _el.setAttribute('aria-label', '阅读顶栏');
            document.body.appendChild(_el);

            _el.addEventListener('click', function(e) {
                e.stopPropagation();
                var t = e.target;
                while (t && t !== _el) {
                    if (t.classList && t.classList.contains('bk-float-nav-link')) {
                        // ★ 通过 BKRouter.navigate() 导航（而非原生 href），
                        //   确保 __bkForwardNavPending 标记被正确设置
                        var navPath = t.getAttribute('data-nav');
                        if (navPath != null && window.BKRouter) {
                            e.preventDefault();
                            window.BKRouter.navigate(navPath);
                        }
                        hide(); return;
                    }
                    t = t.parentElement;
                }
                // 仅返回链接关闭顶栏；点书名区等其余区域为空操作（不再误关栏）
            });
        }
        return _el;
    }

    function syncContent() {
        var el = ensureEl();
        var hash = window.location.hash || '';
        var pageType = getPageType();
        if (!pageType) return false;

        var m = hash.match(/^#\/([^\/]+)(?:\/(\d+))?/);
        if (!m) return false;
        // ★ decode URL 编码的中文 bookId（location.hash 可能保留 % 编码）
        var bookId = m[1];
        try { bookId = decodeURIComponent(bookId); } catch (e) {}
        // PDF 走自带工具栏，阅读页不显示软件浮栏（顶栏 + 底栏）
        if (pageType === 'reading' && _isPdfBook(bookId)) return false;
        var chapterNum = m[2] ? parseInt(m[2], 10) : null;

        // 获取书名
        var bookTitle = '';
        if (pageType === 'reading') {
            // 阅读页：从 BKRenderer 缓存读取（renderReadingView 渲染时设置）
            bookTitle = (window.BKRenderer && window.BKRenderer._currentBookTitle) || '';
        } else {
            // 目录页：从 DOM 或 BKRenderer 获取
            var titleEl = document.querySelector('.bk-cl-header-title, .bk-book-header-title');
            if (titleEl) bookTitle = titleEl.textContent || '';
            if (!bookTitle && window.BKRenderer && window.BKRenderer._getBookTitle) {
                bookTitle = window.BKRenderer._getBookTitle(bookId) || '';
            }
        }

        var html = '<div class="bk-float-nav-inner">';

        if (pageType === 'reading') {
            // 返回书架
            // ★ 不用 href="#/" 原生导航——绕过 BKRouter.navigate() 导致 PWA 闪回
            html += '<a class="bk-float-nav-link" data-nav="" title="书架"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></a>';

            // 书名 - 章节（从 BKRenderer 缓存读取章节标题）
            var chapterTitle = (window.BKRenderer && window.BKRenderer._currentChapterTitle) || '';
            var displayTitle = bookTitle + (chapterTitle ? ' - ' + chapterTitle : (chapterNum ? ' - 第' + chapterNum + '章' : ''));
            html += '<div class="bk-float-title">' + (displayTitle || '') + '</div>';

        } else {
            // 目录页：返回 + 书名
            html += '<a class="bk-float-nav-link" data-nav="" title="书架"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></a>';
            html += '<div class="bk-float-title">' + (bookTitle || '') + '</div>';
        }

        html += '</div>';
        el.innerHTML = html;

        // 如果有底栏，同步底栏内容
        if (pageType === 'reading') {
            _syncBottomContent();
        }

        return true;
    }

    // ── 底部浮动栏 ──────────────────────────────────────────

    function ensureBottomEl() {
        if (!_bottomEl) {
            _bottomEl = document.createElement('div');
            _bottomEl.className = 'bk-float-bottom';
            _bottomEl.setAttribute('aria-label', '阅读工具');
            document.body.appendChild(_bottomEl);
            _bottomEl.addEventListener('click', function(e) { e.stopPropagation(); });
            _bindBottomEvents();
        }
        return _bottomEl;
    }

    function _syncBottomContent() {
        var el = ensureBottomEl();
        var hash = window.location.hash || '';
        var m = hash.match(/^#\/([^\/]+)(?:\/(\d+))?/);
        // ★ decode URL 编码的中文 bookId
        var bookId = m ? m[1] : '';
        try { bookId = decodeURIComponent(bookId); } catch (e) {}
        var html = '<div class="bk-float-bottom-inner">';

        // 目录（最左侧）
        html += '<button type="button" class="bk-float-bottom-btn" data-toc-drawer="1" data-book-id="' + bookId + '" title="目录"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>';

        // 书签
        html += '<button type="button" class="bk-float-bottom-btn" data-float-bookmark="1" title="书签"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/></svg></button>';

        // 朗读
        html += '<button type="button" class="bk-float-bottom-btn bk-float-bottom-tts-btn" data-tts-toggle="1" title="朗读"><svg class="bk-play-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg><svg class="bk-pause-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="display:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></button>';

        // 设置
        html += '<button type="button" class="bk-float-bottom-btn" data-float-settings="1" title="设置"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>';

        html += '</div>';
        el.innerHTML = html;
        // 重新挂载朗读栏（避免被 innerHTML 清空），朗读栏作为底栏子元素随其收起
        if (_ttsEl && _ttsEl.parentNode !== _bottomEl) _bottomEl.appendChild(_ttsEl);
    }

    function _bindBottomEvents() {
        if (!_bottomEl) return;
        _bottomEl.addEventListener('click', function(e) {
            var t = e.target;
            while (t && t !== _bottomEl) {
                // 目录按钮 → 打开统一标记面板（目录 Tab）；双栏模式下切换目录展开/折叠
                if (t.classList && t.classList.contains('bk-float-bottom-btn') && t.hasAttribute('data-toc-drawer')) {
                    if (document.body.classList.contains('bk-split-mode')) {
                        // 双栏模式：点击切换目录折叠/展开
                        document.dispatchEvent(new CustomEvent('bk:split-toc-toggle'));
                        return;
                    }
                    // 桥接到 MarkPanel 目录 Tab
                    e.preventDefault();
                    e.stopPropagation();
                    hide();
                    setTimeout(function () {
                        if (window.BK && window.BK.MarkPanel) {
                            window.BK.MarkPanel.open('toc');
                        }
                    }, 100);
                    return;
                }
                // 朗读按钮 → 切换朗读栏（不隐藏边栏，重置自动隐藏计时器）
                if (t.hasAttribute && t.hasAttribute('data-tts-toggle')) {
                    e.preventDefault();
                    _toggleTtsBar();
                    clearTimeout(_timer);
                    // 激活朗读栏：下边栏保持可见（绑定朗读栏，避免控件消失后无法播放）；
                    // 关闭朗读栏：恢复自动隐藏。
                    if (!_ttsBarVisible) {
                        _timer = setTimeout(hide, HIDE_DELAY);
                    }
                    return;
                }
                // 书签按钮 → 打开统一标记面板（默认书签 Tab）
                if (t.hasAttribute && t.hasAttribute('data-float-bookmark')) {
                    e.preventDefault();
                    if (window.BK && window.BK.MarkPanel) {
                        window.BK.MarkPanel.open('bookmark');
                    } else if (window.BKNoteSummary && window.BKNoteSummary.show) {
                        window.BKNoteSummary.show({ tab: 'bookmark', showAddBookmark: true });
                    } else if (window.BKBookmark && window.BKBookmark.showList) {
                        window.BKBookmark.showList();
                    }
                    return;
                }
                // 设置按钮
                if (t.hasAttribute && t.hasAttribute('data-float-settings')) {
                    e.preventDefault();
                    if (window.toggleThemePanel) window.toggleThemePanel();
                    hide();
                    return;
                }
                t = t.parentElement;
            }
        });
    }

    // ── TTS 朗读栏切换（底栏朗读按钮） ─────────────────────────

    function _toggleTtsBar() {
        _ttsBarVisible = !_ttsBarVisible;
        _ttsActive = _ttsBarVisible;

        if (_ttsBarVisible) {
            // 确保 TTS 已初始化
            // 注意：不再取消隐藏 #bottomControlBar —— 它是隐藏宿主(display:none)，
            // 仅供 speech.js 绑定事件；可见 UI 由 syncTtsContent() 克隆到 .bk-float-tts-bar。
            // 若设 display='' 会导致原始宿主栏在页面底部可见，与浮动克隆栏重叠。
            if (window.BKSpeech && window.BKSpeech.init) {
                window.BKSpeech.init({
                    getElements: function() {
                        var container = document.getElementById('chapterContent');
                        if (!container) return [];
                        var els = [];
                        var paragraphs = container.querySelectorAll('.bk-paragraph, .bk-quote-content, .bk-heading, .bk-code, li');
                        for (var pi = 0; pi < paragraphs.length; pi++) {
                            els.push({ el: paragraphs[pi] });
                        }
                        return els;
                    }
                });
            }
            // 注意：内嵌 #bkTtsPanel 已移除（设计稿 3:410 仅一个悬浮播放器）；
            // #bottomControlBar 保留为隐藏宿主供 speech.js 绑定

            // 显示浮动 TTS 栏（作为底栏子元素，随底栏定位/收起）
            syncTtsContent();
            if (_ttsEl) _ttsEl.classList.add('show');
        } else {
            // 隐藏浮动 TTS 栏
            if (_ttsEl) _ttsEl.classList.remove('show');
            _ttsBarVisible = false;
            // 停止克隆进度条轮询，避免悬挂的定时器持续写已分离的节点
            if (_ttsSyncCleanup) { _ttsSyncCleanup(); _ttsSyncCleanup = null; }

            // 收起嵌入式 TTS 控制栏
            var ttsPanel = document.getElementById('bottomControlBar');
            if (ttsPanel) {
                if (ttsPanel.style.display !== 'none') ttsPanel.style.display = 'none';
            }
        }
    }

    function _setFloatPlayState(isPlaying) {
        // 更新底栏朗读按钮图标状态
        if (_bottomEl) {
            var bottomBtn = _bottomEl.querySelector('.bk-float-bottom-tts-btn');
            if (bottomBtn) {
                if (isPlaying) {
                    bottomBtn.classList.add('bk-playing');
                } else {
                    bottomBtn.classList.remove('bk-playing');
                }
                var bPlayIcon = bottomBtn.querySelector('.bk-play-icon');
                var bPauseIcon = bottomBtn.querySelector('.bk-pause-icon');
                if (bPlayIcon) bPlayIcon.style.display = isPlaying ? 'none' : '';
                if (bPauseIcon) bPauseIcon.style.display = isPlaying ? '' : 'none';
            }
        }
    }

    // ── TTS 浮动条 ──────────────────────────────────────────

    function getTtsBar() {
        // 直接返回隐藏宿主栏，不检查 display 状态。
        // #bottomControlBar 始终保持 display:none（隐藏宿主），
        // 可见 UI 由 syncTtsContent() 克隆到 .bk-float-tts-bar 中。
        // 旧逻辑检查 display!=='none' 会导致 cancel() 隐藏后返回 null、克隆失败。
        return document.getElementById('bottomControlBar');
    }

    function ensureTtsEl() {
        ensureBottomEl();
        if (!_ttsEl) {
            _ttsEl = document.createElement('div');
            _ttsEl.className = 'bk-float-tts-bar';
            _ttsEl.setAttribute('aria-label', '朗读控制');
            _ttsEl.addEventListener('click', function(e) { e.stopPropagation(); });
        }
        // 作为底栏子元素，朗读栏随底栏一起定位/收起，避免重叠与“收不回”问题
        if (_ttsEl.parentNode !== _bottomEl) _bottomEl.appendChild(_ttsEl);
        return _ttsEl;
    }


    function syncTtsContent() {
        var orig = getTtsBar();
        if (!orig) return false;
        var el = ensureTtsEl();

        var cloned = orig.cloneNode(true);
        var withId = cloned.querySelectorAll('[id]');
        for (var i = 0; i < withId.length; i++) withId[i].removeAttribute('id');

        if (_ttsSyncCleanup) { _ttsSyncCleanup(); _ttsSyncCleanup = null; }

        var origProgress  = document.getElementById('progressBar');
        var origTime      = document.getElementById('speechTime');
        var origRate      = document.getElementById('rateSelect');
        var origPlayPause = document.getElementById('playPauseBtn');
        var cloneProgress  = cloned.querySelector('.progress-bar');
        var cloneTime      = cloned.querySelector('.speech-time');
        var cloneRate      = cloned.querySelector('.control-select');
        var cloneBtns      = cloned.querySelectorAll('.control-btn');
        var isSeekingClone = false;

        var observers = [];
        var intervals = [];
        if (origProgress && cloneProgress) {
          // 修复：input[type=range] 的 .value 属性赋值不会触发 attribute 变更，
          // 原 MutationObserver 捕获不到 → 改用轮询把原进度条的值同步到可见克隆，否则进度条不动
          // 同时同步 style.background（进度填充渐变色）
          var progPoll = setInterval(function () {
            if (!isSeekingClone) {
              cloneProgress.value = origProgress.value;
              cloneProgress.style.background = origProgress.style.background;
            }
          }, 200);
          intervals.push(progPoll);
        }
        if (origTime && cloneTime) {
            var timeIdx = observers.length;
            observers.push(new MutationObserver(function() {
                cloneTime.textContent = origTime.textContent;
            }));
            observers[timeIdx].observe(origTime, { childList: true, characterData: true, subtree: true });
        }
        if (origRate && cloneRate) {
            var rateIdx = observers.length;
            observers.push(new MutationObserver(function() {
                cloneRate.value = origRate.value;
            }));
            observers[rateIdx].observe(origRate, { attributes: true, attributeFilter: ['value'] });
        }
        if (origPlayPause) {
            var ppIdx = observers.length;
            observers.push(new MutationObserver(function() {
                var clonePP = cloned.querySelector('.play-pause-btn');
                if (clonePP) clonePP.innerHTML = origPlayPause.innerHTML;
                // 同步顶栏播放按钮状态
                var isPlaying = origPlayPause.classList.contains('bk-playing') ||
                    !!(document.querySelector('.bk-playing'));
                _setFloatPlayState(isPlaying);
            }));
            observers[ppIdx].observe(origPlayPause, { childList: true, subtree: true });
        }
        _ttsSyncCleanup = function() {
          for (var j = 0; j < observers.length; j++) observers[j].disconnect();
          for (var k = 0; k < intervals.length; k++) clearInterval(intervals[k]);
        };

        if (cloneProgress && origProgress) {
            cloneProgress.addEventListener('touchstart', function() {
                isSeekingClone = true;
                origProgress.dispatchEvent(new Event('touchstart'));
            });
            cloneProgress.addEventListener('mousedown', function() {
                isSeekingClone = true;
                origProgress.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            });
            cloneProgress.addEventListener('input', function() {
                origProgress.value = cloneProgress.value;
                origProgress.dispatchEvent(new Event('input', { bubbles: true }));
            });
            cloneProgress.addEventListener('change', function() {
                origProgress.value = cloneProgress.value;
                origProgress.dispatchEvent(new Event('change', { bubbles: true }));
            });
            cloneProgress.addEventListener('touchend', function() {
                origProgress.dispatchEvent(new Event('touchend'));
                isSeekingClone = false;
            });
            cloneProgress.addEventListener('mouseup', function() {
                origProgress.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                isSeekingClone = false;
            });
        }
        if (cloneRate && origRate) {
            cloneRate.addEventListener('change', function() {
                origRate.value = cloneRate.value;
                origRate.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }
        for (var b = 0; b < cloneBtns.length; b++) {
            (function(cloneBtn, idx) {
                cloneBtn.addEventListener('click', function() {
                    if (orig.querySelectorAll('.control-btn')[idx]) {
                        orig.querySelectorAll('.control-btn')[idx].click();
                    }
                });
            })(cloneBtns[b], b);
        }

        // 注入章节标题（设计稿 3:410 独立 TTS 播放器 UI）
        var titleEl = cloned.querySelector('.tts-title');
        if (!titleEl) {
            titleEl = document.createElement('div');
            titleEl.className = 'tts-title';
            var progSection = cloned.querySelector('.progress-section');
            if (progSection && progSection.parentNode) {
                progSection.parentNode.insertBefore(titleEl, progSection);
            } else {
                cloned.appendChild(titleEl);
            }
        }
        try {
            var curTitle = '';
            var chTitleEl = document.querySelector(
                '.bk-reading-page .bk-chapter-title, #chapterContent h1, #chapterContent h2, .reader-verse-title'
            );
            if (chTitleEl) curTitle = chTitleEl.textContent.trim();
            if (!curTitle && win.__bkCurrentPath) {
                var p = win.__bkCurrentPath.split('/');
                if (win.__bkBooks) {
                    for (var bi = 0; bi < win.__bkBooks.length; bi++) {
                        if (win.__bkBooks[bi].id === p[0]) { curTitle = win.__bkBooks[bi].title || ''; break; }
                    }
                }
                if (p[1]) curTitle += (curTitle ? ' · ' : '') + '第' + p[1] + '章';
            }
            titleEl.textContent = curTitle || '正在朗读…';
        } catch (e) {}

        el.innerHTML = '';
        el.appendChild(cloned);
        return true;
    }

    // ── 显示 / 隐藏 ─────────────────────────────────────────

    function show() {
        if (!syncContent()) return;
        ensureEl().classList.add('show');
        if (_bottomEl && getPageType() === 'reading') {
            _bottomEl.classList.add('show');
        }
        clearTimeout(_timer);
        // 朗读栏已激活时：底栏出现则朗读栏随之出现，并保持显示（不自动收起）；
        // 其余情况正常启动自动隐藏计时器。
        if (_ttsActive) {
            _ttsBarVisible = true;
            syncTtsContent();
            if (_ttsEl) _ttsEl.classList.add('show');
        }
        if (!_ttsBarVisible) {
            _timer = setTimeout(hide, HIDE_DELAY);
        }
    }

    function hide() {
        clearTimeout(_timer);
        if (_el) _el.classList.remove('show');
        if (_bottomEl) _bottomEl.classList.remove('show');
        // 朗读栏与下边栏状态绑定：下边栏隐藏时，朗读栏必须同步消失。
        // 同时收起浮动朗读栏克隆与页面内嵌的 TTS 控制面板，避免下边栏消失后朗读栏孤立残留。
        if (_ttsEl) _ttsEl.classList.remove('show');
        _ttsBarVisible = false;
        var ttsPanel = document.getElementById('bottomControlBar');
        if (ttsPanel) {
            if (ttsPanel.style.display !== 'none') ttsPanel.style.display = 'none';
        }
        if (_ttsSyncCleanup) { _ttsSyncCleanup(); _ttsSyncCleanup = null; }
    }

    // 立即隐藏（无滑出动画）：供系统/硬件返回键调用，避免顶栏残留到下一界面
    function hideNow() {
        if (_el) _el.style.transition = 'none';
        if (_bottomEl) _bottomEl.style.transition = 'none';
        if (_ttsEl) _ttsEl.style.transition = 'none';
        hide();
        // 一帧后恢复过渡，保证后续 show() 仍有滑入动画
        requestAnimationFrame(function() {
            requestAnimationFrame(function() {
                if (_el) _el.style.transition = '';
                if (_bottomEl) _bottomEl.style.transition = '';
                if (_ttsEl) _ttsEl.style.transition = '';
            });
        });
    }

    // 刷新顶栏内容（如 carousel 滑动切章后同步章名）；仅当顶栏正显示时
    function refresh() {
        if (!_el || !_el.classList.contains('show')) return;
        syncContent();
    }

    window.addEventListener('scroll', function() {
        if (_el && _el.classList.contains('show') && !_ttsBarVisible) {
            hide();
        }
    }, { passive: true });

    window.addEventListener('hashchange', function() {
        hide();
        _ttsBarVisible = false;
        _ttsActive = false;
        if (_el && _el.parentNode) _el.parentNode.removeChild(_el);
        _el = null;
        if (_bottomEl && _bottomEl.parentNode) _bottomEl.parentNode.removeChild(_bottomEl);
        _bottomEl = null;
        if (_ttsEl && _ttsEl.parentNode) _ttsEl.parentNode.removeChild(_ttsEl);
        _ttsEl = null;
    });

    function isEmptyAreaClick(e) {
        var el = e.target;
        while (el && el !== document.body) {
            if (el.classList && (
                el.classList.contains('bk-float-nav') ||
                el.classList.contains('bk-float-bottom') ||
                el.classList.contains('bk-float-tts-bar')
            )) return false;
            if (el.classList && el.classList.contains('bk-dialog-mask')) return false;
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'a' || tag === 'button' || tag === 'input' ||
                tag === 'select' || tag === 'textarea' || tag === 'label') return false;
            if (el.getAttribute && el.getAttribute('onclick')) return false;
            if (el.classList) {
                var cls = el.classList;
                if (cls.contains('speech-btn')          || cls.contains('play-btn') ||
                    cls.contains('highlight-trigger')   || cls.contains('bk-dialog-mask') ||
                    cls.contains('toc-item')            ||
                    cls.contains('bk-highlight')        || cls.contains('bk-note-icon') ||
                    cls.contains('scripture-ref')       || cls.contains('fn-ref') ||
                    cls.contains('xref-ref')            || cls.contains('verse-ref') ||
                    cls.contains('bk-epub-fn-ref')) return false;
            }
            el = el.parentElement;
        }
        return true;
    }

    document.addEventListener('click', function(e) {
        // 任一控制栏（顶栏或底栏）可见时，点击空白处即收起（含朗读栏已激活时）；
        // 朗读栏内控件点击已被 stopPropagation 拦截，不会收起。
        var controlsVisible = (_el && _el.classList.contains('show')) ||
                              (_bottomEl && _bottomEl.classList.contains('show'));
        if (controlsVisible) {
            // 安全检查：底栏和朗读栏内的点击已被 stopPropagation 拦截，这里双重保险；
            // 朗读栏内控件（进度条/倍速/播放等）点击不会收起，点页面空白处则收起全部。
            var el = e.target;
            while (el && el !== document.body) {
                if (el.classList && (el.classList.contains('bk-float-bottom') || el.classList.contains('bk-float-tts-bar'))) return;
                el = el.parentElement;
            }
            hide();
            return;
        }
        var pageType = getPageType();
        if (pageType && isEmptyAreaClick(e)) {
            show();
        }
    }, false);

    // 暴露给外部模块（renderer 滑动切章刷新标题、返回键立即隐藏顶栏）
    if (window.BKNavStack) {
        window.BKNavStack.hideNow = hideNow;
        window.BKNavStack.refresh = refresh;
    }
})();
