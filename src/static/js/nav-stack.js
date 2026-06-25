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
                        if (window.BKRouter) { window.BKRouter.navigate(parts[0]); return; }
                    } else if (parts.length >= 1) {
                        // 章节目录 → 主页
                        if (window.BKRouter) { window.BKRouter.navigate(''); return; }
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
        var nav = getPageNav();
        if (!nav) return true;
        return nav.getBoundingClientRect().bottom > 0;
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
                    if (t.classList && t.classList.contains('nav-link')) {
                        hide(); return;
                    }
                    if (t.classList && t.classList.contains('bk-float-nav-settings')) {
                        return;
                    }
                    t = t.parentElement;
                }
                hide();
            });
        }
        return _el;
    }

    function syncContent() {
        var pageNav = getPageNav();
        if (!pageNav) return false;
        var el = ensureEl();

        var cloned = pageNav.cloneNode(true);
        var withId = cloned.querySelectorAll('[id]');
        for (var i = 0; i < withId.length; i++) {
            withId[i].removeAttribute('id');
        }

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bk-float-nav-settings';
        btn.title = '设置';
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6M1 12h6m6 0h6"/><path d="M4.2 4.2l4.3 4.3m5.5 5.5l4.3 4.3M4.2 19.8l4.3-4.3m5.5-5.5l4.3-4.3"/></svg>';
        btn.onclick = function(e) {
            e.stopPropagation();
            hide();
            if (window.toggleThemePanel) window.toggleThemePanel();
        };

        el.innerHTML = '';
        el.appendChild(cloned);
        el.appendChild(btn);
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
                    cls.contains('bk-highlight')        || cls.contains('bk-note-icon')) return false;
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
