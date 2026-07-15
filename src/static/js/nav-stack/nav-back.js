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

    // 主页回退
    function initHomePage() {
        if (isCapacitor()) {
            window.Capacitor.Plugins.App.addListener('backButton', function() {
                // 阅读/目录页按返回键：立即隐藏浮动顶边栏，避免残留到下一界面
                if (window.BKNavStack && window.BKNavStack.hideNow) window.BKNavStack.hideNow();
                if (window.BK && window.BK.backStack && window.BK.backStack.size() > 0) {
                    try { history.back(); } catch(e) {}
                    return;
                }
                handleBackCommon(function() {
                    var path = (typeof window.__bkCurrentPath === 'string')
                        ? window.__bkCurrentPath
                        : window.location.hash.replace(/^#\/?/, '');
                    var parts = path.split('/').filter(Boolean);
                    // 主页内部路由：按返回键先尝试逐级回退（书城 L3→L2→L1），无法回退再 exitApp
                    var _HOME_SEGS = ['shelf', 'city', 'my', 'me', 'bookmarks'];
                    var isHomeRoute = parts.length <= 1 && (parts.length === 0 || _HOME_SEGS.indexOf(parts[0]) !== -1);
                    console.log('[NavStack] Capacitor backButton path="' + path + '" parts=' + JSON.stringify(parts) + ' isHomeRoute=' + isHomeRoute);
                    if (isHomeRoute) {
                        if (window.BKRenderer && window.BKRenderer.goBackInHome && window.BKRenderer.goBackInHome()) { return; }
                        window.Capacitor.Plugins.App.exitApp();
                        return;
                    }
                    if (parts.length >= 2) {
                        // 阅读视图 → 章节目录
                        if (window.BKRouter) { window.BKRouter.navigateReplace(parts[0]); return; }
                    } else if (parts.length >= 1) {
                        // 章节目录 → 主页
                        if (window.BKRouter) { window.BKRouter.navigateReplace(''); return; }
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
                        // 阅读/目录页按返回键（PWA）：立即隐藏浮动顶边栏（navigateReplace 不触发 hashchange，原 hide 不跑）
                        if (window.BKNavStack && window.BKNavStack.hideNow) window.BKNavStack.hideNow();
                        // 主页内部路由：按返回键先尝试逐级回退（书城 L3→L2→L1）
                        var _HOME_SEGS = ['shelf', 'city', 'my', 'me', 'bookmarks'];
                        var isHomeRoute = parts.length <= 1 && (parts.length === 0 || _HOME_SEGS.indexOf(parts[0]) !== -1);
                        if (isHomeRoute) {
                            if (window.BKRenderer && window.BKRenderer.goBackInHome && window.BKRenderer.goBackInHome()) { return; }
                            // 已在最外层主页
                        } else if (parts.length >= 2) {
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
        initHomePage: initHomePage
    };
})();
