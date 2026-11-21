/**
 * MarkPanel 通用列表渲染组件
 * - 紧凑列表 + 左侧颜色条
 * - 左滑删除手势
 * - 点击跳转 / 长按编辑
 * - 批注折叠预览
 */
(function (win) {
    'use strict';
    win.BK = win.BK || {};

    var SWIPE_THRESHOLD = 30;  // 左滑超过此值显示删除（降低门槛提升灵敏度）
    var SWIPE_FULL = 80;       // 删除按钮完全展开的偏移量
    var SWIPE_AUTO_DELETE = 160; // 全滑到此值直接删除
    var LONG_PRESS_MS   = 500; // 长按阈值
    var UNDO_TIMEOUT    = 5000; // 撤销窗口 5 秒

    var MarkList = {
        /**
         * 渲染书签/标记列表
         * @param {HTMLElement} container
         * @param {Array} items
         * @param {Object} opts
         *   opts.showColorBar: Boolean (default true)
         *   opts.defaultColor: String
         *   opts.onNavigate: Function(item)
         *   opts.onDelete: Function(item, li)
         *   opts.onEdit: Function(item)
         *   opts.emptyText: String
         *   opts.typeLabel: String (override item.type label)
         */
        render: function (container, items, opts) {
            opts = opts || {};
            container.innerHTML = '';

            if (!items || items.length === 0) {
                container.innerHTML = '<div class="bk-mp-empty">' +
                    (opts.emptyText || '暂无内容') + '</div>';
                return;
            }

            var ul = document.createElement('ul');
            ul.className = 'bk-mp-list';

            items.forEach(function (item) {
                var li = MarkList._createItem(item, opts);
                ul.appendChild(li);
            });

            container.appendChild(ul);
        },

        /**
         * 创建单个列表项
         */
        _createItem: function (item, opts) {
            var li = document.createElement('li');
            li.className = 'bk-mp-item';
            li.setAttribute('data-id', item.id);

            // 颜色条（放在 li 中而非 main 内，左滑时不随 main 一起移动）
            var showBar = opts.showColorBar !== false;
            if (showBar) {
                var bar = document.createElement('div');
                bar.className = 'bk-mp-color-bar';
                var barColor = item.color
                    ? (win.BK.MarkUtils.COLOR_MAP[item.color] || item.color)
                    : (opts.defaultColor || win.BK.MarkUtils.COLOR_MAP.bookmark);
                bar.style.background = barColor;
                li.appendChild(bar);
            }

            // 主区域包装（内容区，左滑时整体移动，遮盖删除按钮）
            var main = document.createElement('div');
            main.className = 'bk-mp-item-main';
            main.style.display = 'flex';
            main.style.alignItems = 'stretch';
            main.style.position = 'relative';
            main.style.zIndex = '1';
            main.style.background = 'var(--surface, #fff)';
            main.style.width = '100%';
            main.style.flex = '1';

            // 内容区
            var content = document.createElement('div');
            content.className = 'bk-mp-item-content';

            // 标题行
            var title = document.createElement('div');
            title.className = 'bk-mp-item-title';
            title.textContent = item.title || item.text || '未命名';
            content.appendChild(title);

            // 元信息行
            var metaParts = [];
            if (item.subtitle) metaParts.push(item.subtitle);
            if (opts.typeLabel) {
                metaParts.push(opts.typeLabel);
            } else if (item.type && win.BK.MarkUtils.TYPE_LABELS[item.type]) {
                metaParts.push(win.BK.MarkUtils.TYPE_LABELS[item.type]);
            }
            if (item.timestamp) metaParts.push(win.BK.MarkUtils.relativeTime(item.timestamp));
            if (metaParts.length > 0) {
                var meta = document.createElement('div');
                meta.className = 'bk-mp-item-meta';
                meta.textContent = metaParts.join(' · ');
                content.appendChild(meta);
            }

            // 批注预览行
            if (item.note) {
                var noteEl = document.createElement('div');
                noteEl.className = 'bk-mp-item-note';
                noteEl.textContent = item.note;
                content.appendChild(noteEl);
            }

            main.appendChild(content);
            li.appendChild(main);

            // 预渲染删除按钮（全宽红色背景 + 文字，对齐市面主流风格）
            var del = document.createElement('button');
            del.className = 'bk-mp-item-delete';
            del.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg><span>删除</span>';
            del.addEventListener('click', function (e) {
                e.stopPropagation();
                if (opts.onDelete) opts.onDelete(item, li);
            });
            li.appendChild(del);

            // 事件绑定
            MarkList._bindEvents(li, item, opts);

            return li;
        },

        /**
         * 绑定交互事件
         */
        _bindEvents: function (li, item, opts) {
            var delBtn = li.querySelector('.bk-mp-item-delete');
            // 获取主区域 wrapper（内容区），左滑时只移动它，不移动 li
            var swipeTarget = li.querySelector('.bk-mp-item-main');
            // 设置滑动目标的 transform
            function setSwipeTransform(tx, transition) {
                if (transition !== undefined) swipeTarget.style.transition = transition;
                swipeTarget.style.transform = 'translateX(' + tx + 'px)';
            }

            // 点击跳转
            li.addEventListener('click', function (e) {
                // 删除按钮由自身 click handler 处理（stopPropagation）
                if (e.target.closest('.bk-mp-item-delete')) return;
                // 如果处于左滑状态，先收回滑动再处理
                if (li._swiped) {
                    e.preventDefault();
                    e.stopPropagation();
                    MarkList._snapBack(li);
                    return;
                }
                if (opts.onNavigate) opts.onNavigate(item);
            });

            // 长按编辑 + 左滑删除
            var longPressTimer = null;
            var moved = false;
            var touchStartY = 0;
            var startX = 0, currentDx = 0, swiping = false;
            var swipeReturnDx = 0;

            li.addEventListener('touchstart', function (e) {
                // 已处于左滑状态时，记录起点支持右滑收回
                if (li._swiped) {
                    startX = e.touches[0].clientX;
                    touchStartY = e.touches[0].clientY;
                    swipeReturnDx = 0;
                    moved = true;
                    swiping = false;
                    return;
                }
                moved = false;
                touchStartY = e.touches[0].clientY;
                startX = e.touches[0].clientX;
                currentDx = 0;
                swiping = false;
                longPressTimer = setTimeout(function () {
                    if (!moved && opts.onEdit) opts.onEdit(item);
                }, LONG_PRESS_MS);
            }, { passive: true });

            li.addEventListener('touchmove', function (e) {
                // 已处于左滑状态时，只处理右滑收回
                if (li._swiped) {
                    var rdx = e.touches[0].clientX - startX;
                    if (rdx > 10) {
                        swiping = true;
                        swipeReturnDx = rdx;
                        // 从 -SWIPE_FULL 位置右滑，带阻尼
                        var raw = -SWIPE_FULL + rdx;
                        var tx = raw < 0 ? raw * 0.6 : 0;  // 超出右边界带阻尼
                        setSwipeTransform(tx, 'none');
                    }
                    return;
                }
                var dy = Math.abs(e.touches[0].clientY - touchStartY);
                if (dy > 10) { moved = true; clearTimeout(longPressTimer); }
                var dx = e.touches[0].clientX - startX;
                if (dx < -15 && !swiping) {
                    moved = true;
                    clearTimeout(longPressTimer);
                    swiping = true;
                }
                if (swiping) {
                    currentDx = Math.max(dx, -SWIPE_FULL - 20); // 允许略微越界
                    // 超过 SWIPE_FULL 后带阻尼
                    if (currentDx < -SWIPE_FULL) {
                        var over = currentDx + SWIPE_FULL;
                        currentDx = -SWIPE_FULL + over * 0.3;
                    }
                    setSwipeTransform(currentDx, 'none');
                }
            }, { passive: true });

            li.addEventListener('touchend', function () {
                clearTimeout(longPressTimer);
                // 已处于左滑状态时，处理右滑收回
                if (li._swiped) {
                    if (swiping) {
                        if (swipeReturnDx > SWIPE_THRESHOLD) {
                            MarkList._snapBack(li);
                        } else {
                            setSwipeTransform(-SWIPE_FULL, 'transform 0.25s cubic-bezier(0.25, 1, 0.5, 1)');
                        }
                    }
                    swiping = false;
                    return;
                }
                var transition = 'transform 0.25s cubic-bezier(0.25, 1, 0.5, 1)';
                if (currentDx < -SWIPE_AUTO_DELETE) {
                    // 全滑直接删除（快捷操作）
                    li._swiped = false;
                    setSwipeTransform(0, 'transform 0.15s ease');
                    if (opts.onDelete) opts.onDelete(item, li);
                } else if (currentDx < -SWIPE_THRESHOLD) {
                    setSwipeTransform(-SWIPE_FULL, transition);
                    li._swiped = true;
                } else {
                    MarkList._snapBack(li);
                }
                swiping = false;
            });

            li.addEventListener('touchcancel', function () {
                clearTimeout(longPressTimer);
                if (li._swiped) return;
                MarkList._snapBack(li);
                swiping = false;
            });
        },

        /**
         * 收回左滑状态
         */
        _snapBack: function (li) {
            var main = li.querySelector('.bk-mp-item-main');
            if (main) {
                main.style.transition = 'transform 0.25s cubic-bezier(0.25, 1, 0.5, 1)';
                main.style.transform = 'translateX(0)';
            }
            li._swiped = false;
        },

        /**
         * 移除单个条目（带动画）
         */
        removeItem: function (li) {
            var h = li.offsetHeight;
            if (!h) { li.remove(); return; }
            li.style.maxHeight = h + 'px';
            li.style.overflow = 'hidden';
            li.style.transition = 'max-height 0.25s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.2s ease, padding 0.25s ease, border-width 0.25s ease';
            // force reflow
            li.offsetHeight;
            li.style.maxHeight = '0';
            li.style.opacity = '0';
            li.style.paddingTop = '0';
            li.style.paddingBottom = '0';
            li.style.borderWidth = '0';
            setTimeout(function () {
                li.remove();
                // 删空最后一项后显示空状态
                var list = li.closest('.bk-mp-list');
                if (list && !list.querySelector('.bk-mp-item')) {
                    var emptyEl = list.querySelector('.bk-mp-empty');
                    if (!emptyEl) {
                        emptyEl = document.createElement('div');
                        emptyEl.className = 'bk-mp-empty';
                        list.appendChild(emptyEl);
                    }
                    var emptyText = list.getAttribute('data-empty-text') || '暂无内容';
                    emptyEl.textContent = emptyText;
                    emptyEl.style.display = '';
                }
            }, 260);
        },

        /**
         * 显示撤销 Toast
         * @param {string} msg   提示文案
         * @param {Function} undoFn 撤销回调
         */
        showUndoToast: function (msg, undoFn) {
            // 清除已有的 Toast 及其定时器
            var existing = document.querySelector('.bk-mp-undo-toast');
            if (existing) {
                if (existing._dismissTimer) clearTimeout(existing._dismissTimer);
                existing.remove();
            }

            var toast = document.createElement('div');
            toast.className = 'bk-mp-undo-toast';
            toast.innerHTML = '<span>' + (msg || '已删除') + '</span>' +
                '<span class="bk-mp-undo-btn">撤销</span>';

            var dismissed = false;
            var timer = null;
            var dismiss = function () {
                if (dismissed) return;
                dismissed = true;
                if (timer) clearTimeout(timer);
                toast.classList.add('bk-mp-toast-out');
                setTimeout(function () { toast.remove(); }, 200);
            };

            toast.querySelector('.bk-mp-undo-btn').addEventListener('click', function () {
                if (undoFn) undoFn();
                dismiss();
            });

            document.body.appendChild(toast);
            timer = setTimeout(dismiss, UNDO_TIMEOUT);
            toast._dismissTimer = timer;
            // 点击 Toast 其他区域也关闭
            toast.addEventListener('click', function (e) {
                if (!e.target.closest('.bk-mp-undo-btn')) dismiss();
            });
        }
    };

    win.BK.MarkList = MarkList;
})(window);
