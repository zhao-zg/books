---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '68b96e0b-8705-40ba-95eb-1249553cdf3c'
  PropagateID: '68b96e0b-8705-40ba-95eb-1249553cdf3c'
  ReservedCode1: '190dbdd0-58db-461f-8736-c9dc1dfe85ed'
  ReservedCode2: '190dbdd0-58db-461f-8736-c9dc1dfe85ed'
---

# 局域网同步 — 设计文档

> 日期：2026-08-31
> 状态：待评审
> 项目：书报（books）— Capacitor 移动阅读应用

## 1. 背景与目标

### 1.1 现状

跨设备同步功能已实现（ZIP 手动导出/导入），但操作流程是：

```
设备 A → 导出 ZIP → 手动传输文件（微信/邮件/U盘）→ 设备 B → 导入 ZIP
```

手动传输文件这一步繁琐，尤其频繁同步时体验差。

### 1.2 目标

在局域网内自动发现对端设备，一键完成同步数据传输，省掉手动文件传输环节：

```
设备 A → 启动同步服务 → 设备 B 自动发现 A → 一键拉取/推送
```

### 1.3 非目标

- 不做云端自动同步（用户已确认）
- 不做跨网络同步（仅限同一局域网）
- 不改动现有 sync-export / sync-import 合并逻辑

### 1.4 分层路线

| 阶段 | 覆盖场景 | 技术方案 |
|---|---|---|
| **Phase 1** | APK↔APK、APK↔PWA | NSD 自动发现 + HTTP Server（NanoHTTPD） |
| **Phase 2** | PWA↔PWA | WebRTC DataChannel + 二维码信令交换 |

**设计依据**：WebRTC 的不可替代价值只有一个——PWA↔PWA。APK↔APK 和 APK↔PWA 中 APK 端有原生能力开 HTTP 服务，PWA 端一个 fetch 就完事，无需绕道 WebRTC。两阶段共存不冲突。

## 2. 架构设计

### 2.1 核心思路

复用现有 ZIP 打包/合并管线，只替换「手动传输文件」环节为「HTTP 直传」。

```
                         ┌─────────────────────────────────┐
                         │   现有复用部分（不改动）          │
                         │                                   │
  sync-export.js ───────▶│  exportData → ZIP Uint8Array     │
                         │                                   │
  sync-import.js ◀──────│  importFromZip(ArrayBuffer)      │
                         └─────────────────────────────────┘
                                          ▲
                                          │
                                 ┌────────┴────────┐
                                 │  新增传输层       │
                                 │  (lan-sync.js)   │
                                 └────────┬────────┘
                                          │
                         ┌────────────────┴────────────────┐
                         │  APK: HTTP Server 插件（原生）    │
                         │  PWA: fetch 客户端（纯 JS）       │
                         └─────────────────────────────────┘
```

### 2.2 设备角色与场景矩阵

| 场景 | 服务端 | 客户端 | 发现方式 | Phase |
|---|---|---|---|---|
| APK ↔ APK | 任一端启动 HTTP Server | 另一端 fetch 连接 | NSD 自动发现 + 配对码 | Phase 1 |
| APK ↔ PWA | APK 端启动 Server | PWA 端 fetch 连接 | 二维码扫描 / 手动输入 IP + 配对码 | Phase 1 |
| PWA ↔ PWA | —（浏览器无法开端口） | — | WebRTC DataChannel + 二维码信令 | Phase 2 |

> **关键约束**：浏览器/PWA 无法监听 TCP 端口，所以 Phase 1 中 PWA 只能做客户端。Phase 2 用 WebRTC DataChannel 解决 PWA↔PWA，DataChannel 是浏览器间的 P2P 连接，不需要监听端口。

### 2.3 Phase 1 数据流（APK 端 HTTP Server）

**拉取模式（Pull）— 推荐默认**

```
设备 B（客户端）                     设备 A（服务端）
     │                                    │
     │  GET /info?code=xxx                │
     │ ─────────────────────────────────▶ │ → 返回 {name, books:[...]}
     │                                    │
     │  GET /download?code=xxx            │
     │     &mode=data&books=id1,id2       │
     │ ─────────────────────────────────▶ │ → exportData() → ZIP bytes
     │                                    │
     │        ZIP bytes (HTTP body)       │
     │ ◀───────────────────────────────── │
     │                                    │
     │  importFromZip(buffer)            │
     │  → 合并完成                         │
```

