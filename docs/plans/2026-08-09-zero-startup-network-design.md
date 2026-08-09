---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '538c42fb-345b-4674-b54a-ba7a91739f5b'
  PropagateID: '538c42fb-345b-4674-b54a-ba7a91739f5b'
  ReservedCode1: 'b2d0c43c-61b1-468d-9e21-135d5fa14f5e'
  ReservedCode2: 'b2d0c43c-61b1-468d-9e21-135d5fa14f5e'
---

# 启动零网络请求设计文档

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement.

**Goal:** 应用启动时不在后台发起任何外部网络请求，除非用户开启了"自动检查更新"；关闭时仍保留手动触发检查更新的入口。

**Architecture:** 引入中央门控函数 `BK.shouldAllowNetworkRequest()`，所有启动时自动触发的网络请求统一走该函数判断。手动检查更新入口通过临时设置 `BK._forceNetwork = true` 绕过门控。

**Tech Stack:** 纯前端 JavaScript，localStorage 持久化设置

---

## 组件与职责

### 1. 中央门控函数

**文件:** `src/static/index.html`（内联脚本，在 `<head>` 中与 BK_ENV 同级定义）

```js
/**
 * 判断当前是否允许发起网络请求（用于启动时自动触发的请求）
 * - 自动检查更新开启时返回 true
 * - 手动触发更新期间（BK._forceNetwork === true）返回 true
 * - 其他情况返回 false
 */
window.BK.shouldAllowNetworkRequest = function() {
    if (window.BK._forceNetwork) return true;
    try {
        return localStorage.getItem('bk_auto_check_update') === '1';
    } catch(e) { return false; }
};

/**
 * 在回调内临时允许网络请求（用于手动触发检查更新等场景）
 * @param {Function} fn - 需要联网执行的异步函数
 */
window.BK.withNetworkAllowed = async function(fn) {
    window.BK._forceNetwork = true;
    try { return await fn(); }
    finally { window.BK._forceNetwork = false; }
};
```

### 2. 受控调用点（5 处）

| # | 文件 | 原代码 | 改为 |
|---|------|--------|------|
| 1 | `index.html:checkPwaStartupCache()` | 无条件 fetch version.json | `if (!BK.shouldAllowNetworkRequest()) return;` |
| 2 | `index.html:Capacitor version.json` | 无条件 fetch version.json | `if (!BK.shouldAllowNetworkRequest()) return;` |
| 3 | `index.html:reg.update()` | 无条件调用 | `if (BK.shouldAllowNetworkRequest()) reg.update().catch(...)` |
| 4 | `dm-index.js:_silentCheckUpdate()` | 无条件 fetch manifest.json | `if (!BK.shouldAllowNetworkRequest()) return;` |
| 5 | `theme-toggle.js:probeSponsor()` | 无条件探测赞助图 | `if (!BK.shouldAllowNetworkRequest()) return;` |
| 6 | `au-core.js:init()` | 无条件 loadConfig() + silentCheckUpdate | 门控 loadConfig 和 silentCheckUpdate |

### 3. 手动检查更新入口

**文件:** `src/static/js/theme-toggle.js`（设置页"检查更新"按钮的回调）

```js
// 用户在设置页点击"手动检查更新"按钮时
window.BK.withNetworkAllowed(function() {
    if (window.AppUpdate && window.AppUpdate.silentCheckUpdate) {
        return window.AppUpdate.silentCheckUpdate();
    }
    // PWA: 手动触发 checkPwaStartupCache 逻辑
    if (typeof checkPwaStartupCache === 'function') {
        checkPwaStartupCache();
    }
    return Promise.resolve();
});
```

## 数据流

```
应用启动
  ├─ BK.shouldAllowNetworkRequest() 初始化（读 localStorage）
  ├─ SW 注册（不拦截）→ reg.update() 受门控
  ├─ checkPwaStartupCache() 受门控
  ├─ Capacitor version.json fetch 受门控
  ├─ au-core.js init() 受门控
  ├─ dm-index.js _silentCheckUpdate() 受门控
  └─ theme-toggle.js probeSponsor() 受门控

用户点击"手动检查更新"
  └─ BK.withNetworkAllowed(fn)
       ├─ BK._forceNetwork = true
       ├─ 执行 fn（绕过门控）
       └─ BK._forceNetwork = false
```

## 错误处理

- `BK.shouldAllowNetworkRequest()` 中的 localStorage 读取用 try-catch 保护，异常时返回 false（安全侧：宁可少联网）
- `BK.withNetworkAllowed()` 中 fn 抛异常时，finally 块确保 `_forceNetwork` 被重置
- 受门控跳过的请求不做任何提示或日志（用户已选择不自动联网）

## 测试策略

- 验证 `bk_auto_check_update` 为默认值时，启动不发起任何 fetch/XHR/Image 请求
- 验证 `bk_auto_check_update === '1'` 时，所有请求正常发起
- 验证 `BK.withNetworkAllowed()` 期间门控返回 true，结束后恢复 false
- 验证 `withNetworkAllowed` 中 fn 抛异常后 `_forceNetwork` 仍被重置