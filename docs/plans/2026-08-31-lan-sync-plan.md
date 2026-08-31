---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '64b62cc2-1b3c-4afa-bf78-206e75e8282d'
  PropagateID: '64b62cc2-1b3c-4afa-bf78-206e75e8282d'
  ReservedCode1: 'b3fe8b9d-9957-43a4-9c77-ac5f2a0e2934'
  ReservedCode2: 'b3fe8b9d-9957-43a4-9c77-ac5f2a0e2934'
---

# 局域网同步 (Phase 1) Implementation Plan

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement.
> Watch it pass. Commit after each green test.
>
> **Test harness fidelity:** After creating any new JS file, you MUST register it in
> `index.html` `<script>` tags AND `__bkCoreUrls` array, or it will be undefined in production.
> Then sync 3 copies (src → output → android assets).

**Goal:** Implement LAN-based sync (Phase 1: NSD + HTTP Server) covering APK↔APK and APK↔PWA scenarios.

**Architecture:** APK starts an embedded HTTP server (NanoHTTPD via Capacitor plugin). PWA/APK client uses `fetch` to pull/push ZIP sync packages. NSD auto-discovery for APK↔APK. Reuses existing `generateZipBytes` / `importFromZip` pipeline; only replaces the manual file-transfer step with HTTP direct transfer.

**Tech Stack:** Capacitor 6, NanoHTTPD 2.3.1 (Maven), NsdManager (Android SDK), JSZip, fetch API, node:test + JSDOM for testing.

---

## Task Dependency Graph

```
T1 (generateZipBytes) ────────┐
                               ├──▶ T3 (lan-sync.js) ──▶ T4 (UI panel) ──┐
T2 (Java plugin) ─────────────┘                                        ├──▶ T7 (integration)
                                   T5 (NSD) ──▶ T2 ──┘                  │
                                   T6 (QR code) ──▶ T3 ────────────────┘
```

T1 and T2 are independent and can be developed in parallel. T3 depends on T1. T4 depends on T3. T5 extends T2. T6 is standalone JS. T7 is final integration.

---

## Task T1: Extract `generateZipBytes` from sync-export.js

**Files:**
- Modify: `src/static/js/sync/sync-export.js`
- Modify: `tests/ui/test-sync-export.js`

**Why:** LanSync push mode needs ZIP bytes without triggering file download. Current `exportData()` couples ZIP generation with `exportBinary` download. Extract the generation part into a standalone function.

### Step 1: Write the failing test

Append to `tests/ui/test-sync-export.js` (before the closing of the describe block, or as a new test):

```javascript
test('generateZipBytes 返回 Uint8Array 且可被 JSZip 解压', async () => {
    // 准备：mock shelf + localStorage 数据
    win.BKShelf = { all: function () { return [{ bookId: 'book1', title: '测试书1' }]; } };
    win.localStorage.setItem('bk_progress:book1', '50');
    win.localStorage.setItem('bk_lastread_ts:book1', '1700000000000');

    assert.ok(win.BK.Sync.generateZipBytes, 'generateZipBytes 应已暴露');
    var bytes = await win.BK.Sync.generateZipBytes(['book1'], { mode: 'data' });

    assert.ok(bytes instanceof Uint8Array, '应返回 Uint8Array');
    assert.ok(bytes.length > 0, 'ZIP 不应为空');

    // 验证 ZIP 内容结构
    var zip = await win.JSZip.loadAsync(bytes);
    assert.ok(zip.file('manifest.json'), '应含 manifest.json');
    assert.ok(zip.file('shelf.json'), '应含 shelf.json');
    assert.ok(zip.folder('books'), '应含 books/ 文件夹');

    var manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    assert.strictEqual(manifest.version, 3);
    assert.strictEqual(manifest.type, 'sync-data');
    assert.strictEqual(manifest.bookCount, 1);
});

test('exportData 仍然正常工作（回归测试）', async () => {
    win.BKShelf = { all: function () { return [{ bookId: 'book1', title: '测试书1' }]; } };
    win.localStorage.setItem('bk_progress:book1', '50');
    // mock exportBinary 避免实际下载
    var exportedBytes = null;
    win.BK.Export = { exportBinary: function (bytes, name, mime, opts) {
        exportedBytes = bytes;
        return Promise.resolve({});
    }};

    await win.BK.Sync.exportData(['book1'], { mode: 'data' });
    assert.ok(exportedBytes instanceof Uint8Array, 'exportData 仍应通过 exportBinary 落地');
    assert.ok(exportedBytes.length > 0, '导出的 ZIP 不应为空');
});
```

### Step 2: Run test — confirm it fails

```
Command: node --test tests/ui/test-sync-export.js
Expected: FAIL — "generateZipBytes 应已暴露" (win.BK.Sync.generateZipBytes is undefined)
```

### Step 3: Write minimal implementation

In `src/static/js/sync-export.js`, refactor `exportData`:

**Replace** the main `exportData` function (lines ~206-314) with:

```javascript
    /**
     * 生成 ZIP bytes（不落地）— 供 LanSync push 模式调用
     * @param {string[]} bookIds  要导出的书籍 ID 列表
     * @param {Object}   [opts]
     *   - {string} mode  'data'（仅用户数据）或 'full'（含书籍正文）
     * @returns {Promise<Uint8Array>} ZIP bytes
     */
    function generateZipBytes(bookIds, opts) {
        opts = opts || {};
        var mode = opts.mode || 'data';

        var JSZip = win.JSZip;
        if (!JSZip) return Promise.reject(new Error('JSZip 未加载，无法打包同步数据'));

        if (!bookIds || !bookIds.length) {
            return Promise.reject(new Error('未选择任何书籍'));
        }

        console.log('[BK.Sync] generateZipBytes: 开始打包 ' + bookIds.length + ' 本书（mode=' + mode + '）');
        var t0 = Date.now();

        // 预取全量书签和高亮
        var bookmarksPromise = (win.BKBookmark && typeof win.BKBookmark.getAll === 'function')
            ? win.BKBookmark.getAll().catch(function () { return []; })
            : Promise.resolve([]);
        var highlightsPromise = (win.BKStorage && typeof win.BKStorage.getAllPages === 'function')
            ? win.BKStorage.getAllPages().catch(function () { return []; })
            : Promise.resolve([]);

        return Promise.all([bookmarksPromise, highlightsPromise]).then(function (results) {
            var allBookmarks = results[0] || [];
            var allPages = results[1] || [];

            var zip = new JSZip();
            var booksFolder = zip.folder('books');

            var chain = Promise.resolve();
            for (var i = 0; i < bookIds.length; i++) {
                (function (bookId) {
                    chain = chain.then(function () {
                        var bookFolder = booksFolder.folder(bookId);
                        var userData = _buildUserData(bookId, allBookmarks, allPages);
                        bookFolder.file('userdata.json', JSON.stringify(userData, null, 2));

                        if (mode !== 'full') return;
                        return _getBookData(bookId).then(function (bookData) {
                            if (!bookData) {
                                console.warn('[BK.Sync] generateZipBytes: 书籍数据未找到，跳过 book.json id=' + bookId);
                                return;
                            }
                            var exportData = JSON.parse(JSON.stringify(bookData));
                            bookFolder.file('book.json', JSON.stringify(exportData, null, 2));
                            if (_isPdfBookData(bookData)) {
                                return _getPdfData(bookId).then(function (pdfData) {
                                    if (pdfData) bookFolder.file('original.pdf', pdfData);
                                });
                            }
                        });
                    });
                })(bookIds[i]);
            }

            return chain.then(function () {
                var shelfData = [];
                if (win.BKShelf && typeof win.BKShelf.all === 'function') {
                    shelfData = win.BKShelf.all();
                }
                zip.file('shelf.json', JSON.stringify(shelfData, null, 2));

                var manifest = {
                    version: MANIFEST_VERSION,
                    type: SYNC_TYPE,
                    exportDate: new Date().toISOString(),
                    bookCount: bookIds.length
                };
                zip.file('manifest.json', JSON.stringify(manifest, null, 2));

                console.log('[BK.Sync] generateZipBytes: 打包完成，开始生成 ZIP...');
                return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
            });
        }).then(function (bytes) {
            console.log('[BK.Sync] generateZipBytes: ZIP 生成完成，大小=' + (bytes.length / 1024).toFixed(2) +
                'KB，总耗时 ' + (Date.now() - t0) + 'ms');
            return bytes;
        });
    }

    /**
     * 导出同步数据 ZIP（走 exportBinary 落地）
     * @param {string[]} bookIds  要导出的书籍 ID 列表
     * @param {Object}   [opts]
     *   - {string} mode  'data'（仅用户数据）或 'full'（含书籍正文）
     * @returns {Promise}
     */
    function exportData(bookIds, opts) {
        return generateZipBytes(bookIds, opts).then(function (bytes) {
            var date = new Date();
            var dateStr = date.getFullYear() + '-' +
                ('0' + (date.getMonth() + 1)).slice(-2) + '-' +
                ('0' + date.getDate()).slice(-2);
            var filename = 'bk-sync-export-' + dateStr + '.zip';

            if (win.BK && win.BK.Export && win.BK.Export.exportBinary) {
                return win.BK.Export.exportBinary(bytes, filename, 'application/zip', {
                    chooseDestination: true,
                    successMsg: '已导出同步数据'
                });
            }
            return _fallbackBinaryDownload(bytes, filename, 'application/zip');
        });
    }
```

**Update** the export section at the bottom:

```javascript
    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.Sync = win.BK.Sync || {};
    win.BK.Sync.exportData = exportData;
    win.BK.Sync.generateZipBytes = generateZipBytes;  // ← 新增
```

### Step 4: Run test — confirm it passes

```
Command: node --test tests/ui/test-sync-export.js
Expected: PASS — all tests green (existing 16 + 2 new = 18)
```

### Step 5: Sync 3 copies + commit

