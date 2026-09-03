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
 *   .removeConfig(configs, id)          纯函数：从配置数组移除指定 id（未命中原样返回）
 *   .resolveActiveAfterRemove(configs, removedId, activeId)
 *                                       纯函数：删除后激活 id 回退（删中激活项→第一个/置 null）
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

    /**
     * 从配置数组移除指定 id 的配置（deleteConfig 的纯逻辑部分）
     * 未命中 / 空 id / 空列表 → 原样返回（拷贝语义：返回新数组，不动入参）
     * @param {Object[]|null} configs
     * @param {string|null} id
     * @returns {Object[]}
     */
    function removeConfig(configs, id) {
        var src = Array.isArray(configs) ? configs : [];
        var out = [];
        for (var i = 0; i < src.length; i++) {
            if (id && src[i] && src[i].id === id) continue;
            out.push(src[i]);
        }
        return out;
    }

    /**
     * 删除配置后的激活 id 回退策略：
     *   - 删除的不是激活项 → 激活 id 保持不变
     *   - 删除的正是激活项且剩余列表非空 → 回退到第一个（兜底，避免悬空 id）
     *   - 删除的正是激活项且列表清空 → 置 null
     *   - 激活 id 本来就缺失 → 保持 null（不凭空选第一个）
     * @param {Object[]|null} configs       删除后的配置数组
     * @param {string|null} removedId       被删除的配置 id
     * @param {string|null} activeId        删除前的激活 id
     * @returns {{activeId: string|null, active: Object|null}}
     */
    function resolveActiveAfterRemove(configs, removedId, activeId) {
        var removed = removedId || null;
        var act = activeId || null;
        if (act && removed && act === removed) {
            // 激活项被删：剩余列表非空 → 回退第一个；空 → null
            act = (configs && configs.length) ? configs[0].id : null;
        }
        return {
            activeId: act,
            active: resolveActive(configs, act)
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
        readSavedState: readSavedState,
        removeConfig: removeConfig,
        resolveActiveAfterRemove: resolveActiveAfterRemove
    };

})(window);
