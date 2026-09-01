/**
 * sync-webdav.js — WebDAV 双向增量同步协调器
 *
 * 基于远端 manifest 比对本地阅读数据时间戳，决定 pull/push 哪些书。
 * 每本书一个 ZIP 包（复用 BK.Sync.generateZipBytes），远端目录结构：
 *
 *   bk-sync/
 *   ├── manifest.json     # {version, lastSyncTs, books: {bookId: {ts, size}}}
 *   ├── epub-aaa.zip
 *   └── pdf-bbb.zip
 *
 * 触发时机：进/退书事件（reader-page-change），进书 pull、退书 push（后台化）
 *
 * 依赖：
 *   - BK.Sync.generateZipBytes / importFromZip (sync-export.js / sync-import.js)
 *   - BKShelf.all (shelf.js)
 *   - WebDavManager (webdav-manager.js)
 *
 * 挂载：window.BK.SyncWebDAV
 *   .computeDiff(localManifest, remoteManifest)  纯函数：比对 → {pull:[], push:[]}
 *   .buildLocalManifest()                        纯函数：从书架+localStorage 构建
 *   .parseRemoteManifest(json)                   纯函数：解析远端 manifest JSON
 *   .serializeRemoteManifest(manifest)           纯函数：序列化为 JSON
 *   .mergeManifest(remote, bookId, ts, size)     纯函数：合并条目到远端 manifest
 *   .pushBook(config, bookId, remoteBase)        上传单本书
 *   .pullBook(config, entry, remoteBase)         下载并导入单本书
 *   .sync(config, opts)                          完整双向同步（pull all → push all）
 */