```powershell
# Sync to output and android assets
Copy-Item src\static\js\sync\sync-export.js output\js\sync\sync-export.js -Force
Copy-Item src\static\js\sync\sync-export.js android\app\src\main\assets\public\js\sync\sync-export.js -Force

# Verify hash consistency
(Get-FileHash src\static\js\sync\sync-export.js).Hash
(Get-FileHash output\js\sync\sync-export.js).Hash
(Get-FileHash android\app\src\main\assets\public\js\sync\sync-export.js).Hash

# Commit
git add src/static/js/sync/sync-export.js
git add -f tests/ui/test-sync-export.js
git commit -m "feat(sync): extract generateZipBytes for LanSync push mode"
```

---

## Task T2: Capacitor Plugin — LanSyncPlugin.java + NanoHTTPD

**Files:**
- Create: `android/app/src/main/java/com/books/app/LanSyncPlugin.java`
- Modify: `android/app/build.gradle` — add NanoHTTPD Maven dependency
- Modify: `android/app/src/main/AndroidManifest.xml` — add 3 permissions
- Modify: `android/app/src/main/java/com/books/app/MainActivity.java` — register plugin

**Why:** APK needs an embedded HTTP server to receive pull/push requests from other devices. NanoHTTPD is a lightweight single-dependency HTTP server. The plugin exposes start/stop/status to JS via Capacitor, and routes `/info`, `/download`, `/upload` HTTP endpoints.

> **Note:** This is a Java-only task. No JS unit tests. Verification = compilation + code structure review. JS bridge functions are tested in T3.

### Step 1: Add Maven dependency

In `android/app/build.gradle`, inside the `dependencies { }` block, add:

```gradle
    // 局域网同步：嵌入式 HTTP 服务器
    implementation 'org.nanohttpd:nanohttpd:2.3.1'
```

### Step 2: Add Android permissions

In `android/app/src/main/AndroidManifest.xml`, after the `INTERNET` permission (line 5), add:

```xml
    <!-- 局域网同步：NSD 自动发现 + 网络状态 -->
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

### Step 3: Write LanSyncPlugin.java

Create `android/app/src/main/java/com/books/app/LanSyncPlugin.java`:

```java
package com.books.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;

import org.nanohttpd.NanoHTTPD;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.InetAddress;
import java.util.HashMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * LanSyncPlugin — 局域网同步 Capacitor 插件
 *
 * 启动嵌入式 HTTP Server（NanoHTTPD），提供 /info、/download、/upload 端点。
 * 通过 evaluateJs 调用 JS 侧的 exportData/importFromZip，用 CountDownLatch 同步等待。
 *
 * 安全：配对码校验 + 私有 IP 过滤 + 10 分钟无活动自动关闭。
 */
public class LanSyncPlugin extends Plugin {

    private static final String TAG = "LanSyncPlugin";
    private static final int DEFAULT_PORT = 18080;
    private static final int MAX_IDLE_MINUTES = 10;
    private static final int JS_TIMEOUT_SECONDS = 30;
    private static final int MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB

    private SyncServer server;
    private String pairCode;
    private volatile long lastRequestTime;

    // JS 桥梁：requestId → CountDownLatch + 结果
    private final ConcurrentHashMap<String, CountDownLatch> pendingLatches = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> pendingResults = new ConcurrentHashMap<>();

    // NSD 注册监听器（T5 实现）
    private Object nsdRegistrationListener; // NsdManager.RegistrationListener

    // ── 插件方法 ──────────────────────────────────────────────────────────

