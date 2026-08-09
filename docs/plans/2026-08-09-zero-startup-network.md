---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '9a92a556-5cc4-4f14-88fe-8ca774996b3a'
  PropagateID: '9a92a556-5cc4-4f14-88fe-8ca774996b3a'
  ReservedCode1: '330743b8-8f99-4e12-8810-6835213aa986'
  ReservedCode2: '330743b8-8f99-4e12-8810-6835213aa986'
---

# 启动零网络请求 实现计划

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement.

**Goal:** 引入中央门控函数，使启动时自动网络请求受"自动检查更新"设置控制，同时保留手动触发入口。

**Architecture:** 在 index.html 内联脚本中定义 `BK.shouldAllowNetworkRequest()` 和 `BK.withNetworkAllowed()`，6 处调用点统一使用门控函数。

**Tech Stack:** 纯前端 JavaScript，localStorage

---

### Task 1: 定义中央门控函数

**Files:**
- Modify: `src/static/index.html`

**Step 1: 在 BK_ENV 初始化后添加门控函数**

在 `index.html` 中 `BK_ENV` 定义之后、`</script>` 之前，添加：

```js
// ── 网络请求门控：关闭自动检查更新时，启动不联网 ──
window.BK = window.BK || {};
window.BK._forceNetwork = false;
window.BK.shouldAllowNetworkRequest = function() {
    if (window.BK._forceNetwork) return true;
    try { return localStorage.getItem('bk_auto_check_update') === '1'; } catch(e) { return false; }
};
window.BK.withNetworkAllowed = async function(fn) {
    window.BK._forceNetwork = true;
    try { return await fn(); }
    finally { window.BK._forceNetwork = false; }
};
```

**Step 2: 验证函数可访问**

在浏览器控制台输入 `BK.shouldAllowNetworkRequest()`，默认应返回 `false`。

**Step 3: Commit**

`git add src/static/index.html && git commit -m "feat: add BK.shouldAllowNetworkRequest central network gate"`

---

### Task 2: 门控 checkPwaStartupCache()

**Files:**
- Modify: `src/static/index.html`

**Step 1: 修改 checkPwaStartupCache 函数**

将当前的分散检查：
```js
try{if(localStorage.getItem('bk_auto_check_update')!=='1')return;}catch(e){}
```

替换为统一门控：
```js
if(!window.BK.shouldAllowNetworkRequest())return;
```

**Step 2: 验证**

- `bk_auto_check_update` 默认时，启动不 fetch version.json
- 开启后，启动正常 fetch version.json

**Step 3: Commit**

`git add src/static/index.html && git commit -m "refactor: gate checkPwaStartupCache with shouldAllowNetworkRequest"`

---

### Task 3: 门控 Capacitor version.json fetch

**Files:**
- Modify: `src/static/index.html`

**Step 1: 修改 Capacitor 原生环境启动逻辑**

将当前的分散检查：
```js
var _skipCapUpdate=false;try{_skipCapUpdate=localStorage.getItem('bk_auto_check_update')!=='1';}catch(e){}
if(!_skipCapUpdate){
```

替换为统一门控：
```js
if(window.BK.shouldAllowNetworkRequest()){
```

注意：需要对应调整闭合大括号。

**Step 2: 验证**

- Capacitor APK 模式，默认设置时启动不 fetch version.json
- 开启自动检查后，正常缓存更新

**Step 3: Commit**

`git add src/static/index.html && git commit -m "refactor: gate Capacitor version fetch with shouldAllowNetworkRequest"`

---

### Task 4: 门控 reg.update()

**Files:**
- Modify: `src/static/index.html`

**Step 1: 修改 SW 注册后的 reg.update 调用**

将当前的分散检查：
```js
try{if(localStorage.getItem('bk_auto_check_update')==='1'){reg.update().catch(function(){});}}catch(e){}
```

替换为统一门控：
```js
if(window.BK.shouldAllowNetworkRequest()) reg.update().catch(function(){});
```

**Step 2: 验证**

- 默认设置时，SW 注册后不调用 reg.update()
- 开启后，reg.update() 正常调用

**Step 3: Commit**

`git add src/static/index.html && git commit -m "refactor: gate reg.update with shouldAllowNetworkRequest"`

---

### Task 5: 门控 _silentCheckUpdate()

**Files:**
- Modify: `src/static/js/data-manager/dm-index.js`

