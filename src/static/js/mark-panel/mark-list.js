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

    var SWIPE_THRESHOLD = 40;  // 左滑超过此值显示删除
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

            // 事件绑定
            MarkList._bindEvents(li, item, opts);

            return li;
        },

        /**
         * 绑定交互事件
         */
        _bindEvents: function (li, item, opts) {
            // 点击跳转
            li.addEventListener('click', function (e) {
                // 如果处于左滑状态，先收回滑动再处理
                if (li._swiped) {
                    e.preventDefault();
                    e.stopPropagation();
                    li.style.transition = 'transform 0.2s ease';
                    li.style.transform = 'translateX(0)';
                    li._swiped = false;
                    var existingDel = li.querySelector('.bk-mp-item-delete');
                    if (existingDel) existingDel.remove();
                    return;
                }
                if (e.target.closest('.bk-mp-item-delete')) return;
                if (opts.onNavigate) opts.onNavigate(item);
            });

            // 长按编辑 + 左滑删除（合并 touchstart/touchmove 避免冲突）
            var longPressTimer = null;
            var moved = false;
            var touchStartY = 0;
            var startX = 0, currentDx = 0, swiping = false;
            var swipeReturnDx = 0;  // 右滑收回时的累计偏移量
            li.addEventListener('touchstart', function (e) {
                // 已处于左滑状态时，不启动新的滑动检测
                // 让 click 事件自然触发（删除按钮的 click 会 stopPropagation）
                if (li._swiped) {
                    // 记录起点以支持右滑收回
                    startX = e.touches[0].clientX;
                    touchStartY = e.touches[0].clientY;
                    swipeReturnDx = 0;
                    moved = true;  // 阻止长按
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
                    var dx = e.touches[0].clientX - startX;
                    if (dx > 20) {
                        swiping = true;
                        swipeReturnDx = dx;
                        li.style.transform = 'translateX(' + Math.min(0, -80 + dx) + 'px)';
                        li.style.transition = 'none';
                    }
                    return;
                }
                var dy = Math.abs(e.touches[0].clientY - touchStartY);
                if (dy > 12) { moved = true; clearTimeout(longPressTimer); }
                var dx = e.touches[0].clientX - startX;
                if (dx < -20 && !swiping) {
                    // 取消长按
                    moved = true;
                    clearTimeout(longPressTimer);
                    swiping = true;
                }
                if (swiping) {
                    currentDx = Math.max(dx, -80);
                    li.style.transform = 'translateX(' + currentDx + 'px)';
                    li.style.transition = 'none';
                }
            }, { passive: true });
            li.addEventListener('touchend', function () {
                clearTimeout(longPressTimer);
                // 已处于左滑状态时，处理右滑收回
                if (li._swiped) {
                    if (swiping) {
                        li.style.transition = 'transform 0.2s ease';
                        // 右滑超过阈值则收回，否则回弹到 -80px
                        if (swipeReturnDx > 40) {
                            li.style.transform = 'translateX(0)';
                            li._swiped = false;
                            var existingDel = li.querySelector('.bk-mp-item-delete');
                            if (existingDel) existingDel.remove();
                        } else {
                            li.style.transform = 'translateX(-80px)';
                        }
                    }
                    swiping = false;
                    return;
                }
                li.style.transition = 'transform 0.2s ease';
                if (currentDx < -SWIPE_THRESHOLD) {
                    li.style.transform = 'translateX(-80px)';
                    li._swiped = true;
                    // 显示删除按钮
                    if (!li.querySelector('.bk-mp-item-delete')) {
                        var del = document.createElement('button');
                        del.className = 'bk-mp-item-delete';
                        del.textContent = '删除';
                        del.addEventListener('click', function (e) {
                            e.stopPropagation();
                            if (opts.onDelete) opts.onDelete(item, li);
                        });
                        li.appendChild(del);
                    }
                } else {
                    li.style.transform = 'translateX(0)';
                    li._swiped = false;
                    var existingDel = li.querySelector('.bk-mp-item-delete');
                    if (existingDel) existingDel.remove();
                }
                swiping = false;
            });
            li.addEventListener('touchcancel', function () {
                clearTimeout(longPressTimer);
                if (li._swiped) return;
                li.style.transition = 'transform 0.2s ease';
                li.style.transform = 'translateX(0)';
                swiping = false;
            });
        },

        /**
         * 移除单个条目（带动画）
         */
        removeItem: function (li) {
            var h = li.offsetHeight;
            if (!h) { li.remove(); return; }
            li.style.maxHeight = h + 'px';
            li.style.overflow = 'hidden';
            li.style.transition = 'max-height 0.25s ease, opacity 0.25s ease, padding 0.25s ease';
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