    @PluginMethod
    public void startServer(PluginCall call) {
        if (server != null) {
            JSObject ret = new JSObject();
            ret.put("port", server.getListeningPort());
            ret.put("pairCode", pairCode);
            ret.put("ipAddress", getLocalIpAddress());
            call.resolve(ret);
            return;
        }

        try {
            pairCode = generatePairCode();
            int port = call.getInt("port", DEFAULT_PORT);

            server = new SyncServer(port);
            server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
            lastRequestTime = System.currentTimeMillis();

            JSObject ret = new JSObject();
            ret.put("port", server.getListeningPort());
            ret.put("pairCode", pairCode);
            ret.put("ipAddress", getLocalIpAddress());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to start server: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopServer(PluginCall call) {
        if (server != null) {
            server.stop();
            server = null;
        }
        unregisterNsdInternal();
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", server != null && server.isAlive());
        if (server != null) {
            ret.put("port", server.getListeningPort());
            ret.put("pairCode", pairCode);
            ret.put("ipAddress", getLocalIpAddress());
            long idleSeconds = (System.currentTimeMillis() - lastRequestTime) / 1000;
            ret.put("idleSeconds", idleSeconds);
        }
        call.resolve(ret);
    }

    /**
     * JS 桥回调：JS 处理完成后调用此方法，唤醒等待的 HTTP 线程
     */
    @PluginMethod
    public void deliverResult(PluginCall call) {
        String requestId = call.getString("requestId", "");
        String data = call.getString("data", "");

        pendingResults.put(requestId, data);
        CountDownLatch latch = pendingLatches.get(requestId);
        if (latch != null) {
            latch.countDown();
        }
        call.resolve();
    }

    @PluginMethod
    public void registerNsd(PluginCall call) {
        // T5 实现
        call.resolve();
    }

    @PluginMethod
    public void unregisterNsd(PluginCall call) {
        unregisterNsdInternal();
        call.resolve();
    }

    // ── NSD 内部 ──────────────────────────────────────────────────────────

    private void unregisterNsdInternal() {
        // T5 实现
    }

    // ── HTTP Server ────────────────────────────────────────────────────────

    /**
     * NanoHTTPD 子类：路由 /info、/download、/upload
     */
    private class SyncServer extends NanoHTTPD {

        SyncServer(int port) {
            super(port);
        }

        @Override
        public Response serve(IHTTPSession session) {
            lastRequestTime = System.currentTimeMillis();

            // CORS 预检
            if (session.getMethod() == Method.OPTIONS) {
                Response r = newFixedLengthResponse(Response.Status.OK, "text/plain", "");
                addCorsHeaders(r);
                return r;
            }

            String uri = session.getUri();
            HashMap<String, String> params = new HashMap<>(session.getParameters());

            // 配对码校验
            String code = params.get("code");
            if (code == null || !code.equals(pairCode)) {
                Response r = newFixedLengthResponse(Response.Status.FORBIDDEN, "application/json",
                    "{\"error\":\"invalid_code\"}");
                addCorsHeaders(r);
                return r;
            }

            // 私有 IP 过滤
            if (!isPrivateIp(session.getRemoteHostName())) {
                Response r = newFixedLengthResponse(Response.Status.FORBIDDEN, "application/json",
                    "{\"error\":\"forbidden_network\"}");
                addCorsHeaders(r);
                return r;
            }

            try {
                if (uri.equals("/info")) {
                    return handleInfo();
                } else if (uri.equals("/download")) {
                    return handleDownload(params.get("mode"), params.get("books"));
                } else if (uri.equals("/upload")) {
                    return handleUpload(session);
                } else {
                    Response r = newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json",
                        "{\"error\":\"not_found\"}");
                    addCorsHeaders(r);
                    return r;
                }
            } catch (Exception e) {
                Response r = newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                    "{\"error\":\"" + e.getMessage() + "\"}");
                addCorsHeaders(r);
                return r;
            }
        }

        // ── 端点处理 ─────────────────────────────────────────────────

        private Response handleInfo() throws Exception {
            String requestId = UUID.randomUUID().toString();
            String result = callJsAndWait("info", requestId, "window.BK.LanSync._handleInfo('" + requestId + "')");

            Response r = newFixedLengthResponse(Response.Status.OK, "application/json", result);
            addCorsHeaders(r);
            return r;
        }

        private Response handleDownload(String mode, String books) throws Exception {
            String requestId = UUID.randomUUID().toString();
            String js = String.format(
                "window.BK.LanSync._handleDownload('%s','%s','%s')",
                mode != null ? mode : "data",
                books != null ? books : "",
                requestId
            );
            String base64 = callJsAndWait("download", requestId, js);

            byte[] zipBytes = android.util.Base64.decode(base64, android.util.Base64.NO_WRAP);
            InputStream is = new ByteArrayInputStream(zipBytes);
            Response r = newFixedLengthResponse(Response.Status.OK, "application/zip", is, zipBytes.length);
            addCorsHeaders(r);
            return r;
        }

        private Response handleUpload(IHTTPSession session) throws Exception {
            // 读取请求体
            int contentLength = Integer.parseInt(
                session.getHeaders().getOrDefault("content-length", "0"));
            if (contentLength > MAX_BODY_SIZE) {
                Response r = newFixedLengthResponse(Response.Status.PAYLOAD_TOO_LARGE, "application/json",
                    "{\"error\":\"body_too_large\"}");
                addCorsHeaders(r);
                return r;
            }

            // NanoHTTPD 将 body 存入 files map
            HashMap<String, String> files = new HashMap<>();
            session.parseBody(files);
            String tmpFilePath = files.get("files"); // NanoHTTPD 临时文件路径

            // 读取临时文件为 byte[]
            java.nio.file.Path tmpPath = java.nio.file.Paths.get(tmpFilePath);
            byte[] zipBytes = java.nio.file.Files.readAllBytes(tmpPath);

            // 转 base64 传给 JS
            String base64 = android.util.Base64.encodeToString(zipBytes, android.util.Base64.NO_WRAP);
            String requestId = UUID.randomUUID().toString();
            String js = String.format(
                "window.BK.LanSync._handleUpload('%s','%s')",
                base64, requestId
            );
            String resultJson = callJsAndWait("upload", requestId, js);

            Response r = newFixedLengthResponse(Response.Status.OK, "application/json", resultJson);
            addCorsHeaders(r);
            return r;
        }

        // ── JS 桥梁 ─────────────────────────────────────────────────

        /**
         * 调用 JS 并等待结果（CountDownLatch 同步）
         */
        private String callJsAndWait(String tag, String requestId, String js) throws Exception {
            CountDownLatch latch = new CountDownLatch(1);
            pendingLatches.put(requestId, latch);

            bridge.evaluateJs(js, null);

            if (!latch.await(JS_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                pendingLatches.remove(requestId);
                pendingResults.remove(requestId);
                throw new Exception("JS timeout: " + tag);
            }

            pendingLatches.remove(requestId);
            return pendingResults.remove(requestId);
        }

        // ── CORS ─────────────────────────────────────────────────────

        private void addCorsHeaders(Response r) {
            r.setChunkedTransfer(false);
            r.addHeader("Access-Control-Allow-Origin", "*");
            r.addHeader("Access-Control-Allow-Private-Network", "true");
            r.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            r.addHeader("Access-Control-Allow-Headers", "Content-Type");
        }
    }

    // ── 工具方法 ──────────────────────────────────────────────────────────

    private static String generatePairCode() {
        java.util.Random rnd = new java.security.SecureRandom();
        int code = 100000 + rnd.nextInt(900000);
        return String.valueOf(code);
    }

    private static String getLocalIpAddress() {
        try {
            return InetAddress.getLocalHost().getHostAddress();
        } catch (Exception e) {
            return "unknown";
        }
    }

    private static boolean isPrivateIp(String host) {
        if (host == null) return false;
        try {
            InetAddress addr = InetAddress.getByName(host);
            return addr.isSiteLocalAddress() || addr.isLoopbackAddress();
        } catch (Exception e) {
            return false;
        }
    }
}
```

### Step 4: Register plugin in MainActivity.java

In `android/app/src/main/java/com/books/app/MainActivity.java`, after line 44 (`registerPlugin(SaveFilePlugin.class);`), add:

```java
        registerPlugin(LanSyncPlugin.class);
```

### Step 5: Verify compilation

```powershell
Command: cd android; .\gradlew assembleDebug
Expected: BUILD SUCCESSFUL (no compilation errors)
```

If the build is too slow for iteration, at minimum verify Java syntax:
```powershell
Command: cd android; .\gradlew compileDebugJavaWithJavac
Expected: BUILD SUCCESSFUL
```

### Step 6: Commit

```powershell
git add android/app/build.gradle android/app/src/main/AndroidManifest.xml
git add android/app/src/main/java/com/books/app/LanSyncPlugin.java
git add android/app/src/main/java/com/books/app/MainActivity.java
git commit -m "feat(lan-sync): LanSyncPlugin with NanoHTTPD HTTP server + CORS"
```

---

## Task T3: lan-sync.js — Client API + JS Bridge Functions

**Files:**
- Create: `src/static/js/sync/lan-sync.js`
- Create: `tests/ui/test-lan-sync.js`

**Why:** This module provides the JS interface for LanSync: client-side `connect`/`pull`/`push` (used by both APK and PWA) and server-side bridge functions `_handleInfo`/`_handleDownload`/`_handleUpload` (called by Java's NanoHTTPD via evaluateJs).

### Step 1: Write the failing test

Create `tests/ui/test-lan-sync.js`:

```javascript
'use strict';
/**
 * lan-sync 纯逻辑单元测试（node:test + JSDOM）
 *
 * 被测目标：src/static/js/sync/lan-sync.js 暴露的
 *   win.BK.LanSync.connect / pull / push / _handleInfo / _handleDownload / _handleUpload
 *
 * 加载方式：JSDOM + vm.runInThisContext
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

// ── 构造 JSDOM 环境 ─────────────────────────────────────────────────────
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.win = dom.window;

// ── 加载真正的 JSZip ─────────────────────────────────────────────────────
const jszipPath = join(__dirname, '..', '..', 'src', 'static', 'vendor', 'jszip.min.js');
const jszipCode = readFileSync(jszipPath, 'utf-8');
vm.runInThisContext(jszipCode, { filename: jszipPath, displayErrors: true });

// ── Mock 依赖 ───────────────────────────────────────────────────────────
function setupMocks() {
    win.BK = win.BK || {};
    win.BK.Sync = win.BK.Sync || {};

    // mock generateZipBytes
    win.BK.Sync.generateZipBytes = function (bookIds, opts) {
        var zip = new win.JSZip();
        zip.file('manifest.json', JSON.stringify({ version: 3, type: 'sync-data', bookCount: bookIds.length }));
        zip.file('shelf.json', '[]');
        return zip.generateAsync({ type: 'uint8array' });
    };

    // mock importFromZip
    win.BK.Sync.importFromZip = function (buffer) {
        return Promise.resolve({ success: 2, failed: 0, errors: [] });
    };

    // mock BKShelf
    win.BKShelf = {
        all: function () {
            return [
                { bookId: 'book1', title: '测试书1' },
                { bookId: 'book2', title: '测试书2' }
            ];
        }
    };

    // mock Capacitor
    win.Capacitor = {
        Plugins: {
            LanSync: {
                startServer: function (opts) {
                    return Promise.resolve({ port: 18080, pairCode: '123456', ipAddress: '192.168.1.5' });
                },
                stopServer: function () { return Promise.resolve(); },
                getStatus: function () { return Promise.resolve({ running: true }); },
                deliverResult: function (opts) { return Promise.resolve(); },
                registerNsd: function () { return Promise.resolve(); },
                unregisterNsd: function () { return Promise.resolve(); }
            }
        }
    };

    // mock fetch
    win._fetchCalls = [];
    win.fetch = function (url, opts) {
        win._fetchCalls.push({ url: url, opts: opts });
        // 默认返回 /info 的响应
        if (url.indexOf('/info') > -1) {
            return Promise.resolve({
                ok: true,
                json: function () { return Promise.resolve({ name: '设备B', version: '1.0', books: [{ id: 'b1', title: '书B' }] }); }
            });
        }
        if (url.indexOf('/download') > -1) {
            // 返回一个最小 ZIP
            var zip = new win.JSZip();
            zip.file('manifest.json', '{"version":3,"type":"sync-data","bookCount":1}');
            zip.file('shelf.json', '[]');
            zip.folder('books').folder('b1').file('userdata.json', '{"progress":"50"}');
            return zip.generateAsync({ type: 'arraybuffer' }).then(function (buf) {
                return { ok: true, arrayBuffer: function () { return Promise.resolve(buf); } };
            });
        }
        if (url.indexOf('/upload') > -1) {
            return Promise.resolve({
                ok: true,
                json: function () { return Promise.resolve({ success: 2, failed: 0, errors: [] }); }
            });
        }
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
    };

    // mock btoa/atob
    win.btoa = function (str) { return Buffer.from(str, 'binary').toString('base64'); };
    win.atob = function (b64) { return Buffer.from(b64, 'base64').toString('binary'); };
}

// ── 加载被测模块 ───────────────────────────────────────────────────────
function loadModule() {
    var srcPath = join(__dirname, '..', '..', 'src', 'static', 'js', 'sync', 'lan-sync.js');
    var code = readFileSync(srcPath, 'utf-8');
    vm.runInThisContext(code, { filename: srcPath, displayErrors: true });
}

describe('lan-sync.js', () => {
    beforeEach(() => {
        setupMocks();
        loadModule();
    });

    test('模块正确挂载到 win.BK.LanSync', () => {
        assert.ok(win.BK.LanSync, 'BK.LanSync 应存在');
        assert.strictEqual(typeof win.BK.LanSync.connect, 'function');
        assert.strictEqual(typeof win.BK.LanSync.pull, 'function');
        assert.strictEqual(typeof win.BK.LanSync.push, 'function');
        assert.strictEqual(typeof win.BK.LanSync._handleInfo, 'function');
        assert.strictEqual(typeof win.BK.LanSync._handleDownload, 'function');
        assert.strictEqual(typeof win.BK.LanSync._handleUpload, 'function');
    });

    test('isAvailable 检测 Capacitor 环境', () => {
        assert.strictEqual(win.BK.LanSync.isAvailable(), true);
        // PWA 环境无 Capacitor
        var savedCapacitor = win.Capacitor;
        delete win.Capacitor;
        assert.strictEqual(win.BK.LanSync.isAvailable(), false);
        win.Capacitor = savedCapacitor;
    });

    test('connect 调用 GET /info 并返回设备信息', async () => {
        var info = await win.BK.LanSync.connect('192.168.1.5', 18080, '123456');
        assert.strictEqual(info.name, '设备B');
        assert.ok(info.books.length > 0);
        assert.strictEqual(info.books[0].id, 'b1');
        // 验证 URL 格式
        assert.ok(win._fetchCalls[0].url.indexOf('http://192.168.1.5:18080/info') === 0);
        assert.ok(win._fetchCalls[0].url.indexOf('code=123456') > -1);
    });

    test('connect 错误配对码返回 403 时抛异常', async () => {
        win.fetch = function () {
            return Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' });
        };
        await assert.rejects(
            win.BK.LanSync.connect('192.168.1.5', 18080, 'wrong'),
            /403/
        );
    });

    test('pull 调用 GET /download 并调用 importFromZip', async () => {
        var savedImport = win.BK.Sync.importFromZip;
        var importCalled = false;
        var importedBuffer = null;
        win.BK.Sync.importFromZip = function (buffer) {
            importCalled = true;
            importedBuffer = buffer;
            return Promise.resolve({ success: 1, failed: 0, errors: [] });
        };

        var result = await win.BK.LanSync.pull('192.168.1.5', 18080, '123456', { mode: 'data' });
        assert.ok(importCalled, '应调用 importFromZip');
        assert.ok(importedBuffer instanceof ArrayBuffer, '传给 importFromZip 的应为 ArrayBuffer');
        assert.strictEqual(result.success, 1);

        win.BK.Sync.importFromZip = savedImport;
    });

    test('pull 支持 mode=full 参数', async () => {
        await win.BK.LanSync.pull('192.168.1.5', 18080, '123456', { mode: 'full' });
        assert.ok(win._fetchCalls[win._fetchCalls.length - 1].url.indexOf('mode=full') > -1);
    });

    test('push 调用 generateZipBytes + POST /upload', async () => {
        var savedGen = win.BK.Sync.generateZipBytes;
        var genCalled = false;
        win.BK.Sync.generateZipBytes = function (bookIds, opts) {
            genCalled = true;
            assert.strictEqual(opts.mode, 'data');
            return savedGen(bookIds, opts);
        };

        var result = await win.BK.LanSync.push('192.168.1.5', 18080, '123456', { mode: 'data' });
        assert.ok(genCalled, '应调用 generateZipBytes');
        assert.strictEqual(result.success, 2);

        var uploadCall = win._fetchCalls.find(function (c) { return c.url.indexOf('/upload') > -1; });
        assert.ok(uploadCall, '应有 /upload fetch 调用');
        assert.strictEqual(uploadCall.opts.method, 'POST');
        assert.strictEqual(uploadCall.opts.headers['Content-Type'], 'application/zip');
        assert.ok(uploadCall.opts.body instanceof Uint8Array, 'POST body 应为 Uint8Array');

        win.BK.Sync.generateZipBytes = savedGen;
    });

    test('_handleInfo 返回设备信息 JSON 并调用 deliverResult', async () => {
        var delivered = null;
        win.Capacitor.Plugins.LanSync.deliverResult = function (opts) {
            delivered = opts;
            return Promise.resolve();
        };

        await win.BK.LanSync._handleInfo('req-001');
        assert.ok(delivered, '应调用 deliverResult');
        assert.strictEqual(delivered.requestId, 'req-001');
        var info = JSON.parse(delivered.data);
        assert.ok(info.name, 'info 应含 name');
        assert.ok(info.books, 'info 应含 books');
        assert.strictEqual(info.books.length, 2);
    });

    test('_handleDownload 生成 ZIP base64 并调用 deliverResult', async () => {
        var delivered = null;
        win.Capacitor.Plugins.LanSync.deliverResult = function (opts) {
            delivered = opts;
            return Promise.resolve();
        };

        await win.BK.LanSync._handleDownload('data', '', 'req-002');
        assert.ok(delivered, '应调用 deliverResult');
        assert.strictEqual(delivered.requestId, 'req-002');
        assert.ok(delivered.data.length > 0, 'data 应为非空 base64');
        // 验证 base64 可解码为有效 ZIP
        var bytes = new Uint8Array(Buffer.from(delivered.data, 'base64'));
        var zip = await win.JSZip.loadAsync(bytes);
        assert.ok(zip.file('manifest.json'), 'ZIP 应含 manifest.json');
    });

    test('_handleUpload 解码 base64 并调用 importFromZip', async () => {
        var importCalled = false;
        win.BK.Sync.importFromZip = function (buffer) {
            importCalled = true;
            assert.ok(buffer instanceof ArrayBuffer, '应为 ArrayBuffer');
            return Promise.resolve({ success: 2, failed: 0, errors: [] });
        };

        var delivered = null;
        win.Capacitor.Plugins.LanSync.deliverResult = function (opts) {
            delivered = opts;
            return Promise.resolve();
        };

        // 构造一个最小 ZIP 的 base64
        var zip = new win.JSZip();
        zip.file('manifest.json', '{"version":3,"type":"sync-data","bookCount":1}');
        zip.file('shelf.json', '[]');
        var bytes = await zip.generateAsync({ type: 'uint8array' });
        var base64 = win.btoa(String.fromCharCode.apply(null, bytes));

        await win.BK.LanSync._handleUpload(base64, 'req-003');
        assert.ok(importCalled, '应调用 importFromZip');
        assert.strictEqual(delivered.requestId, 'req-003');
        var result = JSON.parse(delivered.data);
        assert.strictEqual(result.success, 2);
    });

    test('_handleUpload 错误时返回 error JSON', async () => {
        win.BK.Sync.importFromZip = function () {
            return Promise.reject(new Error('导入失败测试'));
        };

        var delivered = null;
        win.Capacitor.Plugins.LanSync.deliverResult = function (opts) {
            delivered = opts;
            return Promise.resolve();
        };

        var zip = new win.JSZip();
        zip.file('manifest.json', '{}');
        var bytes = await zip.generateAsync({ type: 'uint8array' });
        var base64 = win.btoa(String.fromCharCode.apply(null, bytes));

        await win.BK.LanSync._handleUpload(base64, 'req-004');
        var result = JSON.parse(delivered.data);
        assert.strictEqual(result.success, 0);
        assert.ok(result.errors.length > 0);
    });
});
```

### Step 2: Run test — confirm it fails

```
Command: node --test tests/ui/test-lan-sync.js
Expected: FAIL — module not found (lan-sync.js does not exist yet)
```

### Step 3: Write minimal implementation

Create `src/static/js/sync/lan-sync.js`:

```javascript
/**
 * lan-sync.js — 局域网同步核心 API
 *
 * 客户端 API（APK + PWA 均可用）：
 *   - connect(ip, port, code)   → GET /info，返回对端设备信息
 *   - pull(ip, port, code, opts) → GET /download → importFromZip 合并
 *   - push(ip, port, code, opts) → generateZipBytes → POST /upload
 *
 * 服务端 JS 桥梁（仅 APK，被 NanoHTTPD 通过 evaluateJs 调用）：
 *   - _handleInfo(requestId)           → 收集设备信息 → deliverResult
 *   - _handleDownload(mode, books, id)  → generateZipBytes → base64 → deliverResult
 *   - _handleUpload(base64Zip, id)      → base64 → importFromZip → deliverResult
 *
 * 依赖：
 *   - BK.Sync.generateZipBytes (sync-export.js, T1)
 *   - BK.Sync.importFromZip (sync-import.js)
 *   - BKShelf.all (shelf.js)
 *   - Capacitor.Plugins.LanSync (仅 APK)
 *
 * 挂载：window.BK.LanSync
 */
(function (win) {
    'use strict';

    var LanSync = {
        // ── 环境检测 ──────────────────────────────────────────────────

        isAvailable: function () {
            return !!(win.Capacitor && win.Capacitor.Plugins && win.Capacitor.Plugins.LanSync);
        },

        isNative: function () {
            return this.isAvailable();
        },

        // ── 服务端（APK only）──────────────────────────────────────────

        startServer: function () {
            if (!this.isAvailable()) return Promise.reject(new Error('仅 APK 端可用'));
            return win.Capacitor.Plugins.LanSync.startServer();
        },

        stopServer: function () {
            if (!this.isAvailable()) return Promise.reject(new Error('仅 APK 端可用'));
            return win.Capacitor.Plugins.LanSync.stopServer();
        },

        getStatus: function () {
            if (!this.isAvailable()) return Promise.reject(new Error('仅 APK 端可用'));
            return win.Capacitor.Plugins.LanSync.getStatus();
        },

        // ── 客户端（APK + PWA）─────────────────────────────────────────

        connect: function (ip, port, code) {
            var url = 'http://' + ip + ':' + port + '/info?code=' + code;
            return fetch(url).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            });
        },

        pull: function (ip, port, code, opts) {
            opts = opts || {};
            var mode = opts.mode || 'data';
            var booksParam = opts.books ? '&books=' + opts.books.join(',') : '';
            var url = 'http://' + ip + ':' + port + '/download?code=' + code + '&mode=' + mode + booksParam;

            return fetch(url).then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.arrayBuffer();
            }).then(function (buffer) {
                if (!win.BK || !win.BK.Sync || !win.BK.Sync.importFromZip) {
                    throw new Error('importFromZip 未就绪');
                }
                return win.BK.Sync.importFromZip(buffer);
            });
        },

        push: function (ip, port, code, opts) {
            opts = opts || {};
            var mode = opts.mode || 'data';
            var bookIds = opts.books || [];

            if (!win.BK || !win.BK.Sync || !win.BK.Sync.generateZipBytes) {
                return Promise.reject(new Error('generateZipBytes 未就绪'));
            }

            return win.BK.Sync.generateZipBytes(bookIds, { mode: mode }).then(function (zipBytes) {
                var url = 'http://' + ip + ':' + port + '/upload?code=' + code;
                return fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/zip' },
                    body: zipBytes
                }).then(function (res) {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    return res.json();
                });
            });
        },

        // ── JS 桥梁（被 Java evaluateJs 调用，仅 APK）──────────────────

        _handleInfo: function (requestId) {
            var info = {
                name: _getDeviceName(),
                version: (win.BK_APP_VERSION || ''),
                books: []
            };

            if (win.BKShelf && typeof win.BKShelf.all === 'function') {
                var shelf = win.BKShelf.all();
                for (var i = 0; i < shelf.length; i++) {
                    var rec = shelf[i];
                    if (rec) {
                        var bid = rec.bookId || rec.id;
                        if (bid) info.books.push({ id: bid, title: rec.title || bid });
                    }
                }
            }

            var json = JSON.stringify(info);
            _deliverResult(requestId, json);
        },

        _handleDownload: function (mode, booksStr, requestId) {
            var bookIds = [];
            if (booksStr) {
                bookIds = booksStr.split(',').filter(function (s) { return s; });
            }
            // 无指定书籍时导出全部
            if (!bookIds.length && win.BKShelf && typeof win.BKShelf.all === 'function') {
                var shelf = win.BKShelf.all();
                for (var i = 0; i < shelf.length; i++) {
                    var rec = shelf[i];
                    if (rec) {
                        var bid = rec.bookId || rec.id;
                        if (bid) bookIds.push(bid);
                    }
                }
            }

            if (!win.BK || !win.BK.Sync || !win.BK.Sync.generateZipBytes) {
                _deliverResult(requestId, JSON.stringify({ error: 'generateZipBytes 未就绪' }));
                return Promise.resolve();
            }

            return win.BK.Sync.generateZipBytes(bookIds, { mode: mode || 'data' }).then(function (bytes) {
                var base64 = _bytesToBase64(bytes);
                _deliverResult(requestId, base64);
            }).catch(function (err) {
                _deliverResult(requestId, JSON.stringify({ error: err.message }));
            });
        },

        _handleUpload: function (base64Zip, requestId) {
            var buffer;
            try {
                buffer = _base64ToArrayBuffer(base64Zip);
            } catch (e) {
                _deliverResult(requestId, JSON.stringify({ success: 0, failed: 0, errors: ['base64 解码失败'] }));
                return Promise.resolve();
            }

            if (!win.BK || !win.BK.Sync || !win.BK.Sync.importFromZip) {
                _deliverResult(requestId, JSON.stringify({ success: 0, failed: 0, errors: ['importFromZip 未就绪'] }));
                return Promise.resolve();
            }

            return win.BK.Sync.importFromZip(buffer).then(function (result) {
                _deliverResult(requestId, JSON.stringify(result));
            }).catch(function (err) {
                _deliverResult(requestId, JSON.stringify({
                    success: 0, failed: 0, errors: [err.message || String(err)]
                }));
            });
        }
    };

    // ── 内部工具 ──────────────────────────────────────────────────

    function _getDeviceName() {
        try {
            var name = win.localStorage.getItem('bk_device_name');
            if (name) return name;
        } catch (e) {}
        return '书报-' + (_shortId());
    }

    function _shortId() {
        var id = '';
        var chars = '0123456789ABCDEF';
        for (var i = 0; i < 4; i++) {
            id += chars[Math.floor(Math.random() * chars.length)];
        }
        return id;
    }

    function _deliverResult(requestId, data) {
        if (win.Capacitor && win.Capacitor.Plugins && win.Capacitor.Plugins.LanSync) {
            win.Capacitor.Plugins.LanSync.deliverResult({ requestId: requestId, data: data });
        }
    }

    function _bytesToBase64(bytes) {
        var binary = '';
        for (var i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return win.btoa(binary);
    }

    function _base64ToArrayBuffer(base64) {
        var binary = win.atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    // ── 导出 ──────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.LanSync = LanSync;

})(window);
```

### Step 4: Run test — confirm it passes

```
Command: node --test tests/ui/test-lan-sync.js
Expected: PASS — all 11 tests green
```

### Step 5: Sync 3 copies + commit

```powershell
Copy-Item src\static\js\sync\lan-sync.js output\js\sync\lan-sync.js -Force
Copy-Item src\static\js\sync\lan-sync.js android\app\src\main\assets\public\js\sync\lan-sync.js -Force

