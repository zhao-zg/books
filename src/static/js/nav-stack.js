(function() {
    'use strict';

    var _loadedAt = Date.now();
    var _GRACE_MS = 500;

    function isCapacitor() {
        return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    }

    function isPWA() {
        return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    }

    function handleBackCommon(targetHandler) {
        if (window.__bkHandlingBack || window.__bkExiting) {
            return;
        }
        window.__bkHandlingBack = true;
        try {
            targetHandler();
        } finally {
            setTimeout(function() {
                window.__bkHandlingBack = false;
            }, 50);
        }
    }

    function setupBackHandler(handleBack) {
        if (!isCapacitor() && !isPWA()) return;

        if (isCapacitor()) {
            window.Capacitor.Plugins.App.addListener('backButton', function() {
                if (window.BK && window.BK.backStack && window.BK.backStack.size() > 0) {
                    try { history.back(); } catch(e) {}
                    return;
                }
                handleBackCommon(handleBack);
            });
        } else if (isPWA()) {
            if (window.BK && window.BK.backStack) {
                window.BK.backStack.setFallback(function() {
                    if (window.__bkExiting) return;
                    if (Date.now() - _loadedAt < _GRACE_MS) return;
                    console.log('[NavStack] fallback hash="' + window.location.hash + '" backStackSize=' + window.BK.backStack.size());
                    handleBackCommon(handleBack);
                });
            }
        }
    }

    function initContentPage() {
        setupBackHandler(function() {
            window.location.replace('./index.html');
        });
    }

    function initDirectoryPage() {
        setupBackHandler(function() {
            window.location.replace('../index.html');
        });
    }

    // 主页回退
    function initHomePage() {
        if (isCapacitor()) {
            window.Capacitor.Plugins.App.addListener('backButton', function() {
                if (window.BK && window.BK.backStack && window.BK.backStack.size() > 0) {
                    try { history.back(); } catch(e) {}
                    return;
                }
                handleBackCommon(function() {
                    var path = (typeof window.__bkCurrentPath === 'string')
                        ? window.__bkCurrentPath
                        : window.location.hash.replace(/^#\/?/, '');
                    var parts = path.split('/').filter(Boolean);
                    console.log('[NavStack] Capacitor backButton path="' + path + '" parts=' + JSON.stringify(parts));
                    if (parts.length >= 2) {
                        // 阅读视图 → 章节目录
                        if (window.BKRouter) { window.BKRouter.navigateReplace(parts[0]); return; }
                    } else if (parts.length >= 1) {
                        // 章节目录 → 主页
                        if (window.BKRouter) { window.BKRouter.navigateReplace(''); return; }
                    } else {
                        // 主页内部：检查系列/分类视图层级
                        if (window.BKRenderer && window.BKRenderer.goBackInHome && window.BKRenderer.goBackInHome()) { return; }
                    }
                    window.Capacitor.Plugins.App.exitApp();
                });
            });
        } else if (isPWA()) {
            if (window.BK && window.BK.backStack) {
                window.BK.backStack.setFallback(function() {
                    if (window.__bkExiting) return;
                    if (Date.now() - _loadedAt < _GRACE_MS) return;
                    var path = (typeof window.__bkCurrentPath === 'string')
                        ? window.__bkCurrentPath
                        : window.location.hash.replace(/^#\/?/, '');
                    var parts = path.split('/').filter(Boolean);
                    console.log('[NavStack] PWA fallback from="' + path + '" parts=' + JSON.stringify(parts));

                    handleBackCommon(function() {
                        if (parts.length >= 2) {
                            if (window.BKRouter) { window.BKRouter.navigateReplace(parts[0]); return; }
                        } else if (parts.length >= 1) {
                            if (window.BKRouter) { window.BKRouter.navigateReplace(''); return; }
                        } else {
                            // 主页内部：检查系列/分类视图层级
                            if (window.BKRenderer && window.BKRenderer.goBackInHome && window.BKRenderer.goBackInHome()) { return; }
                        }
                        window.__bkExiting = true;
                        window.close();
                        setTimeout(function() {
                            window.history.back();
                            setTimeout(function() { window.__bkExiting = false; }, 400);
                        }, 150);
                    });
                });
            }
        }
    }

    window.BKNavStack = {
        initContentPage: initContentPage,
        initDirectoryPage: initDirectoryPage,
        initHomePage: initHomePage
    };
})();

// ——— 浮动导航栏 ———
(function() {
    'use strict';

    var _el = null;
    var _ttsEl = null;
    var _timer = null;
    var HIDE_DELAY = 5000;
    var _ttsSyncCleanup = null;

    function getPageNav() {
        return document.querySelector('.page-navigation');
    }

    function isPageNavVisible() {
        // 底部栏始终固定可见，浮动导航不需要检测可见性
        return false;
    }

    function ensureEl() {
        if (!_el) {
            _el = document.createElement('div');
            _el.className = 'bk-float-nav';
            _el.setAttribute('aria-label', '快捷导航');
            document.body.appendChild(_el);

            _el.addEventListener('click', function(e) {
                e.stopPropagation();
                var t = e.target;
                while (t && t !== _el) {
                    if (t.classList && t.classList.contains('bk-float-nav-link')) {
                        hide(); return;
                    }
                    t = t.parentElement;
                }
                hide();
            });
        }
        return _el;
    }

    function syncContent() {
        var el = ensureEl();
        // 从当前 hash 解析 bookId 和 chapterNum
        var hash = window.location.hash || '';
        var m = hash.match(/^#\/([^\/]+)\/(\d+)/);
        if (!m) return false;
        var bookId = m[1];
        var chapterNum = parseInt(m[2], 10);

        // 获取章节列表（从 DOM 或路由缓存）
        var chapters = [];
        try {
            var tocBody = document.getElementById('bkTocDrawerBody');
            if (tocBody) {
                var items = tocBody.querySelectorAll('.bk-toc-chapter-item');
                for (var i = 0; i < items.length; i++) {
                    var href = items[i].getAttribute('href') || '';
                    var cm = href.match(/\/(\d+)$/);
                    if (cm) chapters.push(parseInt(cm[1], 10));
                }
            }
        } catch(e) {}

        // 如果没从 drawer 获取到，尝试从路由状态获取
        if (chapters.length === 0 && window.BKRenderer && window.BKRenderer._getUniqueChapters) {
            chapters = window.BKRenderer._getUniqueChapters();
        }

        var prevNum = null, nextNum = null;
        for (var j = 0; j < chapters.length; j++) {
            if (chapters[j] === chapterNum) {
                if (j > 0) prevNum = chapters[j - 1];
                if (j < chapters.length - 1) nextNum = chapters[j + 1];
                break;
            }
        }

        var html = '<div class="bk-float-nav-inner">';
        // 返回书架
        html += '<a class="bk-float-nav-link" href="#/" title="书架"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></a>';
        // 上一章
        if (prevNum) {
            html += '<a class="bk-float-nav-link" href="#/' + bookId + '/' + prevNum + '" title="上一章"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></a>';
        } else {
            html += '<span class="bk-float-nav-link bk-float-disabled"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></span>';
        }
        // 下一章
        if (nextNum) {
            html += '<a class="bk-float-nav-link" href="#/' + bookId + '/' + nextNum + '" title="下一章"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></a>';
        } else {
            html += '<span class="bk-float-nav-link bk-float-disabled"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>';
        }
        html += '</div>';

        el.innerHTML = html;
        return true;
    }

    function getTtsBar() {
        var bar = document.getElementById('bottomControlBar');
        return (bar && bar.style.display !== 'none') ? bar : null;
    }

    function ensureTtsEl() {
        if (!_ttsEl) {
            _ttsEl = document.createElement('div');
            _ttsEl.className = 'bk-float-tts-bar';
            _ttsEl.setAttribute('aria-label', '朗读控制');
            document.body.appendChild(_ttsEl);
            _ttsEl.addEventListener('click', function(e) { e.stopPropagation(); });
        }
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
        if (origProgress && cloneProgress) {
            observers.push(new MutationObserver(function() {
                if (!isSeekingClone) cloneProgress.value = origProgress.value;
            }));
            observers[observers.length - 1].observe(origProgress, { attributes: true, attributeFilter: ['value'] });
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
            }));
            observers[ppIdx].observe(origPlayPause, { childList: true, subtree: true });
        }
        _ttsSyncCleanup = function() {
            for (var j = 0; j < observers.length; j++) observers[j].disconnect();
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

        el.innerHTML = '';
        el.appendChild(cloned);
        return true;
    }

    function show() {
        if (!syncContent()) return;
        ensureEl().classList.add('show');
        clearTimeout(_timer);
        _timer = setTimeout(hide, HIDE_DELAY);
        syncTtsContent();
        if (_ttsEl) {
            _ttsEl.classList.add('show');
        }
    }

    function hide() {
        clearTimeout(_timer);
        if (_el) _el.classList.remove('show');
        if (_ttsEl) _ttsEl.classList.remove('show');
        if (_ttsSyncCleanup) { _ttsSyncCleanup(); _ttsSyncCleanup = null; }
    }

    window.addEventListener('scroll', function() {
        if (_el && _el.classList.contains('show') && isPageNavVisible()) {
            hide();
        }
    }, { passive: true });

    window.addEventListener('hashchange', function() {
        hide();
        if (_el && _el.parentNode) _el.parentNode.removeChild(_el);
        _el = null;
        if (_ttsEl && _ttsEl.parentNode) _ttsEl.parentNode.removeChild(_ttsEl);
        _ttsEl = null;
    });

    function isEmptyAreaClick(e) {
        var el = e.target;
        while (el && el !== document.body) {
            if (el.classList && (el.classList.contains('bk-float-nav') || el.classList.contains('bk-float-tts-bar'))) return false;
            if (el.classList && el.classList.contains('bk-dialog-mask')) return false;
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'a' || tag === 'button' || tag === 'input' ||
                tag === 'select' || tag === 'textarea' || tag === 'label') return false;
            if (el.getAttribute && el.getAttribute('onclick')) return false;
            if (el.classList) {
                var cls = el.classList;
                if (cls.contains('speech-btn')          || cls.contains('play-btn') ||
                    cls.contains('highlight-trigger')   || cls.contains('bk-dialog-mask') ||
                    cls.contains('theme-panel')         || cls.contains('theme-toggle-btn') ||
                    cls.contains('toc-item')            ||
                    cls.contains('bk-highlight')        || cls.contains('bk-note-icon') ||
                    cls.contains('bk-bottom-bar')       || cls.contains('bk-bottom-btn') ||
                    cls.contains('bk-tts-panel')) return false;
            }
            el = el.parentElement;
        }
        return true;
    }

    function isContentPage() {
        return /^#\/[^\/]+\/\d+/.test(window.location.hash);
    }

    document.addEventListener('click', function(e) {
        if (_el && _el.classList.contains('show')) {
            hide();
            return;
        }
        if (isContentPage() && !isPageNavVisible() && isEmptyAreaClick(e)) {
            show();
        }
    }, false);
})();
