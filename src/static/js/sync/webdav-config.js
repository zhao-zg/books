/**
 * webdav-config.js — WebDAV 配置统一读取器（纯函数）
 *
 * 收编 webdav-manager.js 内 localStorage 直读逻辑（CFG_KEY / ACTIVE_KEY），
 * 供 webdav-manager / webdav-upload / sync-webdav / rp-import 统一读取。
 *
 * 设计约束（设计文档任务 5 / 决策 ④）：
 *   - localStorage 键名与数据格式一律不变：bk_webdav_configs / bk_webdav_active，
 *     只统一读取代码路径，不迁移数据。
 *   - 纯函数无副作用：不碰 IndexedDB / crypto / 预置服务器解码——
 *     那些属于 WebDavManager 的加密与竞速层，本模块只负责「裸存储读取」。
 *   - 可独立在 JSDOM 中加载（无模块级副作用），支持单测。
 *
 * 与 WebDavManager 的分工：
 *   - 本模块：读裸 localStorage（密文密码原样返回），读侧兜底（坏 JSON → []）。
 *   - WebDavManager：AES-GCM 解密缓存、预置服务器合并去重、激活缓存
 *     （DEV-2：connect 未保存也可读）、多域名竞速。生产路径仍以
 *     WebDavManager.getActiveConfig() 为准（含解密），本模块为其提供
 *     底层读取原语，也供无需解密的场景（如 UI 列表骨架）直接使用。
 *
 * 挂载：window.BK.WebDavConfig
 *   .KEY_CONFIGS / .KEY_ACTIVE          常量（与 webdav-manager 对齐）
 *   .getSavedConfigs(json)              纯函数：JSON 字符串 → 配置数组（坏数据回退 []）
 *   .getActiveConfigId(id)              纯函数：激活 id 非空校验
 *   .getConfigById(configs, id)         纯函数：按 id 查找（null 安全）
 *   .resolveActive(configs, id)         纯函数：configs + activeId → 激活配置
 *   .readSavedState(win)                从 window.localStorage 读完整状态
 */
(function (win) {
    'use strict';

    // ── localStorage 键（与 webdav-manager.js 完全一致，不迁移数据）──────────
    var KEY_CONFIGS = 'bk_webdav_configs';
    var KEY_ACTIVE = 'bk_webdav_active';

    /**
     * 解析已保存配置 JSON → 配置数组
     * 读侧兜底：空/坏 JSON/非数组一律回退 []，绝不抛异常
     * @param {string|null|undefined} json  localStorage 原始字符串
     * @returns {Object[]}
     */
    function getSavedConfigs(json) {
        if (!json) return [];
        var parsed;
        try {
            parsed = JSON.parse(json);
        } catch (e) {
            return [];
        }
        if (!Array.isArray(parsed)) return [];
        // 过滤无效项（null / 非对象）
        var out = [];
        for (var i = 0; i < parsed.length; i++) {
            if (parsed[i] && typeof parsed[i] === 'object') {
                out.push(parsed[i]);
            }
        }
        return out;
    }

    /**
     * 激活配置 id 非空校验（缺失/空串 → null）
     * @param {string|null|undefined} id
     * @returns {string|null}
     */
    function getActiveConfigId(id) {
        return id || null;
    }

    /**
     * 按 id 在配置列表中查找（null 安全）
     * @param {Object[]|null} configs
     * @param {string|null} id
     * @returns {Object|null}
     */
    function getConfigById(configs, id) {
        if (!id || !Array.isArray(configs)) return null;
        for (var i = 0; i < configs.length; i++) {
            if (configs[i] && configs[i].id === id) return configs[i];
        }
        return null;
    }

    /**
     * 配置列表 + 激活 id → 激活配置对象
     * id 未命中列表时返回 null（不误选第一个）
     * @param {Object[]|null} configs
     * @param {string|null} id
     * @returns {Object|null}
     */
    function resolveActive(configs, id) {
        return getConfigById(configs, id);
    }

    /**
     * 从 window.localStorage 读取完整保存状态（配置数组 + 激活 id + 激活配置）
     * @param {Window} [w]  可注入的 window（缺省 win）
     * @returns {{configs: Object[], activeId: string|null, active: Object|null}}
     */
    function readSavedState(w) {
        w = w || win;
        var configs = [];
        var activeId = null;
        try {
            configs = getSavedConfigs(w.localStorage.getItem(KEY_CONFIGS));
            activeId = getActiveConfigId(w.localStorage.getItem(KEY_ACTIVE));
        } catch (e) {
            // localStorage 不可用（隐私模式等）→ 空状态
            configs = [];
            activeId = null;
        }
        return {
            configs: configs,
            activeId: activeId,
            active: resolveActive(configs, activeId)
        };
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.WebDavConfig = {
        // 常量
        KEY_CONFIGS: KEY_CONFIGS,
        KEY_ACTIVE: KEY_ACTIVE,
        // 纯函数
        getSavedConfigs: getSavedConfigs,
        getActiveConfigId: getActiveConfigId,
        getConfigById: getConfigById,
        resolveActive: resolveActive,
        readSavedState: readSavedState
    };

})(window);