# Verify hash
(Get-FileHash src\static\js\sync\lan-sync.js).Hash
(Get-FileHash output\js\sync\lan-sync.js).Hash
(Get-FileHash android\app\src\main\assets\public\js\sync\lan-sync.js).Hash

git add src/static/js/sync/lan-sync.js
git add -f tests/ui/test-lan-sync.js
git commit -m "feat(lan-sync): lan-sync.js client API + JS bridge functions (11 tests)"
```

---

## Task T4: UI Panel — lan-sync-panel.js

**Files:**
- Create: `src/static/js/sync/lan-sync-panel.js`
- Create: `src/static/css/style/css-lan-sync.css`
- Create: `tests/ui/test-lan-sync-panel.js`

**Why:** Users need a UI to start/stop the sync server, see discovered devices, input pairing codes, and view transfer logs. This panel is a full-screen overlay triggered from the "My" page.

### Step 1: Write the failing test

Create `tests/ui/test-lan-sync-panel.js`:

```javascript
'use strict';
/**
 * lan-sync-panel 逻辑测试（node:test + JSDOM）
 *
 * 测试面板状态管理逻辑（非 DOM 渲染细节）：
 *   - 日志追加
 *   - 状态切换
 *   - 设备列表管理
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.win = dom.window;

// Mock LanSync
win.BK = win.BK || {};
win.BK.LanSync = {
    isAvailable: function () { return true; },
    isNative: function () { return true; },
    startServer: function () { return Promise.resolve({ port: 18080, pairCode: '123456', ipAddress: '192.168.1.5' }); },
    stopServer: function () { return Promise.resolve(); },
    getStatus: function () { return Promise.resolve({ running: true, pairCode: '123456', ipAddress: '192.168.1.5', port: 18080 }); },
    connect: function () { return Promise.resolve({ name: '设备B', books: [] }); },
    pull: function () { return Promise.resolve({ success: 1, failed: 0, errors: [] }); },
    push: function () { return Promise.resolve({ success: 1, failed: 0, errors: [] }); }
};

function loadModule() {
    var srcPath = join(__dirname, '..', '..', 'src', 'static', 'js', 'sync', 'lan-sync-panel.js');
    var code = readFileSync(srcPath, 'utf-8');
    vm.runInThisContext(code, { filename: srcPath, displayErrors: true });
}

describe('lan-sync-panel.js', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="app"><div id="lan-sync-panel" style="display:none"></div></div>';
        loadModule();
    });

    test('模块正确挂载到 win.BK.LanSyncPanel', () => {
        assert.ok(win.BK.LanSyncPanel, 'LanSyncPanel 应存在');
        assert.strictEqual(typeof win.BK.LanSyncPanel.show, 'function');
        assert.strictEqual(typeof win.BK.LanSyncPanel.hide, 'function');
        assert.strictEqual(typeof win.BK.LanSyncPanel.addLog, 'function');
    });

    test('show 显示面板', () => {
        win.BK.LanSyncPanel.show();
        var panel = document.getElementById('lan-sync-panel');
        assert.notStrictEqual(panel.style.display, 'none', '面板应可见');
    });

    test('hide 隐藏面板', () => {
        win.BK.LanSyncPanel.show();
        win.BK.LanSyncPanel.hide();
        var panel = document.getElementById('lan-sync-panel');
        assert.strictEqual(panel.style.display, 'none', '面板应隐藏');
    });

    test('addLog 追加日志条目', () => {
        win.BK.LanSyncPanel.show();
        win.BK.LanSyncPanel.addLog('测试日志1');
        win.BK.LanSyncPanel.addLog('测试日志2');
        var logArea = document.querySelector('.lan-sync-log');
        assert.ok(logArea, '日志区域应存在');
        var entries = logArea.querySelectorAll('.lan-sync-log-entry');
        assert.ok(entries.length >= 2, '应至少有 2 条日志');
    });

    test('getServerState 返回当前服务状态', () => {
        var state = win.BK.LanSyncPanel.getState();
        assert.ok(state.hasOwnProperty('serverRunning'));
        assert.ok(state.hasOwnProperty('devices'));
        assert.ok(state.hasOwnProperty('logs'));
        assert.ok(state.hasOwnProperty('mode'));
    });

    test('setMode 切换传输模式', () => {
        win.BK.LanSyncPanel.setMode('full');
        assert.strictEqual(win.BK.LanSyncPanel.getState().mode, 'full');
        win.BK.LanSyncPanel.setMode('data');
        assert.strictEqual(win.BK.LanSyncPanel.getState().mode, 'data');
    });

    test('addDevice / removeDevice 管理设备列表', () => {
        win.BK.LanSyncPanel.addDevice({ name: '设备A', ip: '192.168.1.5', port: 18080 });
        var devices = win.BK.LanSyncPanel.getState().devices;
        assert.strictEqual(devices.length, 1);
        assert.strictEqual(devices[0].name, '设备A');

        win.BK.LanSyncPanel.removeDevice('192.168.1.5');
        devices = win.BK.LanSyncPanel.getState().devices;
        assert.strictEqual(devices.length, 0);
    });
});
```

### Step 2: Run test — confirm it fails

```
Command: node --test tests/ui/test-lan-sync-panel.js
Expected: FAIL — module not found
```

### Step 3: Write minimal implementation

Create `src/static/js/sync/lan-sync-panel.js`:

```javascript
/**
 * lan-sync-panel.js — 局域网同步 UI 面板
 *
 * 全屏弹层，含：
 *   - 本机状态（设备名、服务状态、配对码、IP 地址）
 *   - 可用设备列表（NSD 发现 + 手动输入 IP）
 *   - 传输模式（仅数据 / 含书完整包）
 *   - 传输日志
 *
 * 依赖：
 *   - BK.LanSync (lan-sync.js)
 *
 * 挂载：window.BK.LanSyncPanel
 */