**推送模式（Push）**

```
设备 B（客户端）                     设备 A（服务端）
     │                                    │
     │  exportData() → ZIP bytes          │
     │                                    │
     │  POST /upload?code=xxx             │
     │  Body: ZIP bytes                   │
     │ ─────────────────────────────────▶ │ → importFromZip(buffer)
     │                                    │
     │        {success, failed}           │
     │ ◀───────────────────────────────── │
```

## 3. 技术方案

### 3.1 Capacitor HTTP Server 插件（Java 原生层）

**新增文件**：`android/app/src/main/java/com/books/app/LanSyncPlugin.java`

使用 [NanoHTTPD](https://github.com/NanoHttpd/nanohttpd)（单文件嵌入式 HTTP 服务器，~1500 行 Java）作为 HTTP 引擎。

#### 插件 API

```java
@NativePlugin("LanSync")
public class LanSyncPlugin implements Plugin {

    // 启动 HTTP Server，返回 {port, pairCode, ipAddress}
    @PluginMethod
    public void startServer(PluginCall call);

    // 停止 HTTP Server
    @PluginMethod
    public void stopServer(PluginCall call);

    // 获取服务状态
    @PluginMethod
    public void getStatus(PluginCall call);

    // 注册/注销 NSD 服务（mDNS 自动发现）
    @PluginMethod
    public void registerNsd(PluginCall call);

    @PluginMethod
    public void unregisterNsd(PluginCall call);
}
```

#### HTTP 端点

NanoHTTPD 在 `serve()` 中路由：

| 端点 | 方法 | 参数 | 返回 |
|---|---|---|---|
| `/info` | GET | `code` | JSON `{name, version, books:[{id,title}]}` |
| `/download` | GET | `code`, `mode=data\|full`, `books=id1,id2`(可选) | `application/zip` 二进制 |
| `/upload` | POST | `code` | JSON `{success, failed, errors}` |

#### 安全机制

1. **配对码**：6 位随机数字，服务端启动时生成，所有端点必校验
2. **局域网限制**：只接受私有 IP 段请求（`192.168.x.x` / `10.x.x.x` / `172.16-31.x.x` / `127.0.0.1`）
3. **自动关闭**：服务端 10 分钟无请求自动停止
4. **请求体大小限制**：上传/下载最大 50MB（含书完整包也够用）

#### 内部调用 JS 的桥梁

NanoHTTPD 运行在 Java 线程，需通过 `bridge.evaluateJs()` 回调到 WebView：

```java
// download 端点：调用 JS 侧 exportData 生成 ZIP
String js = "window.BK.LanSync._handleDownload('%s','%s')"; // mode, books
bridge.evaluateJs(js, result -> {
    // result 包含 base64 编码的 ZIP bytes
    // 作为 HTTP response 返回
});

// upload 端点：调用 JS 侧 importFromZip 处理收到的 ZIP
String js = "window.BK.LanSync._handleUpload('%s')"; // base64 ZIP
bridge.evaluateJs(js, result -> {
    // result 包含 {success, failed}
});
```

> **注意**：`evaluateJs` 是异步的，NanoHTTPD 需同步等待结果。用 `CountDownLatch` 或回调机制阻塞当前请求线程直到 JS 返回。

### 3.2 Android NSD 自动发现

使用 `NsdManager` 注册和发现服务：

```java
// 注册服务
NsdServiceInfo serviceInfo = new NsdServiceInfo();
serviceInfo.setServiceName("书报-设备A");
serviceInfo.setServiceType("_bk-sync._tcp.");
serviceInfo.setPort(port);
nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, registrationListener);

// 发现服务
nsdManager.discoverServices("_bk-sync._tcp.", NsdManager.PROTOCOL_DNS_SD, discoveryListener);
```

发现的设备列表通过事件通知前端：

```java
// 通过 evaluateJs 通知前端
String js = String.format("window.BK.LanSync._onDeviceFound('%s','%s',%d)",
    deviceName, ipAddress, port);
bridge.evaluateJs(js, null);
```

### 3.3 AndroidManifest 权限新增

```xml
<!-- 局域网同步 -->
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

### 3.4 前端模块：lan-sync.js

**新增文件**：`src/static/js/sync/lan-sync.js`

```javascript
(function (win) {
    'use strict';
    win.BK = win.BK || {};

    var LanSync = {
        // ── 服务端（APK only）──
        startServer: function () {
            // 调用 LanSyncPlugin.startServer()
            // 返回 {port, pairCode, ipAddress}
        },
        stopServer: function () { },
        getStatus: function () { },

        // ── 客户端（APK + PWA）──
        discover: function () {
            // APK: 调用 NSD 发现
            // PWA: 不可用，返回空
        },
        connect: function (ip, port, code) {
            // fetch GET /info?code=xxx
            // 返回对端设备信息
        },
        pull: function (ip, port, code, opts) {
            // opts: {mode:'data'|'full', books:[id1,id2]}
            // fetch GET /download → ArrayBuffer → importFromZip
        },
        push: function (ip, port, code, opts) {
            // exportData → Uint8Array → fetch POST /upload
        },

        // ── JS 桥梁（供 Java evaluateJs 调用）──
        _handleDownload: function (mode, books) {
            // 被 NanoHTTPD 调用：exportData → base64 返回
        },
        _handleUpload: function (base64Zip) {
            // 被 NanoHTTPD 调用：base64 → buffer → importFromZip
        },
        _onDeviceFound: function (name, ip, port) {
            // NSD 发现回调
        }
    };

    win.BK.LanSync = LanSync;
})(window);
```

#### 客户端 fetch 实现

```javascript
// 拉取
pull: function (ip, port, code, opts) {
    opts = opts || {};
    var mode = opts.mode || 'data';
    var booksParam = opts.books ? '&books=' + opts.books.join(',') : '';
    var url = 'http://' + ip + ':' + port + '/download?code=' + code + '&mode=' + mode + booksParam;

    return fetch(url)
        .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.arrayBuffer();
        })
        .then(function (buffer) {
            // 复用现有 sync-import 合并逻辑
            return win.BK.Sync.importFromZip(buffer);
        });
},