(function (win) {
    'use strict';

    var MANIFEST_VERSION = 1;
    var REMOTE_DIR = 'bk-sync';
    var MANIFEST_NAME = 'manifest.json';

    // ── 纯逻辑函数 ──────────────────────────────────────────────────────

    /**
     * 比对本地与远端 manifest，输出 pull/push 列表
     * @param {object} localManifest  { books: { bookId: { ts } } }
     * @param {object} remoteManifest { books: { bookId: { ts, size } } }
     * @returns {{pull: string[], push: string[]}}
     */
    function computeDiff(localManifest, remoteManifest) {
        var local = (localManifest && localManifest.books) || {};
        var remote = (remoteManifest && remoteManifest.books) || {};
        var pull = [];
        var push = [];

        // 收集所有 bookId（并集）
        var allIds = {};
        for (var lid in local) { allIds[lid] = true; }
        for (var rid in remote) { allIds[rid] = true; }

        for (var id in allIds) {
            var localTs = local[id] ? (parseInt(local[id].ts, 10) || 0) : 0;
            var remoteTs = remote[id] ? (parseInt(remote[id].ts, 10) || 0) : 0;

            if (localTs > remoteTs) {
                push.push(id);
            } else if (remoteTs > localTs) {
                pull.push(id);
            }
            // ts 相同 → 跳过
        }

        return { pull: pull, push: push };
    }

    /**
     * 从书架 + localStorage 构建本地 manifest
     * 只纳入有 lastReadTs 的书（已读书才推送）
     * @returns {{version:number, lastSyncTs:number, books:Object}}
     */
    function buildLocalManifest() {
        var books = {};
        try {
            var shelf = [];
            if (win.BKShelf && typeof win.BKShelf.all === 'function') {
                shelf = win.BKShelf.all();
            }
            for (var i = 0; i < shelf.length; i++) {
                var rec = shelf[i];
                var bookId = rec ? (rec.bookId || rec.id) : null;
                if (!bookId) continue;
                var tsRaw = null;
                try { tsRaw = win.localStorage.getItem('bk_lastread_ts:' + bookId); } catch (e) {}
                if (tsRaw) {
                    var ts = parseInt(tsRaw, 10);
                    if (ts > 0) {
                        books[bookId] = { ts: ts };
                    }
                }
            }
        } catch (e) {
            console.warn('[SyncWebDAV] buildLocalManifest error:', e);
        }
        return {
            version: MANIFEST_VERSION,
            lastSyncTs: Date.now(),
            books: books
        };
    }

    /**
     * 解析远端 manifest JSON
     * @param {string|null} json
     * @returns {{version:number, lastSyncTs:number, books:Object}}
     */
    function parseRemoteManifest(json) {
        if (!json) return { version: MANIFEST_VERSION, lastSyncTs: 0, books: {} };
        try {
            var parsed = JSON.parse(json);
            if (!parsed || typeof parsed !== 'object') {
                return { version: MANIFEST_VERSION, lastSyncTs: 0, books: {} };
            }
            if (!parsed.books || typeof parsed.books !== 'object') {
                parsed.books = {};
            }
            return parsed;
        } catch (e) {
            return { version: MANIFEST_VERSION, lastSyncTs: 0, books: {} };
        }
    }

    /**
     * 序列化 manifest 为 JSON 字符串
     * @param {object} manifest
     * @returns {string}
     */
    function serializeRemoteManifest(manifest) {
        if (!manifest) {
            manifest = { version: MANIFEST_VERSION, lastSyncTs: 0, books: {} };
        }
        return JSON.stringify(manifest, null, 2);
    }

    /**
     * 合并一条书记录到远端 manifest（push 后调用）
     * @param {object} remote   远端 manifest（会被修改）
     * @param {string} bookId
     * @param {number} ts
     * @param {number} size     ZIP 文件大小
     * @returns {object} 更新后的 manifest
     */
    function mergeManifest(remote, bookId, ts, size) {
        if (!remote) remote = { version: MANIFEST_VERSION, lastSyncTs: 0, books: {} };
        if (!remote.books) remote.books = {};
        remote.books[bookId] = { ts: ts, size: size };
        remote.lastSyncTs = Date.now();
        return remote;
    }

    // ── 网络操作 ────────────────────────────────────────────────────────

    /**
     * 上传单本书的同步 ZIP 到远端
     * @param {object} config    WebDAV 配置
     * @param {string} bookId
     * @param {string} remoteBase 远端基目录（如 'bk-sync'）
     * @returns {Promise<{ok:boolean, size:number}>}
     */
    function pushBook(config, bookId, remoteBase) {
        remoteBase = remoteBase || REMOTE_DIR;
        if (!config) return Promise.reject(new Error('WebDAV 配置缺失'));
        if (!bookId) return Promise.reject(new Error('bookId 缺失'));

        // 1. 生成 ZIP（复用 sync-export 的 generateZipBytes）
        if (!win.BK || !win.BK.Sync || !win.BK.Sync.generateZipBytes) {
            return Promise.reject(new Error('BK.Sync.generateZipBytes 不可用'));
        }

        return win.BK.Sync.generateZipBytes([bookId], { mode: 'data' }).then(function (bytes) {
            // 2. 确保远端目录存在
            return win.WebDavManager.ensureRemotePath(config, remoteBase).then(function () {
                // 3. 上传 ZIP
                var remotePath = remoteBase + '/' + bookId + '.zip';
                return win.WebDavManager.uploadFile(config, remotePath, bytes, 'application/zip').then(function (result) {
                    var size = (bytes && bytes.length) || (result && result.size) || 0;
                    console.log('[SyncWebDAV] pushBook 成功: ' + bookId + ', size=' + size);
                    return { ok: true, size: size };
                });
            });
        });
    }

    /**
     * 下载远端 ZIP 并导入
     * @param {object} config    WebDAV 配置
     * @param {object} entry     DirEntry（含 remotePath, name, size）
     * @param {string} remoteBase 远端基目录
     * @returns {Promise<{ok:boolean}>}
     */
    function pullBook(config, entry, remoteBase) {
        remoteBase = remoteBase || REMOTE_DIR;
        if (!config) return Promise.reject(new Error('WebDAV 配置缺失'));
        if (!entry) return Promise.reject(new Error('entry 缺失'));

        return win.WebDavManager.downloadFile(config, entry).then(function (fileInfo) {
            if (!fileInfo) return Promise.reject(new Error('下载失败：无数据'));

            // 获取 ArrayBuffer
            var buffer = fileInfo.arrayBuffer || fileInfo.text;
            if (!buffer) return Promise.reject(new Error('下载失败：无内容'));

            // 导入（复用 sync-import 的 importFromZip）
            if (!win.BK || !win.BK.Sync || !win.BK.Sync.importFromZip) {
                return Promise.reject(new Error('BK.Sync.importFromZip 不可用'));
            }

            return win.BK.Sync.importFromZip(buffer).then(function (result) {
                console.log('[SyncWebDAV] pullBook 成功: ' + entry.name +
                    ', success=' + (result ? result.success : 0));
                return { ok: true };
            });
        });
    }

    // ── 完整双向同步 ────────────────────────────────────────────────────

    /**
     * 完整双向同步：拉取远端 manifest → diff → pull 新 → push 新 → 更新 manifest
     * @param {object} config    WebDAV 配置（可选，默认取 getActiveConfig）
     * @param {object} [opts]
     *   - {string} remoteBase  远端基目录（默认 'bk-sync'）
     *   - {Function} onProgress(phase, detail)  进度回调
     * @returns {Promise<{pulled:number, pushed:number, errors:Array}>}
     */
    function sync(config, opts) {
        opts = opts || {};
        var remoteBase = opts.remoteBase || REMOTE_DIR;
        if (!config) {
            config = win.WebDavManager && win.WebDavManager.getActiveConfig();
        }
        if (!config) return Promise.reject(new Error('未配置 WebDAV 服务器'));

        var pulled = 0;
        var pushed = 0;
        var errors = [];

        // 1. 确保远端目录存在
        return win.WebDavManager.ensureRemotePath(config, remoteBase).then(function () {
            // 2. 下载远端 manifest
            return win.WebDavManager.listDir(config, remoteBase).then(function (entries) {
                // 在 entries 中找 manifest.json
                var manifestEntry = null;
                var zipEntries = [];
                for (var i = 0; i < entries.length; i++) {
                    var en = entries[i];
                    if (en.name === MANIFEST_NAME) {
                        manifestEntry = en;
                    } else if (en.name && en.name.indexOf('.zip') >= 0 && !en.isDir) {
                        zipEntries.push(en);
                    }
                }

                // 获取远端 manifest
                var remoteManifestP;
                if (manifestEntry) {
                    remoteManifestP = win.WebDavManager.downloadFile(config, manifestEntry).then(function (info) {
                        return win.BK.SyncWebDAV.parseRemoteManifest(info.text || '');
                    });
                } else {
                    remoteManifestP = Promise.resolve({ version: MANIFEST_VERSION, lastSyncTs: 0, books: {} });
                }

                return remoteManifestP.then(function (remoteManifest) {
                    // 3. 构建本地 manifest
                    var localManifest = win.BK.SyncWebDAV.buildLocalManifest();

                    // 4. diff
                    var diff = win.BK.SyncWebDAV.computeDiff(localManifest, remoteManifest);
                    console.log('[SyncWebDAV] sync: pull=' + diff.pull.length + ' push=' + diff.push.length);

                    // 5. Pull 阶段
                    var pullChain = Promise.resolve();
                    diff.pull.forEach(function (bookId) {
                        pullChain = pullChain.then(function () {
                            // 找到对应的远端 ZIP entry
                            var entry = zipEntries.find(function (e) {
                                return e.name === bookId + '.zip';
                            });
                            if (!entry) {
                                errors.push({ id: bookId, error: '远端未找到 ZIP' });
                                return;
                            }
                            if (opts.onProgress) opts.onProgress('pull', bookId);
                            return win.BK.SyncWebDAV.pullBook(config, entry, remoteBase).then(function () {
                                pulled++;
                            }).catch(function (err) {
                                errors.push({ id: bookId, error: err.message });
                            });
                        });
                    });

                    return pullChain.then(function () {
                        // 6. Push 阶段
                        var pushChain = Promise.resolve();
                        diff.push.forEach(function (bookId) {
                            pushChain = pushChain.then(function () {
                                if (opts.onProgress) opts.onProgress('push', bookId);
                                // 获取本地 ts
                                var localTs = 0;
                                try {
                                    var tsRaw = win.localStorage.getItem('bk_lastread_ts:' + bookId);
                                    if (tsRaw) localTs = parseInt(tsRaw, 10) || 0;
                                } catch (e) {}

                                return win.BK.SyncWebDAV.pushBook(config, bookId, remoteBase).then(function (pushResult) {
                                    // 更新远端 manifest
                                    win.BK.SyncWebDAV.mergeManifest(remoteManifest, bookId, localTs, pushResult.size);
                                    pushed++;
                                }).catch(function (err) {
                                    errors.push({ id: bookId, error: err.message });
                                });
                            });
                        });

                        return pushChain.then(function () {
                            // 7. 上传更新后的远端 manifest
                            var manifestJson = win.BK.SyncWebDAV.serializeRemoteManifest(remoteManifest);
                            return win.WebDavManager.uploadFile(
                                config,
                                remoteBase + '/' + MANIFEST_NAME,
                                manifestJson,
                                'application/json'
                            ).catch(function (err) {
                                errors.push({ id: '_manifest', error: 'manifest 上传失败: ' + err.message });
                            });
                        });
                    });
                });
            });
        }).then(function () {
            console.log('[SyncWebDAV] sync 完成: pulled=' + pulled + ' pushed=' + pushed + ' errors=' + errors.length);
            return { pulled: pulled, pushed: pushed, errors: errors };
        });
    }

    // ── 导出 ──────────────────────────────────────────────────────────────
    win.BK = win.BK || {};
    win.BK.SyncWebDAV = {
        // 纯逻辑
        computeDiff: computeDiff,
        buildLocalManifest: buildLocalManifest,
        parseRemoteManifest: parseRemoteManifest,
        serializeRemoteManifest: serializeRemoteManifest,
        mergeManifest: mergeManifest,
        // 网络操作
        pushBook: pushBook,
        pullBook: pullBook,
        sync: sync,
        // 常量
        REMOTE_DIR: REMOTE_DIR,
        MANIFEST_VERSION: MANIFEST_VERSION
    };

})(window);
