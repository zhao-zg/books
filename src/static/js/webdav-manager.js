/**
 * webdav-manager.js
 * WebDAV 单向下载导入模块（连接 / 列目录 / 下载 / 错误分类 / 配置 / 重同步）
 *
 * 依赖：import-manager.js（须先于本文件加载，用于 importFromBuffer 落库）
 * 网络层：PROPFIND / GET 一律使用 fetch（兼容流式进度）。
 * 认证：v1 仅支持 Basic Auth（兼容中文账号）。
 *
 * 暴露：window.WebDavManager
 *   .isNative()                      是否原生（Capacitor）环境
 *   .classifyError(err, resp)        纯函数：错误分类 → {type, hint}
 *   .testConnection(config)          测试连接（PROPFIND Depth:0）
 *   .connect(config, opts)           保存并连接，返回 {config, entries}
 *   .listDir(config, path)           列目录，返回 DirEntry[]
 *   .downloadFile(config, entry, onProgress)  下载单文件，返回 fileInfo
 *   .resyncBook(book)                依据 book.source 重同步（覆盖同 id）
 *   .saveConfig(config) / getConfigs() / getConfigById(id)
 *   .deleteConfig(id) / getActiveConfig() / setActiveConfig(id)
 *   .ERROR / .MESSAGES / .TIMEOUT_MS / .IMPORTABLE_EXT / .AUTH_TYPE
 */
