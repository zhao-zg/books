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
    var SWIPE_FULL = 72;       // 删除按钮完全展开的偏移量
    var LONG_PRESS_MS   = 500; // 长按阈值

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

            // 颜色条
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

            li.appendChild(content);

            // 预渲染删除按钮（避免松手后动态创建造成的闪烁）
            var del = document.createElement('button');
            del.className = 'bk-mp-item-delete';
            del.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
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
                        li.style.transform = 'translateX(' + tx + 'px)';
                        li.style.transition = 'none';
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
                    li.style.transform = 'translateX(' + currentDx + 'px)';
                    li.style.transition = 'none';
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
                            li.style.transition = 'transform 0.25s cubic-bezier(0.25, 1, 0.5, 1)';
                            li.style.transform = 'translateX(' + (-SWIPE_FULL) + 'px)';
                        }
                    }
                    swiping = false;
                    return;
                }
                li.style.transition = 'transform 0.25s cubic-bezier(0.25, 1, 0.5, 1)';
                if (currentDx < -SWIPE_THRESHOLD) {
                    li.style.transform = 'translateX(' + (-SWIPE_FULL) + 'px)';
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
            li.style.transition = 'transform 0.25s cubic-bezier(0.25, 1, 0.5, 1)';
            li.style.transform = 'translateX(0)';
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
            li.style.transition = 'max-height 0.25s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.2s ease, padding 0.25s ease';
            // force reflow
            li.offsetHeight;
            li.style.maxHeight = '0';
            li.style.opacity = '0';
            li.style.paddingTop = '0';
            li.style.paddingBottom = '0';
            li.style.borderWidth = '0';
            setTimeout(function () { li.remove(); }, 260);
        }
    };

    win.BK.MarkList = MarkList;
})(window);
