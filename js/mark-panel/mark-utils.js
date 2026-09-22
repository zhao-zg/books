/**
 * MarkPanel 工具函数
 * - 时间相对格式化
 * - 文本截断
 * - 颜色映射
 * - 防抖
 */
(function (win) {
    'use strict';
    win.BK = win.BK || {};

    var COLOR_MAP = {
        yellow:  '#E8D18C',
        green:   '#A8D4B0',
        blue:    '#9DC0D4',
        pink:    '#D9A5A6',
        orange:  '#DCBD8A',
        bookmark:'#E8943A'
    };

    var TYPE_LABELS = {
        highlight:     '高亮',
        underline:     '下划线',
        strikethrough: '删除线',
        note:          '批注'
    };

    var MarkUtils = {
        /**
         * 相对时间格式化
         * @param {number} timestamp - 毫秒时间戳
         * @returns {string}
         */
        relativeTime: function (timestamp) {
            if (!timestamp) return '';
            var now = Date.now();
            var diff = now - timestamp;
            var seconds = Math.floor(diff / 1000);
            var minutes = Math.floor(seconds / 60);
            var hours   = Math.floor(minutes / 60);
            var days    = Math.floor(hours / 24);

            if (seconds < 60)  return '刚刚';
            if (minutes < 60)  return minutes + '分钟前';
            if (hours < 24)    return hours + '小时前';
            if (days === 1)    return '昨天';
            if (days < 30)     return days + '天前';
            if (days < 365)    return Math.floor(days / 30) + '个月前';
            var d = new Date(timestamp);
            return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
        },

        /**
         * 文本截断
         * @param {string} text
         * @param {number} maxLen
         * @returns {string}
         */
        truncate: function (text, maxLen) {
            if (!text) return '';
            maxLen = maxLen || 80;
            return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
        },

        /**
         * 颜色映射
         */
        COLOR_MAP: COLOR_MAP,

        /**
         * 标记类型显示名称
         */
        TYPE_LABELS: TYPE_LABELS,

        /**
         * 防抖
         */
        debounce: function (fn, ms) {
            var timer = null;
            return function () {
                var args = arguments;
                var ctx = this;
                if (timer) clearTimeout(timer);
                timer = setTimeout(function () { fn.apply(ctx, args); }, ms);
            };
        },

        /**
         * 获取颜色条 CSS 值
         * @param {string} color - 颜色key
         * @param {string} fallback - 默认颜色
         * @returns {string}
         */
        getColor: function (color, fallback) {
            return COLOR_MAP[color] || color || fallback || COLOR_MAP.bookmark;
        }
    };

    win.BK.MarkUtils = MarkUtils;
})(window);