(function (win) {
  'use strict';

  // ── 常量 ──────────────────────────────────────────────────────────────
  var TIMEOUT_MS = 30000;                 // 单文件/请求超时
  var IMPORTABLE_EXT = ['.txt', '.epub', '.md', '.markdown']; // 可导入扩展名
  var AUTH_TYPE = ['basic', 'digest', 'token'];               // 认证类型枚举（v1 仅 basic 生效）

  // 错误类型枚举
  var ERROR = {
    AUTH: 'AUTH',         // 认证失败（401/403）
    CORS: 'CORS',         // Web 端跨域被拦截
    NETWORK: 'NETWORK',   // 网络未连接
    TIMEOUT: 'TIMEOUT',   // 请求超时
    SERVER: 'SERVER',     // 服务器返回错误（HTTP 4xx/5xx）
    UNKNOWN: 'UNKNOWN'    // 未知错误
  };

  // 中文提示（UI 只读、不硬编码）。{msg} 为占位符
  var MESSAGES = {
    AUTH_FAIL: '认证失败：用户名或密码错误',
    AUTH_FORBIDDEN: '服务器拒绝访问（账号正确但无权限）',
    CORS_WEB: '当前为 Web 端，需服务端开启 CORS；建议改用「书报 App」',
    NETWORK: '网络未连接，请检查网络',
    TIMEOUT: '超时（30s），请重试',
    SERVER: '服务器返回错误（HTTP ',          // 拼接状态码
    UNKNOWN: '未知错误：{msg}',
    // 通用 UI 文案
    CONNECTING: '连接中…',
    TEST_OK: '连接成功 ✓',
    NO_CONFIG: '请先配置 WebDAV 服务器',
    DOWNLOADING: '下载中…',
    IMPORT_DONE: '导入完成',
    RESYNC_DONE: '已重新同步'
  };

  // localStorage 键
  var CFG_KEY = 'bk_webdav_configs';
  var ACTIVE_KEY = 'bk_webdav_active';

  // PROPFIND 请求体
  var PROPFIND_XML = '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:propfind xmlns:d="DAV:">' +
    '<d:prop>' +
    '<d:resourcetype/>' +
    '<d:getcontentlength/>' +
    '<d:getcontenttype/>' +
    '<d:displayname/>' +
    '</d:prop>' +
    '</d:propfind>';

  // ── 工具：环境识别 ──────────────────────────────────────────────────────
  function isNative() {
    return !!(win.Capacitor &&
      typeof win.Capacitor.isNativePlatform === 'function' &&
      win.Capacitor.isNativePlatform());
  }

  // ── 工具：Basic Auth 头（兼容中文账号）─────────────────────────────────
  function basicAuthHeader(username, password) {
    var raw = (username || '') + ':' + (password || '');
    return 'Basic ' + btoa(unescape(encodeURIComponent(raw)));
  }

  // ── 工具：构建请求头（含认证）─────────────────────────────────────────
  function buildHeaders(config, extra) {
    var headers = extra || {};
    var authType = config.authType || 'basic';
    if (authType === 'basic') {
      headers['Authorization'] = basicAuthHeader(config.username, config.password);
    } else if (authType === 'token' && config.password) {
      // token 模式：以 Bearer 形式携带（兼容部分网盘）
      headers['Authorization'] = 'Bearer ' + config.password;
    }
    return headers;
  }

  // ── 工具：规范化 URL（去掉末尾斜杠）─────────────────────────────────
  function trimSlash(url) {
    return (url || '').replace(/\/+$/, '');
  }

  // ── 工具：拼接目录 URL ──────────────────────────────────────────────────
  // path 可为 ''（根）、绝对 href（导航进子目录）、或相对路径
  function buildDirUrl(baseUrl, path) {
    baseUrl = trimSlash(baseUrl);
    if (!path) return baseUrl + '/';               // 集合需以 / 结尾
    if (/^[a-z][a-z0-9+.\-]*:/i.test(path)) return path; // 绝对 URL 直接返回
    return baseUrl + '/' + path.replace(/^\/+/, '');
  }

  // ── 工具：解析相对 href 为绝对 URL ─────────────────────────────────────
  function resolveHref(baseUrl, href) {
    if (!href) return baseUrl;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(href)) return href; // 已是绝对 URL
    try {
      return new URL(href, baseUrl).href;
    } catch (e) {
      return href;
    }
  }

  // ── 工具：统一去掉末尾斜杠（用于比较“自身”）─────────────────────────
  function normalizeHref(href) {
    if (!href) return '';
    return href.replace(/\/+$/, '');
  }

  // ── 工具：按扩展名取 MIME ──────────────────────────────────────────────
  function mimeForExt(path) {
    var ext = (path.split('.').pop() || '').toLowerCase();
    if (ext === 'epub') return 'application/epub+zip';
    if (ext === 'md' || ext === 'markdown') return 'text/markdown';
    return 'text/plain';
  }

  // ── 工具：按 localName 查找元素（命名空间安全）────────────────────────
  function findAllByLocalName(root, localName) {
    var out = [];
    if (!root || !root.getElementsByTagName) return out;
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].localName === localName) out.push(all[i]);
    }
    return out;
  }

  function firstByLocalName(root, localName) {
    var list = findAllByLocalName(root, localName);
    return list.length ? list[0] : null;
  }

  function textOf(el) {
    return el ? (el.textContent || '').trim() : '';
  }

  // ── 纯函数：错误分类（绝不静默）─────────────────────────────────────
  // 返回 { type: ERROR.*, hint: string }
  function classifyError(err, resp) {
    // 401 认证失败
    if (resp && resp.status === 401) {
      return { type: ERROR.AUTH, hint: MESSAGES.AUTH_FAIL };
    }
    // 403 无权限
    if (resp && resp.status === 403) {
      return { type: ERROR.AUTH, hint: MESSAGES.AUTH_FORBIDDEN };
    }
    // 超时（AbortController 触发）
    if (err && err.name === 'AbortError') {
      return { type: ERROR.TIMEOUT, hint: MESSAGES.TIMEOUT };
    }
    // 网络断开
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { type: ERROR.NETWORK, hint: MESSAGES.NETWORK };
    }
    // CORS（Web 端，fetch 抛 TypeError / Failed to fetch 且在线）
    if (!isNative() && err &&
      (err instanceof TypeError || /Failed to fetch/i.test(err.message || '')) &&
      (typeof navigator === 'undefined' || navigator.onLine)) {
      return { type: ERROR.CORS, hint: MESSAGES.CORS_WEB };
    }
    // 服务器错误
    if (resp && !resp.ok) {
      return { type: ERROR.SERVER, hint: MESSAGES.SERVER + (resp.status || '') + ')' };
    }
    // 未知
    var msg = (err && err.message) ? err.message : '未知错误';
    return { type: ERROR.UNKNOWN, hint: MESSAGES.UNKNOWN.replace('{msg}', msg) };
  }

  // ── 将分类结果包装为带 type 的错误对象 ─────────────────────────────────
  function wrapError(err, resp) {
    var c = classifyError(err, resp);
    var e = new Error(c.hint);
    e.type = c.type;
    if (resp) e.status = resp.status;
    e.resp = resp || null;
    return e;
  }

  // ── PROPFIND 请求（返回 {resp, text}）──────────────────────────────────
  function propfind(url, config, depth) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    var headers = buildHeaders(config, {
      'Depth': depth || '1',
      'Content-Type': 'application/xml; charset=utf-8'
    });
    return fetch(url, {
      method: 'PROPFIND',
      headers: headers,
      body: PROPFIND_XML,
      signal: controller.signal
    }).then(function (resp) {
      clearTimeout(timer);
      return resp.text().then(function (text) {
        return { resp: resp, text: text };
      });
    }).catch(function (err) {
      clearTimeout(timer);
      throw err; // 交给上层 classifyError
    });
  }

  // ── 解析 multistatus → DirEntry[] ──────────────────────────────────────
  function parseMultistatus(text, baseUrl) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    var responses = findAllByLocalName(doc, 'response');
    var entries = [];
    for (var i = 0; i < responses.length; i++) {
      var r = responses[i];
      var hrefEl = firstByLocalName(r, 'href');
      if (!hrefEl) continue;
      var rawHref = textOf(hrefEl);
      var hrefUrl = resolveHref(baseUrl, rawHref);

      // 是否集合（目录）
      var resType = firstByLocalName(r, 'resourcetype');
      var isDir = !!(resType && findAllByLocalName(resType, 'collection').length > 0);

      var lenEl = firstByLocalName(r, 'getcontentlength');
      var size = lenEl ? (parseInt(textOf(lenEl), 10) || 0) : 0;
      var typeEl = firstByLocalName(r, 'getcontenttype');
      var mime = typeEl ? textOf(typeEl) : '';
      var nameEl = firstByLocalName(r, 'displayname');
      var name = nameEl && textOf(nameEl)
        ? textOf(nameEl)
        : decodeURIComponent(hrefUrl.split('/').pop() || rawHref);

      entries.push({
        href: hrefUrl,
        name: name,
        isDir: isDir,
        size: size,
        mime: mime,
        remotePath: hrefUrl
      });
    }
    return entries;
  }

  // ── 列目录（PROPFIND Depth:1）──────────────────────────────────────────
  function listDir(config, path) {
    path = path || '';
    var url = buildDirUrl(config.url, path);
    return propfind(url, config, '1').then(function (result) {
      var resp = result.resp;
      if (!resp.ok) throw wrapError(null, resp);
      var entries = parseMultistatus(result.text, url);
      // 过滤掉“自身”（Depth:1 会返回当前集合 + 子项）
      entries = entries.filter(function (en) {
        return normalizeHref(en.href) !== normalizeHref(url);
      });
      // 排序：目录在前，再按名称
      entries.sort(function (a, b) {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh');
      });
      return entries;
    }).catch(function (err) {
      if (err.type) throw err;            // 已是分类错误
      throw wrapError(err, err.resp);     // fetch 抛错 → 分类
    });
  }

  // ── 测试连接（PROPFIND Depth:0）───────────────────────────────────────
  function testConnection(config) {
    var url = buildDirUrl(config.url, '');
    return propfind(url, config, '0').then(function (result) {
      var resp = result.resp;
      if (!resp.ok) throw wrapError(null, resp);
      return { ok: true, status: resp.status };
    }).catch(function (err) {
      if (err.type) throw err;
      throw wrapError(err, err.resp);
    });
  }

  // ── 连接：保存（可选）+ 设为激活 + 列根目录 ───────────────────────────
  function connect(cfg, opts) {
    opts = opts || {};
    var config = normalizeConfig(cfg);
    if (opts.save) saveConfig(config);
    setActiveConfig(config.id);
    return listDir(config, '').then(function (entries) {
      return { config: config, entries: entries };
    });
  }

  // ── 下载单文件（GET + 流式进度）───────────────────────────────────────
  // onProgress(p): p ∈ [0,1]；服务器未返回 Content-Length 时 p = -1
  // 返回 fileInfo: { name, mime, text?|arrayBuffer?, size, remotePath }
  function downloadFile(config, entry, onProgress) {
    var url = entry.remotePath || entry.href;
    var ext = (entry.name || '').split('.').pop().toLowerCase();
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

    function fail(err) {
      clearTimeout(timer);
      if (err.type) throw err;
      if (err.name === 'AbortError') throw wrapError(err, null);
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw wrapError(err, null);
      if (!isNative() && (err instanceof TypeError || /Failed to fetch/i.test(err.message || ''))) {
        throw wrapError(err, null);
      }
      throw wrapError(err, null);
    }

    return fetch(url, {
      method: 'GET',
      headers: buildHeaders(config, {}),
      signal: controller.signal
    }).then(function (resp) {
      if (!resp.ok) {
        clearTimeout(timer);
        throw wrapError(null, resp);
      }
      var total = parseInt(resp.headers.get('Content-Length') || '0', 10);

      // 流式读取（支持进度）
      if (resp.body && resp.body.getReader) {
        var reader = resp.body.getReader();
        var chunks = [];
        var received = 0;
        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              clearTimeout(timer);
              return assemble(chunks, received, ext, entry, url);
            }
            chunks.push(result.value);
            received += result.value.length;
            if (onProgress) onProgress(total > 0 ? Math.min(1, received / total) : -1);
            return pump();
          });
        }
        return pump().catch(fail);
      }

      // 退化：无流式 reader，一次性读取
      clearTimeout(timer);
      if (ext === 'epub') {
        return resp.arrayBuffer().then(function (buf) {
          return assemble([new Uint8Array(buf)], buf.byteLength, ext, entry, url);
        });
      }
      return resp.text().then(function (text) {
        var bytes = new TextEncoder().encode(text);
        return assemble([bytes], bytes.length, ext, entry, url);
      });
    }).catch(fail);
  }

  // 合并分片 → fileInfo
  function assemble(chunks, received, ext, entry, url) {
    var full = new Uint8Array(received);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      full.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    var base = {
      name: entry.name,
      size: received,
      remotePath: url
    };
    if (ext === 'epub') {
      base.mime = entry.mime || 'application/epub+zip';
      base.arrayBuffer = full.buffer; // Uint8Array 恰好按 received 分配，buffer 等长
      return base;
    }
    base.mime = entry.mime || 'text/plain';
    base.text = new TextDecoder('utf-8').decode(full);
    return base;
  }

  // ── 重同步：依据 book.source 重新下载并覆盖同 id ───────────────────────
  function resyncBook(book) {
    if (!book || !book.source || book.source.type !== 'webdav') {
      return Promise.reject(new Error('该书不是 WebDAV 导入的书籍，无法重新同步'));
    }
    var source = book.source;
    return getConfigById(source.serverId).then(function (config) {
      if (!config) return Promise.reject(new Error('未找到对应的 WebDAV 服务器配置，可能已被删除'));
      var entry = {
        name: source.remotePath.split('/').pop() || (book.title || 'book'),
        mime: mimeForExt(source.remotePath),
        remotePath: source.remotePath
      };
      return downloadFile(config, entry, null).then(function (fileInfo) {
        // 复用同 id 覆盖写，source 保持不变
        return win.ImportManager.importFromBuffer(fileInfo, {
          bookId: book.id,
          source: source
        });
      });
    });
  }

  // ── 配置管理（localStorage）───────────────────────────────────────────
  function normalizeConfig(cfg) {
    cfg = cfg || {};
    return {
      id: cfg.id || ('wd_' + Date.now()),
      name: cfg.name || (cfg.url ? trimSlash(cfg.url) : 'WebDAV'),
      url: trimSlash(cfg.url || ''),
      username: cfg.username || '',
      password: cfg.password || '',          // 明文存储（设计决策①）
      authType: cfg.authType || 'basic'
    };
  }

  function getConfigs() {
    try {
      return JSON.parse(win.localStorage.getItem(CFG_KEY) || '[]') || [];
    } catch (e) {
      return [];
    }
  }

  function saveConfig(config) {
    var c = normalizeConfig(config);
    var configs = getConfigs();
    var found = false;
    for (var i = 0; i < configs.length; i++) {
      if (configs[i].id === c.id) { configs[i] = c; found = true; break; }
    }
    if (!found) configs.push(c);
    try { win.localStorage.setItem(CFG_KEY, JSON.stringify(configs)); } catch (e) {}
    return c;
  }

  function getConfigById(id) {
    var configs = getConfigs();
    for (var i = 0; i < configs.length; i++) {
      if (configs[i].id === id) return Promise.resolve(configs[i]);
    }
    return Promise.resolve(null);
  }

  function deleteConfig(id) {
    var configs = getConfigs().filter(function (c) { return c.id !== id; });
    try { win.localStorage.setItem(CFG_KEY, JSON.stringify(configs)); } catch (e) {}
    var active = getActiveConfig();
    if (active && active.id === id) setActiveConfig(null);
    return configs;
  }

  function setActiveConfig(id) {
    try {
      if (id) win.localStorage.setItem(ACTIVE_KEY, id);
      else win.localStorage.removeItem(ACTIVE_KEY);
    } catch (e) {}
  }

  function getActiveConfig() {
    var id = null;
    try { id = win.localStorage.getItem(ACTIVE_KEY); } catch (e) {}
    if (!id) return null;
    var configs = getConfigs();
    for (var i = 0; i < configs.length; i++) {
      if (configs[i].id === id) return configs[i];
    }
    return null;
  }

  // ── 暴露 ────────────────────────────────────────────────────────────────
  win.WebDavManager = {
    isNative: isNative,
    classifyError: classifyError,
    testConnection: testConnection,
    connect: connect,
    listDir: listDir,
    downloadFile: downloadFile,
    resyncBook: resyncBook,
    saveConfig: saveConfig,
    getConfigs: getConfigs,
    getConfigById: getConfigById,
    deleteConfig: deleteConfig,
    getActiveConfig: getActiveConfig,
    setActiveConfig: setActiveConfig,
    // 常量（UI / QA 只读）
    ERROR: ERROR,
    MESSAGES: MESSAGES,
    TIMEOUT_MS: TIMEOUT_MS,
    IMPORTABLE_EXT: IMPORTABLE_EXT,
    AUTH_TYPE: AUTH_TYPE
  };

}(window));
