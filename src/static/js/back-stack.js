/**
 * back-stack.js — 全局回退栈 + 对话框 + 滚动锁定
 *
 * 提供三个核心模块：
 *   window.BK.backStack        — 回退回调栈（导航回退时依次弹出）
 *   window.BK.openDialog(opts) — 通用对话框（遮罩 + 内容）
 *   window.BK.lockOverlayScroll(el, closeFn) — 锁定遮罩滚动
 *
 * 挂载：window.BK（确保 window.BK = window.BK || {}）
 */
(function (win) {
    'use strict';

    win.BK = win.BK || {};

    // ═══════════════════════════════════════════════════════════════════════
    //  1. 回退栈  BK.backStack
    // ═══════════════════════════════════════════════════════════════════════

    var _stack = [];
    var _fallback = null;
    var _skipNextPop = false;

    var BKBackStack = {
        /**
         * 压入一个回退回调
         * @param {Function} fn - 回退时执行的函数
         */
        push: function (fn) {
            if (typeof fn === 'function') {
                _stack.push(fn);
            }
        },

        /**
         * 弹出栈顶回调并执行
         */
        pop: function () {
            if (_skipNextPop) {
                _skipNextPop = false;
                return;
            }
            var fn = _stack.pop();
            if (fn) {
                try { fn(); } catch (e) {
                    console.error('[BackStack] pop callback error:', e);
                }
            } else if (_fallback) {
                try { _fallback(); } catch (e) {
                    console.error('[BackStack] fallback error:', e);
                }
            }
        },

        /**
         * 弹出栈顶回调但不执行（用于手动关闭后同步栈）
         */
        discard: function () {
            _stack.pop();
        },

        /**
         * 返回栈大小
         * @returns {number}
         */
        size: function () {
            return _stack.length;
        },

        /**
         * 标记跳过下一次 pop（用于 history.back 触发时的防重入）
         */
        skipNext: function () {
            _skipNextPop = true;
            // 安全复位：防止 skipNext 后永远没有 pop
            setTimeout(function () { _skipNextPop = false; }, 100);
        },

        /**
         * 设置栈为空时的兜底处理函数
         * @param {Function} fn
         */
        setFallback: function (fn) {
            _fallback = fn;
        }
    };

    win.BK.backStack = BKBackStack;

    // ═══════════════════════════════════════════════════════════════════════
    //  2. 通用对话框  BK.openDialog
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * 打开一个对话框
     * @param {Object} opts - { id: string, html: string, className: string, onClose: Function }
     * @returns {{ mask: HTMLElement, close: Function } | null}
     *   如果 id 对应的对话框已存在，返回 null
     */
    function openDialog(opts) {
        opts = opts || {};
        var id = opts.id || '';
        var html = opts.html || '';

        // 防重复：如果同 id 的遮罩已存在，返回 null
        if (id && document.getElementById(id)) {
            return null;
        }

        // 创建遮罩
        var mask = document.createElement('div');
        mask.className = opts.className || 'bk-dialog-mask';
        if (id) mask.id = id;
        mask.innerHTML = html;
        document.body.appendChild(mask);

        // 强制重排后显示动画
        void mask.offsetWidth;
        mask.classList.add('show');

        var _closed = false;

        function _destroy() {
            if (_closed) return;
            _closed = true;
            if (_cleanupScroll) _cleanupScroll();
            mask.classList.remove('show');
            setTimeout(function () {
                if (mask.parentNode) mask.parentNode.removeChild(mask);
            }, 220);
            if (opts.onClose) opts.onClose();
        }

        // 注册到 backStack（系统返回键关闭弹框）
        BKBackStack.push(function() { _destroy(); });

        // 主动关闭：销毁 DOM + 消耗 history 记录
        function close() {
            _destroy();
            BKBackStack.discard();  // 仅出栈，不调 history.back()
        }

        // lockOverlayScroll 统一处理防滚动穿透
        var _cleanupScroll = lockOverlayScroll(mask, function() { close(); });

        // 桌面/鼠标端：click 处理
        mask.addEventListener('click', function (e) {
            if (e.target === mask) {
                e.stopPropagation();
                close();
            }
        });

        return { mask: mask, close: close };
    }

    win.BK.openDialog = openDialog;

    // ═══════════════════════════════════════════════════════════════════════
    //  3. 滚动锁定  BK.lockOverlayScroll
    // ═══════════════════════════════════════════════════════════════════════

    var _scrollLockCount = 0;
    var _lockTimestamp = 0;
    // 安全超时：锁定超过 30 秒后，页面重新可见时自动释放
    var _SCROLL_LOCK_MAX_MS = 30000;

    function _lockBodyScroll() {
        _scrollLockCount++;
        if (_scrollLockCount === 1) {
            _lockTimestamp = Date.now();
            document.documentElement.classList.add('bk-scroll-locked');
            document.body.classList.add('bk-scroll-locked');
            // 确保样式存在
            if (!document.getElementById('bk-scroll-lock-style')) {
                var s = document.createElement('style');
                s.id = 'bk-scroll-lock-style';
                s.textContent = '.bk-scroll-locked{overflow:hidden!important;touch-action:none!important}';
                document.head.appendChild(s);
            }
        }
    }

    function _unlockBodyScroll() {
        _scrollLockCount = Math.max(0, _scrollLockCount - 1);
        if (_scrollLockCount === 0) {
            _lockTimestamp = 0;
            document.documentElement.classList.remove('bk-scroll-locked');
            document.body.classList.remove('bk-scroll-locked');
        }
    }

    // 暴露内部函数，供 theme-toggle.js 等统一使用同一计数器
    win.BK._lockBodyScroll = _lockBodyScroll;
    win.BK._unlockBodyScroll = _unlockBodyScroll;

    // 安全机制：页面重新可见时，若锁定已超时则强制释放
    function _safetyUnlock() {
        if (_scrollLockCount > 0 && _lockTimestamp &&
            (Date.now() - _lockTimestamp) > _SCROLL_LOCK_MAX_MS) {
            _scrollLockCount = 0;
            _lockTimestamp = 0;
            document.documentElement.classList.remove('bk-scroll-locked');
            document.body.classList.remove('bk-scroll-locked');
        }
    }

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
            _safetyUnlock();
        }
    });

    // 自愈机制：用户尝试触摸滚动时，若无可见遮罩则自动释放锁定
    document.addEventListener('touchstart', function () {
        if (_scrollLockCount > 0) {
            // 检查是否还有可见的 bk-dialog-mask 或 bk-modal-mask
            var masks = document.querySelectorAll('.bk-dialog-mask.show, .bk-modal-mask.show, .hl-modal-mask, .scripture-popup-mask');
            var hasVisibleMask = false;
            for (var i = 0; i < masks.length; i++) {
                if (masks[i].offsetParent !== null) {
                    hasVisibleMask = true;
                    break;
                }
            }
            if (!hasVisibleMask) {
                // 无可见遮罩但仍锁定 → 强制释放
                _scrollLockCount = 0;
                _lockTimestamp = 0;
                document.documentElement.classList.remove('bk-scroll-locked');
                document.body.classList.remove('bk-scroll-locked');
            }
        }
    }, { passive: true });

    /**
     * 锁定遮罩/对话框的滚动，并在触摸遮罩背景时调用 closeFn
     * @param {HTMLElement} overlayEl - 遮罩元素
     * @param {Function} [closeFn] - 触摸遮罩背景时的回调
     * @returns {Function} cleanup - 调用以解除锁定
     */
    function lockOverlayScroll(overlayEl, closeFn) {
        _lockBodyScroll();

        var touchStartY = 0;

        function onTouchStart(e) {
            touchStartY = e.touches ? e.touches[0].clientY : 0;
        }

        function onTouchMove(e) {
            // 如果触摸目标就是遮罩本身（非子元素），阻止滚动
            if (e.target === overlayEl) {
                e.preventDefault();
            }
        }

        function onWheel(e) {
            if (e.target === overlayEl) {
                e.preventDefault();
            }
        }

        if (overlayEl) {
            overlayEl.addEventListener('touchstart', onTouchStart, { passive: true });
            overlayEl.addEventListener('touchmove', onTouchMove, { passive: false });
            overlayEl.addEventListener('wheel', onWheel, { passive: false });
        }

        var cleaned = false;

        function cleanup() {
            if (cleaned) return;
            cleaned = true;
            if (_observer) { _observer.disconnect(); _observer = null; }
            if (overlayEl) {
                overlayEl.removeEventListener('touchstart', onTouchStart);
                overlayEl.removeEventListener('touchmove', onTouchMove);
                overlayEl.removeEventListener('wheel', onWheel);
            }
            _unlockBodyScroll();
        }

        // MutationObserver：自动检测遮罩从 DOM 中被移除（防止 cleanup 未调用导致永久锁定）
        var _observer = null;
        if (overlayEl && overlayEl.parentNode) {
            _observer = new MutationObserver(function (mutations) {
                for (var i = 0; i < mutations.length; i++) {
                    var removed = mutations[i].removedNodes;
                    for (var j = 0; j < removed.length; j++) {
                        if (removed[j] === overlayEl || removed[j].contains(overlayEl)) {
                            cleanup();
                            return;
                        }
                    }
                }
                // 遮罩本身还在但已脱离文档树（如被 replaceChild）
                if (!document.body.contains(overlayEl)) {
                    cleanup();
                }
            });
            _observer.observe(overlayEl.parentNode, { childList: true, subtree: true });
        }

        return cleanup;
    }

    win.BK.lockOverlayScroll = lockOverlayScroll;

}(window));
