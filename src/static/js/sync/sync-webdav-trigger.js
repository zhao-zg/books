/**
 * sync-webdav-trigger.js — WebDAV 同步触发器
 *
 * 监听 router 的 reader-page-change 事件，在退书时 debounce 2s 后台触发双向同步。
 * 不阻塞退出操作，同步失败仅 console.warn。
 *
 * 触发逻辑：
 *   - 进入阅读视图（#/bookId/chapter）：记录当前 bookId，可选 pull
 *   - 退出阅读视图（从阅读视图切到非阅读视图）：debounce 2s → BK.SyncWebDAV.sync()
 *   - 并发守卫：_syncing 标志，正在同步时跳过新触发
 *   - 仅在 WebDAV 已配置时触发
 *
 * 依赖：BK.SyncWebDAV（sync-webdav.js）、WebDavManager（webdav-manager.js）、BKRouter（router.js）
 * 挂载：window.BK.SyncWebDAVTrigger
 */
(function (win) {
    'use strict';

    var DEBOUNCE_MS = 2000;
    var _debounceTimer = null;
    var _syncing = false;
    var _lastWasReading = false; // 上一次 dispatch 时是否处于阅读视图

    /**
     * 判断 path 是否为阅读视图（2 段：bookId/chapter）
     */
    function isReadingPath(path) {
        if (!path) return false;
        var parts = path.split('/').filter(Boolean);
        // 排除 series/<id>（3 段）和 series/<id>/<prefix>（3 段）
        if (parts.length === 2 && parts[0] === 'series') return false;
        return parts.length === 2;
    }

    /**
     * 获取 WebDAV 配置（仅当已配置且启用时返回）
     */
    function getConfig() {
        try {
            if (!win.WebDavManager || typeof win.WebDavManager.getActiveConfig !== 'function') return null;
            var cfg = win.WebDavManager.getActiveConfig();
            return cfg || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * 执行后台同步（非阻塞，失败仅 warn）
     */
    function runSync() {
        if (_syncing) {
            console.log('[SyncWebDAVTrigger] 同步进行中，跳过');
            return;
        }
        var config = getConfig();
        if (!config) {
            console.log('[SyncWebDAVTrigger] WebDAV 未配置，跳过同步');
            return;
        }
        if (!win.BK || !win.BK.SyncWebDAV) {
            console.warn('[SyncWebDAVTrigger] BK.SyncWebDAV 不可用');
            return;
        }

        _syncing = true;
        console.log('[SyncWebDAVTrigger] 开始后台同步...');
        win.BK.SyncWebDAV.sync(config).then(function (result) {
            _syncing = false;
            if (result && result.errors && result.errors.length > 0) {
                console.warn('[SyncWebDAVTrigger] 同步完成，但有错误:', result.errors);
            } else {
                console.log('[SyncWebDAVTrigger] 同步完成: pulled=' + (result ? result.pulled : 0) + ' pushed=' + (result ? result.pushed : 0));
            }
        }).catch(function (err) {
            _syncing = false;
            console.warn('[SyncWebDAVTrigger] 同步失败:', err.message || err);
        });
    }

    /**
     * 取消 debounce 定时器
     */
    function cancelDebounce() {
        if (_debounceTimer) {
            clearTimeout(_debounceTimer);
            _debounceTimer = null;
        }
    }

    /**
     * 事件处理：reader-page-change
     */
    function onPageChange(e) {
        var path = '';
        try {
            path = (e && e.detail && e.detail.path) || (win.BKRouter ? win.BKRouter.currentPath() : '');
        } catch (err) {
            return;
        }

        var isReading = isReadingPath(path);

        if (isReading) {
            // 进入阅读视图：取消待执行的 debounce（可能是快速进出）
            cancelDebounce();
            _lastWasReading = true;
        } else {
            // 从阅读视图退出 → debounce 2s 后同步
            if (_lastWasReading) {
                cancelDebounce();
                _debounceTimer = setTimeout(function () {
                    _debounceTimer = null;
                    runSync();
                }, DEBOUNCE_MS);
            }
            _lastWasReading = false;
        }
    }

    /**
     * 初始化：绑定事件监听
     */
    function init() {
        if (win.__syncWebDavTriggerInit) return;
        win.__syncWebDavTriggerInit = true;
        document.addEventListener('reader-page-change', onPageChange);
        console.log('[SyncWebDAVTrigger] 已初始化，监听 reader-page-change');
    }

    // 导出
    win.BK = win.BK || {};
    win.BK.SyncWebDAVTrigger = {
        init: init,
        runSync: runSync,
        isReadingPath: isReadingPath,
        _onPageChange: onPageChange // 暴露用于测试
    };

    // 自动初始化（DOMContentLoaded 或已 ready）
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})(window);
