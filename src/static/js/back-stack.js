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

    // 注入对话框基础样式（仅一次）
    var _dialogStyleInjected = false;

    function _injectDialogStyles() {
        if (_dialogStyleInjected) return;
        _dialogStyleInjected = true;
        var style = document.createElement('style');
        style.id = 'bk-dialog-base-style';
        style.textContent = [
            /* 遮罩 */
            '.bk-dialog-mask{position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,.45);',
            'display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;',
            'opacity:0;transition:opacity .2s ease;-webkit-tap-highlight-color:transparent}',
            '.bk-dialog-mask.show{opacity:1}',
            /* 对话框 */
            '.bk-dialog{background:var(--surface,#fff);border-radius:14px;width:min(340px,calc(100vw - 40px));',
            'max-height:80vh;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.22);',
            'transform:scale(.92);transition:transform .2s ease;display:flex;flex-direction:column}',
            '.bk-dialog-mask.show .bk-dialog{transform:scale(1)}',
            '.bk-dialog-title{font-size:16px;font-weight:600;color:var(--heading,#111);',
            'padding:16px 16px 10px;text-align:center}',
            '.bk-dialog-desc{font-size:13px;color:var(--text-muted,#888);padding:0 16px 8px;text-align:center}',
            /* 操作栏 */
            '.bk-dialog-actions{display:flex;border-top:1px solid var(--border,#e0e0e0);flex-shrink:0}',
            '.bk-dialog-cancel,.bk-dialog-confirm{flex:1;padding:13px 8px;border:none;background:transparent;',
            'font:inherit;font-size:15px;cursor:pointer;text-align:center;',
            '-webkit-tap-highlight-color:transparent}',
            '.bk-dialog-cancel{color:var(--text-muted,#888);border-right:1px solid var(--border,#e0e0e0)}',
            '.bk-dialog-confirm{color:var(--brand,#667eea);font-weight:600}',
            '.bk-dialog-cancel:active,.bk-dialog-confirm:active{background:var(--nav-hover,rgba(0,0,0,.04))}',
            /* 选项 */
            '.bk-dialog-opts{padding:4px 16px 8px}',
            '.bk-dialog-opt{display:flex;gap:12px;padding:12px;border-radius:10px;border:1.5px solid var(--border,#e0e0e0);',
            'margin-bottom:8px;cursor:pointer;transition:border-color .15s,background .15s}',
            '.bk-dialog-opt.selected{border-color:var(--brand,#667eea);background:rgba(102,126,234,.06)}',
            '.bk-dialog-opt-icon{font-size:24px;flex-shrink:0;line-height:1.4}',
            '.bk-dialog-opt-body{flex:1;min-width:0}',
            '.bk-dialog-opt-title{font-size:14px;font-weight:600;color:var(--text,#333)}',
            '.bk-dialog-opt-sub{font-size:12px;color:var(--text-muted,#888);margin-top:2px;line-height:1.4}'
        ].join('\n');
        document.head.appendChild(style);
    }

    /**
     * 打开一个对话框
     * @param {Object} opts - { id: string, html: string }
     * @returns {{ mask: HTMLElement, close: Function } | null}
     *   如果 id 对应的对话框已存在，返回 null
     */
    function openDialog(opts) {
        opts = opts || {};
        var id = opts.id || '';
        var html = opts.html || '';

        _injectDialogStyles();

        // 防重复：如果同 id 的遮罩已存在，返回 null
        if (id && document.getElementById(id)) {
            return null;
        }

        // 创建遮罩
        var mask = document.createElement('div');
        mask.className = 'bk-dialog-mask';
        if (id) mask.id = id;
        mask.innerHTML = html;
        document.body.appendChild(mask);

        // 强制重排后显示动画
        void mask.offsetWidth;
        mask.classList.add('show');

        var closed = false;

        function close() {
            if (closed) return;
            closed = true;
            mask.classList.remove('show');
            setTimeout(function () {
                if (mask.parentNode) mask.parentNode.removeChild(mask);
            }, 220);
        }

        // 点击遮罩（对话框外部）关闭
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

    function _lockBodyScroll() {
        _scrollLockCount++;
        if (_scrollLockCount === 1) {
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
            document.documentElement.classList.remove('bk-scroll-locked');
            document.body.classList.remove('bk-scroll-locked');
        }
    }

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
            if (overlayEl) {
                overlayEl.removeEventListener('touchstart', onTouchStart);
                overlayEl.removeEventListener('touchmove', onTouchMove);
                overlayEl.removeEventListener('wheel', onWheel);
            }
            _unlockBodyScroll();
        }

        return cleanup;
    }

    win.BK.lockOverlayScroll = lockOverlayScroll;

}(window));