**Step 1: 修改 _silentCheckUpdate 函数**

将当前的分散检查：
```js
try { if (localStorage.getItem('bk_auto_check_update') !== '1') return; } catch(e) {}
```

替换为统一门控：
```js
if (!window.BK.shouldAllowNetworkRequest()) return;
```

注意：`window` 在 dm-index.js 中通过 `win` 变量引用，需确认 `win.BK` 可用。如果不可用，使用 `window.BK`。

**Step 2: 验证**

- 默认设置时，索引加载后不静默检查 manifest.json
- 开启后，静默检查正常执行

**Step 3: Commit**

`git add src/static/js/data-manager/dm-index.js && git commit -m "refactor: gate _silentCheckUpdate with shouldAllowNetworkRequest"`

---

### Task 6: 门控赞助图探测

**Files:**
- Modify: `src/static/js/theme-toggle.js`

**Step 1: 修改 probeSponsor 函数**

将当前的分散检查：
```js
try { if (localStorage.getItem('bk_auto_check_update') !== '1') return; } catch(e) {}
```

替换为统一门控：
```js
if (!window.BK.shouldAllowNetworkRequest()) return;
```

**Step 2: 验证**

- 默认设置时，启动不探测赞助图
- 开启后，3 秒后正常探测

**Step 3: Commit**

`git add src/static/js/theme-toggle.js && git commit -m "refactor: gate sponsor probe with shouldAllowNetworkRequest"`

---

### Task 7: 门控 au-core.js init()

**Files:**
- Modify: `src/static/js/app-update/au-core.js`

**Step 1: 修改 init 函数**

将当前的分散检查逻辑重构为统一门控：

```js
init: function() {
    this.isCapacitor = window.Capacitor && window.Capacitor.isNativePlatform();
    if (!this.isCapacitor) return;
    console.log('[更新] 初始化更新模块');
    this.cleanupOldApks();

    if (window.BK && window.BK.shouldAllowNetworkRequest()) {
        this._configReady = this.loadConfig();
        var self = this;
        setTimeout(function() { AppUpdate.silentCheckUpdate(); }, 2000);
    } else {
        // 尝试从缓存读取版本号，不发网络请求
        var cached = null;
        try { cached = localStorage.getItem('bk_apk_version'); } catch(e) {}
        if (cached) this.config.currentVersion = cached;
        this._configReady = Promise.resolve();
    }
},
```

**Step 2: 验证**

- Capacitor 模式默认设置时，不 fetch app_config.json，不 silentCheckUpdate
- 开启后，正常加载配置和检查更新

**Step 3: Commit**

`git add src/static/js/app-update/au-core.js && git commit -m "refactor: gate au-core init with shouldAllowNetworkRequest"`

---

### Task 8: 添加手动检查更新入口

**Files:**
- Modify: `src/static/js/theme-toggle.js`（或设置页对应文件）

**Step 1: 在设置页"检查更新"按钮回调中使用 withNetworkAllowed**

找到现有的手动检查更新按钮回调，改为：

```js
// 手动检查更新——临时允许网络请求
if (window.BK && window.BK.withNetworkAllowed) {
    window.BK.withNetworkAllowed(function() {
        if (window.AppUpdate && window.AppUpdate.silentCheckUpdate) {
            return window.AppUpdate.silentCheckUpdate();
        }
        return Promise.resolve();
    });
}
```

**Step 2: 验证**

- 关闭自动检查更新后，点击"手动检查更新"按钮能正常联网检查
- 检查完成后 `_forceNetwork` 恢复为 false

**Step 3: Commit**

`git add src/static/js/theme-toggle.js && git commit -m "feat: add manual check update with withNetworkAllowed"`

---

### Task 9: 最终验证——全流程测试

**Step 1: 关闭自动检查更新（默认），启动应用**

- 打开浏览器 Network 面板
- 确认无外部 fetch/XHR/Image 请求（本地静态资源除外）
- SW 注册正常，但无 reg.update 调用

**Step 2: 开启自动检查更新，重启应用**

- 确认 version.json fetch 正常
- 确认赞助图探测正常
- 确认索引静默检查正常

**Step 3: 关闭自动检查更新，点击手动检查更新**

- 确认点击后能联网检查
- 确认检查完成后后续操作不自动联网

**Step 4: Commit**

`git add -A && git commit -m "test: verify zero-startup-network feature complete"`