(function (win) {
    'use strict';

    var state = {
        serverRunning: false,
        serverInfo: null,    // {port, pairCode, ipAddress}
        devices: [],          // [{name, ip, port}]
        logs: [],             // [{time, msg}]
        mode: 'data',         // 'data' | 'full'
        transferring: false
    };

    var panelEl = null;
    var logArea = null;

    // ── 面板渲染 ──────────────────────────────────────────────────

    function _ensurePanel() {
        panelEl = document.getElementById('lan-sync-panel');
        if (!panelEl) {
            panelEl = document.createElement('div');
            panelEl.id = 'lan-sync-panel';
            panelEl.className = 'lan-sync-overlay';
            panelEl.style.display = 'none';
            document.body.appendChild(panelEl);
        }
        _renderPanel();
    }

    function _renderPanel() {
        if (!panelEl) return;
        var info = state.serverInfo || {};
        var running = state.serverRunning;
        var codeHtml = info.pairCode
            ? '<span class="lan-sync-code">' + _formatCode(info.pairCode) + '</span>'
            : '<span class="lan-sync-code-empty">—</span>';

        var devicesHtml = state.devices.map(function (d) {
            return '<div class="lan-sync-device" data-ip="' + d.ip + '" data-port="' + d.port + '">' +
                '<span class="lan-sync-device-icon">📱</span>' +
                '<span class="lan-sync-device-name">' + _esc(d.name) + '</span>' +
                '<span class="lan-sync-device-addr">' + _esc(d.ip) + ':' + d.port + '</span>' +
                '<button class="lan-sync-btn-pull" data-ip="' + d.ip + '" data-port="' + d.port + '">拉取</button>' +
                '<button class="lan-sync-btn-push" data-ip="' + d.ip + '" data-port="' + d.port + '">推送</button>' +
                '</div>';
        }).join('');

        if (!devicesHtml) {
            devicesHtml = '<div class="lan-sync-no-device">暂无可用设备</div>' +
                '<div class="lan-sync-manual">' +
                '<input type="text" class="lan-sync-input-ip" placeholder="IP:端口" />' +
                '<input type="text" class="lan-sync-input-code" placeholder="配对码" />' +
                '<button class="lan-sync-btn-connect">连接</button>' +
                '</div>';
        }

        var modeChecked = state.mode === 'full' ? 'checked' : '';

        var logsHtml = state.logs.map(function (l) {
            return '<div class="lan-sync-log-entry"><span class="lan-sync-log-time">' + l.time + '</span> ' + _esc(l.msg) + '</div>';
        }).join('');
        if (!logsHtml) logsHtml = '<div class="lan-sync-log-empty">暂无日志</div>';

        panelEl.innerHTML =
            '<div class="lan-sync-panel">' +
            '  <div class="lan-sync-header">' +
            '    <button class="lan-sync-back">←</button>' +
            '    <span class="lan-sync-title">局域网同步</span>' +
            '  </div>' +
            '  <div class="lan-sync-body">' +
            '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-section-title">本机状态</div>' +
            '      <div class="lan-sync-status-row"><span>状态</span><span class="lan-sync-status-' + (running ? 'on' : 'off') + '">' + (running ? '● 服务运行中' : '● 未启动') + '</span></div>' +
            '      <div class="lan-sync-status-row"><span>配对码</span>' + codeHtml + '</div>' +
            '      <div class="lan-sync-status-row"><span>地址</span><span>' + (info.ipAddress ? _esc(info.ipAddress) + ':' + (info.port || '') : '—') + '</span></div>' +
            '      <div class="lan-sync-actions">' +
            '        <button class="lan-sync-btn-start"' + (running ? ' disabled' : '') + '>启动服务</button>' +
            '        <button class="lan-sync-btn-stop"' + (!running ? ' disabled' : '') + '>停止</button>' +
            '      </div>' +
            '    </div>' +
            '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-section-title">可用设备</div>' +
            '      <div class="lan-sync-devices">' + devicesHtml + '</div>' +
            '    </div>' +
            '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-section-title">传输模式</div>' +
            '      <label class="lan-sync-radio"><input type="radio" name="lan-sync-mode" value="data"' + (state.mode === 'data' ? ' checked' : '') + '> 仅数据（进度·书签·划线）</label>' +
            '      <label class="lan-sync-radio"><input type="radio" name="lan-sync-mode" value="full"' + (state.mode === 'full' ? ' checked' : '') + '> 含书完整包</label>' +
            '    </div>' +
            '    <div class="lan-sync-section">' +
            '      <div class="lan-sync-section-title">传输日志</div>' +
            '      <div class="lan-sync-log">' + logsHtml + '</div>' +
            '    </div>' +
            '  </div>' +
            '</div>';

        if (!logArea) {
            logArea = panelEl.querySelector('.lan-sync-log');
        }
        _bindEvents();
    }

    // ── 事件绑定 ──────────────────────────────────────────────────

    function _bindEvents() {
        if (!panelEl) return;

        var backBtn = panelEl.querySelector('.lan-sync-back');
        if (backBtn) backBtn.onclick = function () { hide(); };

        var startBtn = panelEl.querySelector('.lan-sync-btn-start');
        if (startBtn) startBtn.onclick = _handleStart;

        var stopBtn = panelEl.querySelector('.lan-sync-btn-stop');
        if (stopBtn) stopBtn.onclick = _handleStop;

        var connectBtn = panelEl.querySelector('.lan-sync-btn-connect');
        if (connectBtn) connectBtn.onclick = _handleManualConnect;

        var radios = panelEl.querySelectorAll('input[name="lan-sync-mode"]');
        for (var i = 0; i < radios.length; i++) {
            radios[i].onchange = function (e) { state.mode = e.target.value; };
        }

        var pullBtns = panelEl.querySelectorAll('.lan-sync-btn-pull');
        for (var j = 0; j < pullBtns.length; j++) {
            pullBtns[j].onclick = function (e) {
                var ip = e.target.getAttribute('data-ip');
                var port = parseInt(e.target.getAttribute('data-port'), 10);
                _handlePull(ip, port);
            };
        }

        var pushBtns = panelEl.querySelectorAll('.lan-sync-btn-push');
        for (var k = 0; k < pushBtns.length; k++) {
            pushBtns[k].onclick = function (e) {
                var ip = e.target.getAttribute('data-ip');
                var port = parseInt(e.target.getAttribute('data-port'), 10);
                _handlePush(ip, port);
            };
        }
    }

    // ── 事件处理 ──────────────────────────────────────────────────

    function _handleStart() {
        if (!win.BK || !win.BK.LanSync || !win.BK.LanSync.isAvailable()) {
            addLog('当前环境不支持局域网同步服务端');
            return;
        }
        addLog('正在启动服务...');
        win.BK.LanSync.startServer().then(function (info) {
            state.serverRunning = true;
            state.serverInfo = info;
            addLog('服务已启动，配对码 ' + info.pairCode);
            _renderPanel();
        }).catch(function (err) {
            addLog('启动失败：' + (err.message || err));
        });
    }

    function _handleStop() {
        win.BK.LanSync.stopServer().then(function () {
            state.serverRunning = false;
            state.serverInfo = null;
            addLog('服务已停止');
            _renderPanel();
        });
    }

    function _handleManualConnect() {
        var ipInput = panelEl.querySelector('.lan-sync-input-ip');
        var codeInput = panelEl.querySelector('.lan-sync-input-code');
        if (!ipInput || !codeInput) return;
        var addr = ipInput.value.trim();
        var code = codeInput.value.trim();
        if (!addr || !code) { addLog('请输入 IP:端口 和配对码'); return; }

        var parts = addr.split(':');
        var ip = parts[0];
        var port = parseInt(parts[1] || '18080', 10);

        addLog('正在连接 ' + ip + ':' + port + '...');
        win.BK.LanSync.connect(ip, port, code).then(function (info) {
            addLog('已连接 ' + info.name + '（' + (info.books ? info.books.length : 0) + ' 本书）');
            addDevice({ name: info.name, ip: ip, port: port });
        }).catch(function (err) {
            addLog('连接失败：' + (err.message || err));
        });
    }

    function _handlePull(ip, port) {
        if (state.transferring) { addLog('正在传输中，请稍候'); return; }
        state.transferring = true;
        var code = (state.serverInfo && state.serverInfo.pairCode) ? state.serverInfo.pairCode : '';
        addLog('正在拉取数据...');
        win.BK.LanSync.pull(ip, port, code, { mode: state.mode }).then(function (result) {
            addLog('拉取完成：成功 ' + result.success + ' 本' + (result.failed ? '，失败 ' + result.failed + ' 本' : ''));
        }).catch(function (err) {
            addLog('拉取失败：' + (err.message || err));
        }).finally(function () {
            state.transferring = false;
        });
    }

    function _handlePush(ip, port) {
        if (state.transferring) { addLog('正在传输中，请稍候'); return; }
        state.transferring = true;
        var code = (state.serverInfo && state.serverInfo.pairCode) ? state.serverInfo.pairCode : '';
        addLog('正在推送数据...');
        win.BK.LanSync.push(ip, port, code, { mode: state.mode }).then(function (result) {
            addLog('推送完成：对端成功 ' + result.success + ' 本' + (result.failed ? '，失败 ' + result.failed + ' 本' : ''));
        }).catch(function (err) {
            addLog('推送失败：' + (err.message || err));
        }).finally(function () {
            state.transferring = false;
        });
    }

    // ── 公开 API ──────────────────────────────────────────────────

    function show() {
        _ensurePanel();
        panelEl.style.display = '';
        addLog('面板已打开');
    }

    function hide() {
        if (panelEl) panelEl.style.display = 'none';
    }

    function addLog(msg) {
        var time = new Date();
        var ts = ('0' + time.getHours()).slice(-2) + ':' + ('0' + time.getMinutes()).slice(-2);
        state.logs.push({ time: ts, msg: msg });
        if (state.logs.length > 100) state.logs.shift();

        if (logArea) {
            var entry = document.createElement('div');
            entry.className = 'lan-sync-log-entry';
            entry.innerHTML = '<span class="lan-sync-log-time">' + ts + '</span> ' + _esc(msg);
            logArea.appendChild(entry);
            logArea.scrollTop = logArea.scrollHeight;
        }
    }

    function addDevice(device) {
        // 去重
        for (var i = 0; i < state.devices.length; i++) {
            if (state.devices[i].ip === device.ip) {
                state.devices[i] = device;
                _renderPanel();
                return;
            }
        }
        state.devices.push(device);
        _renderPanel();
    }

    function removeDevice(ip) {
        state.devices = state.devices.filter(function (d) { return d.ip !== ip; });
        _renderPanel();
    }

    function getState() {
        return {
            serverRunning: state.serverRunning,
            serverInfo: state.serverInfo,
            devices: state.devices.slice(),
            logs: state.logs.slice(),
            mode: state.mode,
            transferring: state.transferring
        };
    }

    function setMode(mode) {
        state.mode = mode;
    }

    // ── 工具 ──────────────────────────────────────────────────────

    function _formatCode(code) {
        if (!code) return '';
        return code.split('').join(' ');
    }

    function _esc(s) {
        if (!s) return '';
        var div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    // ── 导出 ──────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.LanSyncPanel = {
        show: show,
        hide: hide,
        addLog: addLog,
        addDevice: addDevice,
        removeDevice: removeDevice,
        getState: getState,
        setMode: setMode
    };

})(window);
```

Create `src/static/css/style/css-lan-sync.css` (minimal styles, can be refined later):

```css
/* 局域网同步面板样式 */
.lan-sync-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: #F5F4F1; z-index: 9999; overflow-y: auto;
    font-size: 14px;
}
.lan-sync-panel { max-width: 600px; margin: 0 auto; padding: 0; }
.lan-sync-header {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; border-bottom: 1px solid #E0DED9;
    background: #FFF; position: sticky; top: 0; z-index: 1;
}
.lan-sync-back { border: none; background: none; font-size: 20px; cursor: pointer; color: #666; }
.lan-sync-title { font-size: 18px; font-weight: 600; }
.lan-sync-body { padding: 16px; }
.lan-sync-section { margin-bottom: 24px; }
.lan-sync-section-title { font-size: 12px; color: #999; margin-bottom: 8px; text-transform: uppercase; }
.lan-sync-status-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #ECEAE5; }
.lan-sync-status-on { color: #4CAF50; font-weight: 600; }
.lan-sync-status-off { color: #999; }
.lan-sync-code { font-family: monospace; font-size: 20px; letter-spacing: 2px; font-weight: 600; color: #D4793A; }
.lan-sync-actions { display: flex; gap: 8px; margin-top: 12px; }
.lan-sync-actions button {
    flex: 1; padding: 10px; border: 1px solid #D4D2CD; border-radius: 8px;
    background: #FFF; cursor: pointer; font-size: 14px;
}
.lan-sync-actions button:disabled { opacity: 0.4; cursor: default; }
.lan-sync-device {
    display: flex; align-items: center; gap: 8px; padding: 10px 0;
    border-bottom: 1px solid #ECEAE5;
}
.lan-sync-device-name { font-weight: 500; }
.lan-sync-device-addr { color: #999; flex: 1; }
.lan-sync-btn-pull, .lan-sync-btn-push {
    padding: 6px 16px; border: 1px solid #D4D2CD; border-radius: 6px;
    background: #FFF; cursor: pointer; font-size: 13px;
}
.lan-sync-btn-pull { color: #4A90D9; }
.lan-sync-btn-push { color: #D4793A; }
.lan-sync-manual { display: flex; gap: 8px; margin-top: 12px; }
.lan-sync-input-ip, .lan-sync-input-code {
    border: 1px solid #D4D2CD; border-radius: 6px; padding: 8px;
    font-size: 14px; flex: 1;
}
.lan-sync-input-code { max-width: 100px; }
.lan-sync-btn-connect {
    padding: 8px 16px; border: none; border-radius: 6px;
    background: #D4793A; color: #FFF; cursor: pointer;
}
.lan-sync-radio { display: block; padding: 6px 0; }
.lan-sync-log {
    max-height: 200px; overflow-y: auto; background: #FAFAF8;
    border-radius: 8px; padding: 8px; font-size: 12px;
}
.lan-sync-log-entry { padding: 4px 0; border-bottom: 1px solid #F0EEEA; }
.lan-sync-log-time { color: #999; }
```

### Step 4: Run test — confirm it passes

```
Command: node --test tests/ui/test-lan-sync-panel.js
Expected: PASS — all 7 tests green
```

### Step 5: Sync 3 copies + commit

```powershell
# JS
Copy-Item src\static\js\sync\lan-sync-panel.js output\js\sync\lan-sync-panel.js -Force
Copy-Item src\static\js\sync\lan-sync-panel.js android\app\src\main\assets\public\js\sync\lan-sync-panel.js -Force
# CSS
Copy-Item src\static\css\style\css-lan-sync.css output\css\style\css-lan-sync.css -Force
Copy-Item src\static\css\style\css-lan-sync.css android\app\src\main\assets\public\css\style\css-lan-sync.css -Force

# Verify hashes
(Get-FileHash src\static\js\sync\lan-sync-panel.js).Hash
(Get-FileHash output\js\sync\lan-sync-panel.js).Hash
(Get-FileHash android\app\src\main\assets\public\js\sync\lan-sync-panel.js).Hash

git add src/static/js/sync/lan-sync-panel.js src/static/css/style/css-lan-sync.css
git add -f tests/ui/test-lan-sync-panel.js
git commit -m "feat(lan-sync): UI panel with status, device list, transfer log (7 tests)"
```

---

## Task T5: NSD Auto-Discovery (Java)

**Files:**
- Modify: `android/app/src/main/java/com/books/app/LanSyncPlugin.java` — implement `registerNsd` / `unregisterNsdInternal`

**Why:** APK↔APK auto-discovery. When server starts, register NSD service. Other devices discover it and appear in the device list.

> **Note:** Java-only. No JS unit tests. Verification = compilation.

### Step 1: Implement NSD in LanSyncPlugin.java

Add imports at the top of `LanSyncPlugin.java`:

```java
import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
```

Add fields to the class:

```java
    private NsdManager nsdManager;
    private NsdManager.RegistrationListener nsdRegistrationListener;
    private static final String NSD_SERVICE_TYPE = "_bk-sync._tcp.";
```

Replace the `registerNsd` and `unregisterNsdInternal` stubs:

```java
    @PluginMethod
    public void registerNsd(PluginCall call) {
        if (server == null) {
            call.reject("Server not running");
            return;
        }

        try {
            nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);

            NsdServiceInfo serviceInfo = new NsdServiceInfo();
            serviceInfo.setServiceName("书报-" + getDeviceShortId());
            serviceInfo.setServiceType(NSD_SERVICE_TYPE);
            serviceInfo.setPort(server.getListeningPort());

            nsdRegistrationListener = new NsdManager.RegistrationListener() {
                @Override
                public void onServiceRegistered(NsdServiceInfo info) {
                    Log.d(TAG, "NSD registered: " + info.getServiceName());
                }

                @Override
                public void onRegistrationFailed(NsdServiceInfo info, int errorCode) {
                    Log.e(TAG, "NSD registration failed: " + errorCode);
                }

                @Override
                public void onUnregistrationFailed(NsdServiceInfo info, int errorCode) {
                    Log.e(TAG, "NSD unregistration failed: " + errorCode);
                }

                @Override
                public void onUnregistered(NsdServiceInfo info) {
                    Log.d(TAG, "NSD unregistered");
                }
            };

            nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, nsdRegistrationListener);
            call.resolve();
        } catch (Exception e) {
            call.reject("NSD registration failed: " + e.getMessage());
        }
    }

    private void unregisterNsdInternal() {
        if (nsdManager != null && nsdRegistrationListener != null) {
            try {
                nsdManager.unregisterService(nsdRegistrationListener);
            } catch (Exception e) {
                Log.e(TAG, "NSD unregister error: " + e.getMessage());
            }
            nsdRegistrationListener = null;
        }
    }

    private String getDeviceShortId() {
        try {
            String id = android.provider.Settings.Secure.getString(
                getContext().getContentResolver(),
                android.provider.Settings.Secure.ANDROID_ID
            );
            if (id != null && id.length() >= 4) {
                return id.substring(0, 4).toUpperCase();
            }
        } catch (Exception e) { }
        return "XXXX";
    }
```

Also add `import android.util.Log;` at the top if not already present.

### Step 2: Verify compilation

```powershell
Command: cd android; .\gradlew compileDebugJavaWithJavac
Expected: BUILD SUCCESSFUL
```

### Step 3: Commit

```powershell
git add android/app/src/main/java/com/books/app/LanSyncPlugin.java
git commit -m "feat(lan-sync): NSD auto-discovery registration/unregistration"
```

---

## Task T6: QR Code Generation

**Files:**
- Vendor: `src/static/vendor/qrcode.min.js` — QR code generation library
- Create: `src/static/js/sync/lan-sync-qr.js` — QR wrapper
- Create: `tests/ui/test-lan-sync-qr.js`

**Why:** When APK starts the server, displaying a QR code with `ip:port:code` lets PWA users scan and connect instantly (no manual IP entry).

> **Library choice:** `qrcode-generator` (by Kazuhiko Arase, MIT license, ~15KB). It generates QR codes as HTML table or Canvas. We vendor the minified build.

### Step 1: Write the failing test

Create `tests/ui/test-lan-sync-qr.js`:

```javascript
'use strict';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { join } = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true
});
global.window = dom.window;
global.document = dom.window.document;
global.win = dom.window;

// Load qrcode library
var qrPath = join(__dirname, '..', '..', 'src', 'static', 'vendor', 'qrcode.min.js');
var qrCode = readFileSync(qrPath, 'utf-8');
vm.runInThisContext(qrCode, { filename: qrPath, displayErrors: true });

function loadModule() {
    var srcPath = join(__dirname, '..', '..', 'src', 'static', 'js', 'sync', 'lan-sync-qr.js');
    var code = readFileSync(srcPath, 'utf-8');
    vm.runInThisContext(code, { filename: srcPath, displayErrors: true });
}

describe('lan-sync-qr.js', () => {
    beforeEach(() => { loadModule(); });

    test('模块正确挂载到 win.BK.LanSyncQR', () => {
        assert.ok(win.BK.LanSyncQR, 'LanSyncQR 应存在');
        assert.strictEqual(typeof win.BK.LanSyncQR.buildConnectionString, 'function');
        assert.strictEqual(typeof win.BK.LanSyncQR.render, 'function');
    });

    test('buildConnectionString 生成 bk-sync:// 协议 URL', () => {
        var str = win.BK.LanSyncQR.buildConnectionString({
            ip: '192.168.1.5', port: 18080, code: '123456'
        });
        assert.ok(str.indexOf('bk-sync://') === 0, '应以 bk-sync:// 开头');
        assert.ok(str.indexOf('192.168.1.5') > -1);
        assert.ok(str.indexOf('18080') > -1);
        assert.ok(str.indexOf('code=123456') > -1);
    });

    test('render 返回包含 QR 数据的对象', () => {
        var result = win.BK.LanSyncQR.render('bk-sync://192.168.1.5:18080?code=123456');
        assert.ok(result, '应返回非空');
        assert.ok(result.html, '应含 html 内容');
    });

    test('parseConnectionString 解析 bk-sync:// URL', () => {
        var parsed = win.BK.LanSyncQR.parseConnectionString('bk-sync://192.168.1.5:18080?code=123456');
        assert.strictEqual(parsed.ip, '192.168.1.5');
        assert.strictEqual(parsed.port, 18080);
        assert.strictEqual(parsed.code, '123456');
    });
});
```

### Step 2: Run test — confirm it fails

```
Command: node --test tests/ui/test-lan-sync-qr.js
Expected: FAIL — module not found
```

### Step 3: Vendor the QR library + write implementation

Download `qrcode.min.js` (Kazuhiko Arase's qrcode-generator, minified). Place at `src/static/vendor/qrcode.min.js`.

Create `src/static/js/sync/lan-sync-qr.js`:

```javascript
/**
 * lan-sync-qr.js — QR 码生成与连接字符串处理
 *
 * 功能：
 *   - buildConnectionString({ip, port, code}) → 'bk-sync://ip:port?code=xxx'
 *   - parseConnectionString(str) → {ip, port, code}
 *   - render(str) → {html} 渲染 QR 码为 HTML table
 *
 * 依赖：vendor/qrcode.min.js (qrcode-generator by Kazuhiko Arase)
 *
 * 挂载：window.BK.LanSyncQR
 */
(function (win) {
    'use strict';

    var PROTOCOL = 'bk-sync://';

    function buildConnectionString(info) {
        return PROTOCOL + info.ip + ':' + info.port + '?code=' + info.code;
    }

    function parseConnectionString(str) {
        if (!str || str.indexOf(PROTOCOL) !== 0) return null;
        var rest = str.substring(PROTOCOL.length);
        var qIdx = rest.indexOf('?code=');
        var hostPart, code;
        if (qIdx > -1) {
            hostPart = rest.substring(0, qIdx);
            code = rest.substring(qIdx + 6);
        } else {
            hostPart = rest;
            code = '';
        }
        var parts = hostPart.split(':');
        return {
            ip: parts[0],
            port: parseInt(parts[1] || '18080', 10),
            code: code
        };
    }

    function render(text) {
        var QRCode = win.qrcode;
        if (!QRCode) return { html: '<div>QR 库未加载</div>' };

        var qr = QRCode(0, 'M'); // type=0 auto, error correction M
        qr.addData(text);
        qr.make();

        var html = '';
        var count = qr.getModuleCount();
        html += '<table class="lan-sync-qr-table" style="border-collapse:collapse;">';
        for (var r = 0; r < count; r++) {
            html += '<tr>';
            for (var c = 0; c < count; c++) {
                var dark = qr.isDark(r, c);
                html += '<td style="width:3px;height:3px;background:' + (dark ? '#000' : '#fff') + ';"></td>';
            }
            html += '</tr>';
        }
        html += '</table>';
        return { html: html, size: count };
    }

    win.BK = win.BK || {};
    win.BK.LanSyncQR = {
        buildConnectionString: buildConnectionString,
        parseConnectionString: parseConnectionString,
        render: render
    };

})(window);
```

### Step 4: Run test — confirm it passes

```
Command: node --test tests/ui/test-lan-sync-qr.js
Expected: PASS — all 4 tests green
```

### Step 5: Sync 3 copies + commit

```powershell
# JS
Copy-Item src\static\js\sync\lan-sync-qr.js output\js\sync\lan-sync-qr.js -Force
Copy-Item src\static\js\sync\lan-sync-qr.js android\app\src\main\assets\public\js\sync\lan-sync-qr.js -Force
# Vendor
Copy-Item src\static\vendor\qrcode.min.js output\vendor\qrcode.min.js -Force
Copy-Item src\static\vendor\qrcode.min.js android\app\src\main\assets\public\vendor\qrcode.min.js -Force

git add src/static/vendor/qrcode.min.js src/static/js/sync/lan-sync-qr.js
git add -f tests/ui/test-lan-sync-qr.js
git commit -m "feat(lan-sync): QR code generation for connection string (4 tests)"
```

---

## Task T7: Integration — HTML Registration, UI Button, 3-Copy Sync, Browser Verification

**Files:**
- Modify: `src/static/index.html` — add script tags + CSS link + `__bkCoreUrls` entries
- Modify: `src/static/js/renderer/renderer-api.js` — add "局域网同步" button + event handler

**Why:** All new modules must be registered in the HTML loading chain and pre-cache list, or they will be `undefined` in production (Test Harness Fidelity Pitfall). The UI button must be wired to open the panel.

### Step 1: Add script tags to index.html

In `src/static/index.html`, after line 316 (`<script src="js/sync/sync-import.js" defer></script>`), add:

```html
    <!-- lan-sync 模块：lan-sync-qr → lan-sync → lan-sync-panel（依赖顺序） -->
    <script src="vendor/qrcode.min.js" defer></script>
    <script src="js/sync/lan-sync-qr.js" defer></script>
    <script src="js/sync/lan-sync.js" defer></script>
    <script src="js/sync/lan-sync-panel.js" defer></script>
```

### Step 2: Add CSS link

In `index.html`, after the last CSS link (around line 380, after `css-responsive.css`), add:

```html
    <link rel="stylesheet" href="css/style/css-lan-sync.css">
```

### Step 3: Add `__bkCoreUrls` entries

In the `__bkCoreUrls` array (line 398, in the long sync string), after `'./js/sync/sync-import.js'`, add:

```javascript
'./js/sync/lan-sync-qr.js','./js/sync/lan-sync.js','./js/sync/lan-sync-panel.js',
```

Also add `./vendor/qrcode.min.js` to the vendor section (line 409, after the existing vendor entries), and `./css/style/css-lan-sync.css` to the CSS section.

### Step 4: Add UI button in renderer-api.js

In `src/static/js/renderer/renderer-api.js`, after line 176 (the sync-import button), add:

```javascript
      html += '<button class="bk-settings-row" data-action="lan-sync"><span class="bk-row-icon">📡</span><span class="bk-row-label">局域网同步</span><span class="bk-row-sub">自动发现 · 一键传输</span><span class="bk-row-arrow">›</span></button>';
```

### Step 5: Add event handler in renderer-api.js

In the event binding section (around line 310, after the `sync-import` branch), add:

```javascript
            } else if (action === 'lan-sync') {
              if (win.BK && win.BK.LanSyncPanel) {
                win.BK.LanSyncPanel.show();
              } else {
                alert('局域网同步功能未就绪，请刷新页面后重试');
              }
```

### Step 6: Sync 3 copies

```powershell
# index.html
Copy-Item src\static\index.html output\index.html -Force
Copy-Item src\static\index.html android\app\src\main\assets\public\index.html -Force

# renderer-api.js
Copy-Item src\static\js\renderer\renderer-api.js output\js\renderer\renderer-api.js -Force
Copy-Item src\static\js\renderer\renderer-api.js android\app\src\main\assets\public\js\renderer\renderer-api.js -Force

# Verify hashes (all 3 copies of each file)
foreach ($f in @('index.html','js\renderer\renderer-api.js','js\sync\lan-sync.js','js\sync\lan-sync-panel.js','js\sync\lan-sync-qr.js','vendor\qrcode.min.js','css\style\css-lan-sync.css')) {
    $h1 = (Get-FileHash "src\static\$f").Hash
    $h2 = (Get-FileHash "output\$f").Hash
    $h3 = (Get-FileHash "android\app\src\main\assets\public\$f").Hash
    if ($h1 -eq $h2 -and $h2 -eq $h3) {
        Write-Host "OK  $f"
    } else {
        Write-Host "FAIL $f  src=$h1 out=$h2 apk=$h3"
    }
}
```

### Step 7: Run all tests

```powershell
Command: node --test tests/ui/test-sync-export.js tests/ui/test-sync-import.js tests/ui/test-sync-data-collect.js tests/ui/test-lan-sync.js tests/ui/test-lan-sync-panel.js tests/ui/test-lan-sync-qr.js
Expected: PASS — all tests across all files green
```

### Step 8: Browser verification (Chrome DevTools)

1. Open `output/index.html` in Chrome (via DevTools)
2. Navigate to "我的" page
3. Verify "局域网同步" button appears in "内容与数据" section
4. Click it → verify panel opens with sections: 本机状态, 可用设备, 传输模式, 传输日志
5. Verify no console errors about missing modules

### Step 9: Commit

```powershell
git add src/static/index.html src/static/js/renderer/renderer-api.js
git commit -m "feat(lan-sync): register modules in HTML + __bkCoreUrls, wire UI button"
```

---

## Summary

| Task | Files Created | Files Modified | Tests | Est. |
|---|---|---|---|---|
| T1 | — | sync-export.js | +2 | 0.5h |
| T2 | LanSyncPlugin.java | build.gradle, AndroidManifest.xml, MainActivity.java | compile | 3h |
| T3 | lan-sync.js, test-lan-sync.js | — | 11 | 1.5h |
| T4 | lan-sync-panel.js, css-lan-sync.css, test-lan-sync-panel.js | — | 7 | 2h |
| T5 | — | LanSyncPlugin.java | compile | 1h |
| T6 | qrcode.min.js (vendor), lan-sync-qr.js, test-lan-sync-qr.js | — | 4 | 0.5h |
| T7 | — | index.html, renderer-api.js | integration | 0.5h |
| **Total** | **6 new** | **6 modified** | **24 new** | **~9h** |

**Phase 2 (WebRTC, T8-T11) is deferred** — implement after Phase 1 is tested on real devices.

> AI生成