// 推送
push: function (ip, port, code, opts) {
    opts = opts || {};
    var mode = opts.mode || 'data';
    var bookIds = opts.books || [];

    // 复用现有 sync-export 打包逻辑，但不走 exportBinary 落地
    // 需要 exportData 返回 ZIP bytes 而非触发下载
    // → 新增 sync-export.generateZipBytes(bookIds, mode) 内部函数
    return _generateZipBytes(bookIds, mode).then(function (zipBytes) {
        var url = 'http://' + ip + ':' + port + '/upload?code=' + code;
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
            body: zipBytes
        }).then(function (res) { return res.json(); });
    });
}
```

#### sync-export.js 小重构

当前 `exportData()` 生成 ZIP 后直接调用 `exportBinary` 触发下载。需要拆出一个只生成 ZIP bytes 的内部函数：

```javascript
// 新增：只生成 ZIP bytes，不落地
function generateZipBytes(bookIds, mode) {
    // ... 现有打包逻辑 ...
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

// 现有 exportData 改为：
function exportData(bookIds, opts) {
    return generateZipBytes(bookIds, opts.mode).then(function (bytes) {
        // 走 exportBinary 落地
    });
}

// 暴露给 LanSync 调用
win.BK.Sync.generateZipBytes = generateZipBytes;
```

### 3.5 UI 设计

#### 「我的」页新增入口

在「内容与数据」section，现有 3 个同步按钮之后新增：

```html
<button class="bk-settings-row" data-action="lan-sync">
  <span class="bk-row-icon">📡</span>
  <span class="bk-row-label">局域网同步</span>
  <span class="bk-row-sub">自动发现 · 一键传输</span>
  <span class="bk-row-arrow">›</span>
</button>
```

#### 同步面板（全屏弹层）

```
┌─────────────────────────────────────┐
│  ← 局域网同步                        │
├─────────────────────────────────────┤
│                                       │
│  ┌─ 本机状态 ──────────────────────┐  │
│  │  设备名：书报-设备A              │  │
│  │  状态：  ● 服务运行中             │  │
│  │  配对码：1 2 3 4 5 6             │  │
│  │  地址：  192.168.10.5:18080     │  │
│  │  [启动服务]  [停止]              │  │
│  └─────────────────────────────────┘  │
│                                       │
│  ┌─ 可用设备 ─────────────────────┐  │
│  │  📱 书报-设备B  192.168.10.8   │  │
│  │     [拉取]  [推送]              │  │
│  │                                  │  │
│  │  📱 手动输入 IP...              │  │
│  └─────────────────────────────────┘  │
│                                       │
│  ┌─ 传输模式 ─────────────────────┐  │
│  │  ○ 仅数据（进度·书签·划线）     │  │
│  │  ○ 含书完整包（数据+书本体）    │  │
│  └─────────────────────────────────┘  │
│                                       │
│  ┌─ 传输日志 ─────────────────────┐  │
│  │  [10:30] 已连接 设备B            │  │
│  │  [10:30] 拉取 2 本书，完成       │  │
│  │  [10:31] 书签合并 5 条            │  │
│  └─────────────────────────────────┘  │
│                                       │
└─────────────────────────────────────┘
```

#### 交互流程

1. 用户点击「局域网同步」→ 打开面板
2. 服务端方：点击「启动服务」→ 生成配对码 → 显示在屏幕上
3. 客户端方：
   - APK：自动扫描 NSD → 设备列表显示 → 点击设备 → 输入配对码 → 连接
   - PWA / 手动：点击「手动输入 IP」→ 输入 `ip:port` + 配对码 → 连接
4. 连接成功后显示「拉取」「推送」按钮
5. 选择传输模式（仅数据 / 含书）
6. 点击拉取/推送 → 传输中显示进度 → 完成后提示合并结果

### 2.4 Phase 2 数据流（PWA↔PWA WebRTC）

**信令交换流程**

```
设备 A（PWA）                        设备 B（PWA）
     │                                     │
     │  RTCPeerConnection → createOffer   │
     │  → base64(SDP) → 二维码显示         │
     │  ────────── 屏幕显示 ───────────▶  │ 扫码获得 offer
     │                                     │  setRemoteDescription(offer)
     │                                     │  createAnswer → base64(SDP) → 二维码显示
     │  扫码获得 answer ◀──── 屏幕显示 ─── │
     │  setRemoteDescription(answer)     │
     │                                     │
     │  ════ WebRTC P2P 连接建立 ═══════   │
     │       DataChannel 双向传输          │
     │                                     │
     │  generateZipBytes → DataChannel → importFromZip
     │  ←── 合并结果 JSON ──              │
```

**关键技术点**：
- 同局域网无需 STUN/TURN，ICE 候选直接走 host candidate
- SDP 较大（~2-4KB），需用 LZ-String 压缩后编码到二维码
- DataChannel 创建后，传输逻辑与 Phase 1 完全一致：`generateZipBytes()` → 发送 → `importFromZip()`
- 双向传输：DataChannel 是双工的，一次连接同时支持推和拉

### 2.5 为什么两阶段共存而非二选一

| 维度 | NSD + HTTP（Phase 1） | WebRTC（Phase 2） |
|---|---|---|
| APK↔APK | 自动发现，体验最好 | 需二维码信令交换，反而绕 |
| APK↔PWA | APK 开服务，PWA 一个 fetch 搞定 | 仍需信令交换，收益为零 |
| PWA↔PWA | ❌ 不行 | ✅ 唯一可行方案 |
| 实现复杂度 | HTTP + CORS，简单可靠 | 信令协商 + WebView 兼容性验证 |
| 传输效率 | HTTP 请求/响应 | DataChannel 双工，但同步包 1-5KB 用不上 |

> **结论**：APK 端有原生能力时，NSD+HTTP 永远优于 WebRTC。WebRTC 只在 PWA↔PWA（两端都无原生能力）时才有不可替代价值。

### 3.7 CORS 与混合内容处理（PWA→APK 关键点）

PWA 部署在 HTTPS（GitHub Pages），fetch `http://192.168.x.x:port` 属于**混合内容（Mixed Content）**，浏览器默认拦截。

**对策**：NanoHTTPD 返回 CORS 响应头：
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Private-Network: true
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

**预检请求**：POST `/upload` 的 `Content-Type: application/zip` 会触发 OPTIONS 预检，NanoHTTPD 需在 `serve()` 中拦截 OPTIONS 方法直接返回 204 + CORS 头。

**兼容性**：Chrome 对 Private Network Access（PNA）的限制尚未强制执行（截至 2026 年仍为警告而非拦截），实测可行。若未来 PNA 强制，Phase 2 的 WebRTC 方案不受影响（DataChannel 不走 HTTP）。

## 4. 文件清单

### 4.1 新增文件

| 文件 | 位置 | 说明 |
|---|---|---|
| `LanSyncPlugin.java` | `android/app/src/main/java/com/books/app/` | Capacitor 插件：HTTP Server + NSD |
| `NanoHTTPD.java` | `android/app/src/main/java/com/books/app/` | 嵌入式 HTTP 服务器（vendored） |
| `lan-sync.js` | `src/static/js/sync/` | 前端同步 API |
| `lan-sync-panel.js` | `src/static/js/sync/` | 同步 UI 面板 |
| `lan-sync.css` | `src/static/css/` | 面板样式（内联到 index.html 也可） |
| `test-lan-sync.js` | `tests/ui/` | 单元测试 |

### 4.2 修改文件

| 文件 | 修改内容 |
|---|---|
| `MainActivity.java` | 注册 LanSyncPlugin |
| `AndroidManifest.xml` | 新增 3 个权限 |
| `src/static/index.html` | 加载 lan-sync.js + lan-sync-panel.js |
| `src/static/js/sync/sync-export.js` | 拆出 `generateZipBytes` 供 LanSync 调用 |
| `src/static/js/renderer/renderer-api.js` | 新增「局域网同步」按钮 + 面板调用 |
| `capacitor.config.json` | 无需修改（插件在 Java 层注册） |

### 4.3 三副本同步

| 副本 | 路径 | 说明 |
|---|---|---|
| 源码 | `src/static/js/sync/lan-sync.js` | git 跟踪 |
| 构建 | `output/js/sync/lan-sync.js` | .gitignore |
| Android | `android/app/src/main/assets/public/js/sync/lan-sync.js` | .gitignore |

Java 文件仅在 `android/` 目录，不在 output/ 中。

## 5. 技术风险与对策

### 5.1 NanoHTTPD evaluateJs 异步问题

**风险**：NanoHTTPD 在 Java 线程处理 HTTP 请求，需调用 `evaluateJs` 回到 WebView 执行 exportData/importFromZip，但 `evaluateJs` 是异步的，HTTP 请求需同步等待。

**对策**：使用 `CountDownLatch` + 超时机制：

```java
final CountDownLatch latch = new CountDownLatch(1);
final JSValue[] result = new JSValue[1];

bridge.evaluateJs(js, jsResult -> {
    result[0] = jsResult;
    latch.countDown();
});

if (!latch.await(30, TimeUnit.SECONDS)) {
    return newFixedLengthResponse(Response.Status.REQUEST_TIMEOUT, "text/plain", "timeout");
}
// 使用 result[0] 构造 HTTP 响应
```

### 5.2 大文件传输（含书完整包）

**风险**：含 PDF 的完整包可能达数十 MB，NanoHTTPD 默认将请求体加载到内存。

**对策**：
- 限制请求体 50MB
- NanoHTTPD 支持 `getInputStream()` 流式读取，可分块处理
- 实际使用中含书完整包同步是低频操作，主要走「仅数据」模式（1-5KB）

### 5.3 局域网安全

**风险**：HTTP Server 在局域网内可被其他设备访问。

**对策**（多层防护）：
1. 配对码（6 位）— 所有端点必校验
2. 私有 IP 段过滤 — 拒绝公网请求
3. 短时服务 — 10 分钟无活动自动关闭
4. 无持久化 — 服务停止后配对码失效
5. 不涉及敏感数据 — 同步的是阅读进度和笔记，非密码/财务

### 5.4 NSD 兼容性

**风险**：部分 Android 设备的 mDNS 实现有差异。

**对策**：
- NSD 作为增强体验，非必需
- 始终保留「手动输入 IP + 配对码」作为降级路径
- NSD 失败时静默降级，不报错

### 5.5 PWA 混合内容拦截

**风险**：PWA（HTTPS）fetch HTTP 端点，浏览器可能拦截混合内容。

**对策**：见 §3.7，NanoHTTPD 返回 CORS + PNA 头。若 Chrome 未来强制 PNA 拦截，PWA↔APK 降级为 ZIP 手动方案，PWA↔PWA 走 Phase 2 WebRTC。

### 5.6 WebRTC WebView 兼容性（Phase 2）

**风险**：Capacitor Android WebView 的 WebRTC DataChannel 支持需实测。

**对策**：
- DataChannel 不涉及音视频编解码器，只需 RTCDataChannel API，Chrome 内核一般支持
- Phase 2 开发前先写一个最小验证：两台设备 WebView 中 `new RTCPeerConnection()` + `createDataChannel()` + ICE 交换
- 若 WebView 不支持，PWA↔PWA 降级为 NAS WebSocket 中转或 ZIP 手动方案

## 6. 实施计划

### Phase 1：NSD + HTTP（覆盖 APK↔APK / APK↔PWA）

| 任务 | 内容 | 依赖 | 预计工作量 |
|---|---|---|---|
| T1 | sync-export.js 拆出 `generateZipBytes` 供 LanSync 调用 | 无 | 0.5h |
| T2 | LanSyncPlugin.java + NanoHTTPD.java（含 CORS 头） | 无 | 4h |
| T3 | lan-sync.js 客户端 API（connect/pull/push + CORS 处理） | T1, T2 | 2h |
| T4 | UI 面板（lan-sync-panel.js） | T3 | 3h |
| T5 | NSD 自动发现 | T2 | 2h |
| T6 | 二维码生成（服务端显示 IP+port+code） | T3 | 1h |
| T7 | 测试（单元 + 浏览器 + 真机） | T1-T6 | 2h |

### Phase 2：WebRTC DataChannel（覆盖 PWA↔PWA）

| 任务 | 内容 | 依赖 | 预计工作量 |
|---|---|---|---|
| T8 | WebRTC 兼容性验证（WebView 最小用例） | 无 | 1h |
| T9 | lan-sync-webrtc.js（信令交换 + DataChannel 传输） | T8 | 4h |
| T10 | 二维码信令交换 UI（SDP 压缩 → 二维码 → 扫码） | T9 | 3h |
| T11 | 测试（PWA↔PWA 真机） | T9, T10 | 2h |

### 后置增强（可选）

| 任务 | 内容 | 说明 |
|---|---|---|
| T12 | 自动同步检测 | 启动服务后自动检测对端是否有更新数据 |
| T13 | 双向同步 | 一次性完成双向数据交换（A→B + B→A） |

## 7. 验收标准

### Phase 1

1. **APK ↔ APK**：A 启动服务 → B 自动发现（NSD）→ 输入配对码 → 拉取数据 → 进度/书签/划线合并完成
2. **APK ↔ PWA**：APK 启动服务 → PWA 扫码/手输 IP + 配对码 → 拉取成功
3. **仅数据模式**：1-5KB ZIP，秒传完成
4. **含书模式**：正确传输 book.json + original.pdf
5. **配对码安全**：错误配对码返回 403
6. **自动关闭**：10 分钟无活动服务自动停止
7. **CORS**：PWA（HTTPS）→ APK（HTTP）fetch 不被拦截
8. **三副本同步**：src/output/android 哈希一致

### Phase 2

9. **PWA ↔ PWA**：A 生成二维码 → B 扫码建立 WebRTC → DataChannel 传输 ZIP → 合并完成
10. **WebView 兼容**：Capacitor WebView 中 `RTCPeerConnection` + `createDataChannel` 可用
11. **降级兼容**：PWA↔PWA 不可用时仍可走 ZIP 手动导出/导入

> AI生成