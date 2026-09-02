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
 *   .deleteConfig(id)（预置返回 false）/ getActiveConfig() / setActiveConfig(id)
 *   .ERROR / .MESSAGES / .TIMEOUT_MS / .IMPORTABLE_EXT / .AUTH_TYPE
 */
(function (win) {
  'use strict';

  // ── 常量 ──────────────────────────────────────────────────────────────
  var TIMEOUT_MS = 30000;                 // 单文件/请求超时
  var PROBE_TIMEOUT_MS = 8000;             // 探测连接超时（多域名竞速）
  var IMPORTABLE_EXT = ['.txt', '.epub', '.md', '.markdown', '.pdf']; // 可导入扩展名

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
    // DEV-1（设计偏差修复）：原文案定论为 CORS 会误报（服务器宕机/网络不可达同样产生
    // 不透明 TypeError）。改为软化表述，仅提示「可能」为跨域；错误 type 字段保持 CORS 不变。
    CORS_WEB: '可能为跨域(CORS)限制（Web 端服务器宕机或网络不可达时同样会出现此提示）；建议改用 App 版本（原生安卓无此限制），或请在服务器端开启 CORS',
    NETWORK: '网络未连接，请检查网络',
    TIMEOUT: '超时（{sec}s），请重试',
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

  // localStorage 键（统一由 sync/webdav-config.js 提供，不迁移数据）
  // 本模块仍保留：AES-GCM 解密缓存、预置服务器合并、激活缓存（DEV-2）、多域名竞速
  var CFG_KEY = (win.BK && win.BK.WebDavConfig) ? win.BK.WebDavConfig.KEY_CONFIGS : 'bk_webdav_configs';
  var ACTIVE_KEY = (win.BK && win.BK.WebDavConfig) ? win.BK.WebDavConfig.KEY_ACTIVE : 'bk_webdav_active';

  // DEV-2（设计偏差修复）：模块内缓存当前激活的 config 对象（含 connect 但未 save 的）。
  // getActiveConfig 优先返回此缓存，fallback 到按存储 id 查找，保证「刚 connect 未保存」也能读到。
  var _activeConfigCache = null;

  // ── 竞速缓存（5 分钟 TTL + 网络变化失效）────────────────────────────────
  var RACE_CACHE_TTL = 5 * 60 * 1000;  // 5 分钟
  var _raceCache = {};                  // { configId: { url, ts } }
  var _lastOnlineState = null;          // 上次记录的 navigator.onLine 值

  // 检测网络变化：online/offline 切换时失效所有竞速缓存
  function _checkNetworkChange() {
    var current = navigator.onLine;
    if (_lastOnlineState !== null && _lastOnlineState !== current) {
      _raceCache = {};  // 网络变化 → 全部失效
    }
    _lastOnlineState = current;
    return current;
  }

  // 获取竞速缓存（未过期返回最快 URL，否则 null）
  function _getRaceCache(configId) {
    _checkNetworkChange();
    if (!configId) return null;
    var entry = _raceCache[configId];
    if (!entry) return null;
    if (Date.now() - entry.ts > RACE_CACHE_TTL) {
      delete _raceCache[configId];
      return null;
    }
    return entry.url;
  }

  // 写入竞速缓存
  function _setRaceCache(configId, url) {
    if (!configId || !url) return;
    _raceCache[configId] = { url: url, ts: Date.now() };
  }

  // 清除指定配置的竞速缓存（用于强制重新竞速）
  function _clearRaceCache(configId) {
    if (configId) {
      delete _raceCache[configId];
    } else {
      _raceCache = {};
    }
  }

  /**
   * 确保配置中的 URL 是经过竞速的最快节点（核心入口）
   * - 若缓存命中且未过期 → 直接替换 URL 并返回 config
   * - 若缓存未命中 → 走 pickFastestUrl 竞速，写入缓存后返回
   * - 单域名配置 → 直接返回（无需竞速）
   *
   * @param {object} config  WebDAV 配置（会被 normalizeConfig 处理）
   * @returns {Promise<object>}  替换了最快 URL 的 config 副本
   */
  function ensureRacedConfig(config) {
    var base = normalizeConfig(config);
    var candidates = candidateUrls(base);

    // 单域名无需竞速
    if (candidates.length <= 1) {
      return Promise.resolve(base);
    }

    var cachedUrl = _getRaceCache(base.id);
    if (cachedUrl) {
      // 缓存命中：替换 URL 为最快节点
      var raced = Object.assign({}, base, { url: cachedUrl, connectedUrl: cachedUrl });
      return Promise.resolve(raced);
    }

    // 缓存未命中：竞速
    return pickFastestUrl(base).then(function (picked) {
      _setRaceCache(base.id, picked.url);
      var raced = Object.assign({}, base, {
        url: picked.url,
        connectedUrl: picked.url,
        connectMs: picked.ms,
        multiNode: true
      });
      return raced;
    });
  }

  // ── 密码加密（AES-GCM via Web Crypto API）─────────────────────────────────
  // P1-1：用户配置的密码在 localStorage 中加密存储，密钥保存在 IndexedDB。
  // 预置服务器凭据由 base64 编码随包下发，不经过加密层。
  var _cryptoKey = null;       // CryptoKey 对象（null=未初始化）
  var _cryptoReady = null;     // Promise，crypto 初始化完成后 resolve
  var _configCache = null;     // 解密后的配置缓存（null=未初始化，降级读 raw）

  function _openKeyDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('bk_crypto', 1);
      req.onupgradeneeded = function (e) { e.target.result.createObjectStore('keys'); };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function _getKeyFromIDB() {
    return _openKeyDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('keys', 'readonly');
        tx.objectStore('keys').get('webdav_key').onsuccess = function (e) {
          resolve(e.target.result || null);
        };
        tx.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function _saveKeyToIDB(key) {
    return _openKeyDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('keys', 'readwrite');
        tx.objectStore('keys').put(key, 'webdav_key');
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  }

  function _encryptPassword(password) {
    if (!_cryptoKey || !password) return Promise.resolve(password || '');
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var data = new TextEncoder().encode(password);
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, _cryptoKey, data).then(function (buf) {
      var cipher = new Uint8Array(buf);
      var combined = new Uint8Array(iv.length + cipher.length);
      combined.set(iv, 0);
      combined.set(cipher, iv.length);
      var str = '';
      for (var i = 0; i < combined.length; i++) str += String.fromCharCode(combined[i]);
      return 'enc:' + btoa(str);
    });
  }

  function _decryptPassword(stored) {
    if (!_cryptoKey || !stored || stored.indexOf('enc:') !== 0) return Promise.resolve(stored || '');
    try {
      var raw = atob(stored.substring(4));
      var combined = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) combined[i] = raw.charCodeAt(i);
      var iv = combined.slice(0, 12);
      var cipher = combined.slice(12);
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, _cryptoKey, cipher).then(function (buf) {
        return new TextDecoder().decode(buf);
      });
    } catch (e) {
      return Promise.resolve(stored);
    }
  }

  function _getConfigsRaw() {
    // 统一读取原语（键名与回退行为对齐）：坏 JSON/非数组 → []，绝不抛异常
    if (win.BK && win.BK.WebDavConfig) {
      return win.BK.WebDavConfig.readSavedState(win).configs;
    }
    // 降级路径（WebDavConfig 未加载时保持原行为）
    try {
      return JSON.parse(win.localStorage.getItem(CFG_KEY) || '[]') || [];
    } catch (e) {
      return [];
    }
  }

  function _initCrypto() {
    if (_cryptoReady) return _cryptoReady;
    _cryptoReady = _getKeyFromIDB().then(function (key) {
      if (key) return key;
      return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']).then(function (k) {
        return _saveKeyToIDB(k).then(function () { return k; });
      });
    }).then(function (key) {
      _cryptoKey = key;
      var configs = _getConfigsRaw();
      return Promise.all(configs.map(function (c) {
        return _decryptPassword(c.password).then(function (pwd) {
          c.password = pwd;
          return c;
        });
      }));
    }).then(function (decrypted) {
      _configCache = decrypted;
    }).catch(function (e) {
      console.warn('[WebDAV] 加密初始化失败，降级为明文模式:', e);
      _configCache = _getConfigsRaw();
    });
    return _cryptoReady;
  }

  // 模块加载时启动 crypto 初始化（异步，不阻塞页面）
  _initCrypto();

  // ── 预置服务器（由 config.yaml 经 main.py 生成 webdav-presets.js 注入）──
  // 预置服务器随包下发，用户不可删除；其凭据以 base64(JSON) 编码，运行时解码。
  function decodePresets() {
    var raw = win.BK_WEBDAV_PRESETS || [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var p = raw[i] || {};
      var secret = {};
      try {
        // atob() 将每个字节当作 Latin-1 字符（码位 0-255），
        // 中文 UTF-8 多字节会被拆散为乱码。需先将 atob 结果转为 Uint8Array，
        // 再用 TextDecoder 以 UTF-8 解码，才能得到正确的中文 JSON。
        var b64raw = atob(p.secret || 'e30');  // 'e30' = '{}'
        var bytes = new Uint8Array(b64raw.length);
        for (var k = 0; k < b64raw.length; k++) bytes[k] = b64raw.charCodeAt(k);
        secret = JSON.parse(new TextDecoder('utf-8').decode(bytes)) || {};
      } catch (e) { secret = {}; }
      var pUrls = (secret.urls && secret.urls.length) ? secret.urls.slice() : null;
      var pUrl = pUrls ? pUrls[0] : (secret.url || '');
      out.push({
        id: p.id || ('preset-' + i),
        name: p.name || pUrl || ('预置服务器 ' + (i + 1)),
        url: pUrl,
        urls: pUrls,                // 多域名候选（可空）
        username: secret.username || '',
        password: secret.password || '',
        authType: secret.authType || 'basic',
        note: p.note || '',         // 明文备注（展示用）
        preset: true,               // 标记为预置，禁止删除/覆盖
        startPath: secret.startPath || ''  // 预置服务器初始目录路径
      });
    }
    return out;
  }
  var _presets = decodePresets();

  // 清理 localStorage 中残留的预置服务器条目（避免 getAllConfigs 重复）
  (function _cleanupPresetDupes() {
    try {
      var raw = win.localStorage.getItem(CFG_KEY);
      if (!raw) return;
      var configs = JSON.parse(raw);
      if (!Array.isArray(configs)) return;
      var presetIds = {};
      for (var k = 0; k < _presets.length; k++) presetIds[_presets[k].id] = true;
      var cleaned = configs.filter(function(c) { return !presetIds[c.id]; });
      if (cleaned.length !== configs.length) {
        win.localStorage.setItem(CFG_KEY, JSON.stringify(cleaned));
      }
    } catch (e) {}
  })();

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
  // skipAuth: 预置服务器读操作（PROPFIND/GET）免密时传 true
  function buildHeaders(config, extra, skipAuth) {
    var headers = extra || {};
    // 预置服务器读操作免密：浏览/下载不带 Authorization
    if (skipAuth && config && config.preset) return headers;
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

  // ── 工具：安全解码 URL 组件（仅当含 %XX 序列时才尝试解码）──────────────
  function safeDecode(s) {
    if (!s) return s;
    if (!/%[0-9A-Fa-f]{2}/.test(s)) return s;  // 无编码序列，原样返回
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  // ── 工具：确保路径段已 URL 编码（处理中文等非 ASCII 字符）─────────────
  // 先尝试解码（兼容已编码路径），再统一编码，避免双重编码
  function encodePathSegments(path) {
    if (!path) return path;
    return path.split('/').map(function (seg) {
      if (!seg) return seg;
      try { seg = decodeURIComponent(seg); } catch (e) { /* 已是原始或非法序列，保持原样 */ }
      return encodeURIComponent(seg);
    }).join('/');
  }

  // ── 工具：拼接目录 URL ──────────────────────────────────────────────────
  // path 可为 ''（根）、绝对 href（导航进子目录）、或相对路径
  function buildDirUrl(baseUrl, path) {
    baseUrl = trimSlash(baseUrl);
    if (!path) return baseUrl + '/';               // 集合需以 / 结尾
    if (/^[a-z][a-z0-9+.\-]*:/i.test(path)) return path; // 绝对 URL 直接返回
    // 对相对路径中的非 ASCII 字符进行 URL 编码（兼容中文路径）
    return baseUrl + '/' + encodePathSegments(path.replace(/^\/+/, ''));
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
    if (ext === 'pdf') return 'application/pdf';
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
  // timeoutMs: 实际超时毫秒数，用于生成准确的超时提示
  function classifyError(err, resp, timeoutMs) {
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
      var sec = timeoutMs ? Math.round(timeoutMs / 1000) : 30;
      return { type: ERROR.TIMEOUT, hint: MESSAGES.TIMEOUT.replace('{sec}', sec) };
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
  // timeoutMs: 实际超时毫秒数，用于生成准确的超时提示
  function wrapError(err, resp, timeoutMs) {
    var c = classifyError(err, resp, timeoutMs);
    var e = new Error(c.hint);
    e.type = c.type;
    if (resp) e.status = resp.status;
    e.resp = resp || null;
    return e;
  }

  // ── PROPFIND 请求（返回 {resp, text}）──────────────────────────────────
  // 返回对象附加 _timeoutMs 供上层 wrapError 使用
  function propfind(url, config, depth, timeoutMs, externalSignal) {
    var effectiveTimeout = timeoutMs || TIMEOUT_MS;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, effectiveTimeout);
    // P2-4：支持外部信号取消（多域名竞速时首个成功取消其余）
    if (externalSignal) {
      if (externalSignal.aborted) { controller.abort(); }
      else { externalSignal.addEventListener('abort', function () { controller.abort(); }); }
    }
    // 预置服务器读操作免密：PROPFIND 带正常认证（服务器可能要求）
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
      // 附带超时毫秒数，供上层 wrapError 生成准确的超时提示
      err._timeoutMs = effectiveTimeout;
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
      // DEV-3（设计偏差修复）：目录缺 <displayname> 且 href 带尾斜杠时，
      // 旧逻辑 split('/').pop() 为空 → 回退为原始相对 href（如 /dav/sub/，不美观）。
      // 改为取最后一个非空路径段；仍为空才回退「未命名」。对绝对/相对 href 均正确。
      var fallbackName = hrefUrl.split('/').filter(Boolean).pop() || '未命名';
      var decodedName = safeDecode(fallbackName);
      // 部分服务器返回 URL 编码的 displayname（如 %E4%B8%AD），需尝试解码
      var rawName = nameEl ? textOf(nameEl) : '';
      var name = rawName ? safeDecode(rawName) : decodedName;

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
    return ensureRacedConfig(config).then(function (cfg) {
      path = path || '';
      var url = buildDirUrl(cfg.url, path);
      return propfind(url, cfg, '1').then(function (result) {
        var resp = result.resp;
        if (!resp.ok) throw wrapError(null, resp, TIMEOUT_MS);
        var entries = parseMultistatus(result.text, url);
        // 过滤掉"自身"（Depth:1 会返回当前集合 + 子项）
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
        throw wrapError(err, err.resp, err._timeoutMs || TIMEOUT_MS);     // fetch 抛错 → 分类
      });
    });
  }

  // ── 测试连接（PROPFIND Depth:0，多域名时选最快可达）────────────────────
  function testConnection(config) {
    var base = normalizeConfig(config);
    return pickFastestUrl(base).then(function (picked) {
      return { ok: true, status: picked.status || 200, url: picked.url, ms: picked.ms, single: !!picked.single };
    }).catch(function (err) {
      if (err && err.type) throw err;
      throw wrapError(err, err && err.resp, err && err._timeoutMs ? err._timeoutMs : PROBE_TIMEOUT_MS);
    });
  }

  // ── 连接：保存（可选）+ 设为激活 + 列根目录（多域名选最快节点）──────────
  // OPT-1：用 Depth:1 竞速，首个成功节点同时拿到目录内容，省去后续 listDir 重复请求
  function connect(cfg, opts) {
    opts = opts || {};
    var base = normalizeConfig(cfg);
    var initialPath = opts.initialPath || '';
    // P1-1：确保 crypto 就绪后再连接（保证 saveConfig 能正确加密）
    return _initCrypto().then(function () {
      return pickFastestUrl(base, null, '1', initialPath);
    }).then(function (picked) {
      // 竞速成功 → 写入缓存
      _setRaceCache(base.id, picked.url);
      // 以最快节点 url 作为本次连接地址；保留 urls 供记录/重连
      var config = Object.assign({}, base, {
        url: picked.url,
        connectedUrl: picked.url,
        connectMs: picked.ms,
        multiNode: candidateUrls(base).length > 1
      });
      if (opts.save) saveConfig(config);
      setActiveConfig(config.id);
      // DEV-2：缓存当前激活 config（含未保存），保证 getActiveConfig 对「刚 connect 未保存」也返回。
      _activeConfigCache = config;
      // OPT-1：直接从竞速响应解析目录，不再发 listDir
      var entries = parseMultistatus(picked.text, picked.dirUrl);
      entries = entries.filter(function (en) {
        return normalizeHref(en.href) !== normalizeHref(picked.dirUrl);
      });
      entries.sort(function (a, b) {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh');
      });
      return { config: config, entries: entries, picked: picked };
    }).catch(function (err) {
      // 探测/连接失败：若多域名则给出明确提示
      if (err && err.type) throw err;
      throw wrapError(err, err && err.resp, err && err._timeoutMs ? err._timeoutMs : PROBE_TIMEOUT_MS);
    });
  }

  // P1-2：根据文件大小动态计算下载超时（base 30s + 10s/MB，上限 300s）
  function calcDownloadTimeout(size) {
    if (!size || size <= 0) return 60000; // 未知大小时给 60s
    var sizeMB = size / (1024 * 1024);
    var timeout = 30000 + sizeMB * 10000; // 30s base + 10s per MB
    return Math.min(300000, Math.max(30000, Math.round(timeout)));
  }

  // ── 工具：替换 URL 中的 origin（协议+域名+端口）────────────────────────
  // 当 entry.remotePath 来自 PROPFIND 响应（含原始域名），但竞速后需用最快节点访问
  function _replaceUrlOrigin(originalUrl, newBaseUrl) {
    if (!originalUrl || !newBaseUrl) return originalUrl;
    // 已经同源则无需替换
    try {
      var origParsed = new URL(originalUrl);
      var newParsed = new URL(newBaseUrl);
      if (origParsed.origin === newParsed.origin) return originalUrl;
      return newParsed.origin + origParsed.pathname + origParsed.search + origParsed.hash;
    } catch (e) {
      return originalUrl;
    }
  }

  // ── 下载单文件（GET + 流式进度）───────────────────────────────────────
  // onProgress(p): p ∈ [0,1]；服务器未返回 Content-Length 时 p = -1
  // 返回 fileInfo: { name, mime, text?|arrayBuffer?, size, remotePath }
  function downloadFile(config, entry, onProgress) {
    return ensureRacedConfig(config).then(function (cfg) {
      var rawUrl = entry.remotePath || entry.href;
      // 若 entry 中的 URL 来自先前 PROPFIND（可能指向旧节点），替换为竞速后的域名
      var url = _replaceUrlOrigin(rawUrl, cfg.url);
      var ext = (entry.name || '').split('.').pop().toLowerCase();
      var controller = new AbortController();
      var timeoutMs = calcDownloadTimeout(entry.size);
      var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

      function fail(err) {
        clearTimeout(timer);
        if (err.type) throw err;
        if (err.name === 'AbortError') throw wrapError(err, null, timeoutMs);
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw wrapError(err, null, timeoutMs);
        if (!isNative() && (err instanceof TypeError || /Failed to fetch/i.test(err.message || ''))) {
          throw wrapError(err, null, timeoutMs);
        }
        throw wrapError(err, null, timeoutMs);
      }

      return fetch(url, {
        method: 'GET',
        headers: buildHeaders(cfg, {}),
        signal: controller.signal,
        cache: 'no-cache'  // 避免被 SW 缓存策略拦截，确保始终从服务器获取最新数据
      }).then(function (resp) {
        if (!resp.ok) {
          clearTimeout(timer);
          throw wrapError(null, resp, timeoutMs);
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
                // P1-2：收到数据后重置超时计时器（idle timeout 模式）
                clearTimeout(timer);
                timer = setTimeout(function () { controller.abort(); }, timeoutMs);
                if (onProgress) onProgress(total > 0 ? Math.min(1, received / total) : -1);
                return pump();
              });
            }
          return pump().catch(fail);
        }

        // 退化：无流式 reader，一次性读取
        clearTimeout(timer);
        if (ext === 'epub' || ext === 'pdf') {
          return resp.arrayBuffer().then(function (buf) {
            return assemble([new Uint8Array(buf)], buf.byteLength, ext, entry, url);
          });
        }
        return resp.text().then(function (text) {
          var bytes = new TextEncoder().encode(text);
          return assemble([bytes], bytes.length, ext, entry, url);
        });
      }).catch(fail);
    });
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
    if (ext === 'pdf') {
      base.mime = entry.mime || 'application/pdf';
      base.arrayBuffer = full.buffer;
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
        name: safeDecode(source.remotePath.split('/').pop()) || (book.title || 'book'),
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

  // ── 多域名：候选 URL 解析 ──────────────────────────────────────────────
  // 合并 cfg.urls（数组）与 cfg.url（单值），去重、去尾斜杠，返回候选列表。
  function candidateUrls(cfg) {
    cfg = cfg || {};
    var raw = [];
    if (cfg.urls && cfg.urls.length) {
      for (var i = 0; i < cfg.urls.length; i++) {
        var u = trimSlash((cfg.urls[i] || '').trim());
        if (u) raw.push(u);
      }
    }
    var single = trimSlash((cfg.url || '').trim());
    if (single && raw.indexOf(single) === -1) raw.push(single);
    var seen = {}, out = [];
    for (var j = 0; j < raw.length; j++) {
      if (!seen[raw[j]]) { seen[raw[j]] = 1; out.push(raw[j]); }
    }
    return out;
  }

  // 探测单个 URL 是否可达（PROPFIND），成功返回 {url, ms, status, text, dirUrl}
  // OPT-1：增加 depth 参数（默认 '0'），返回 text + dirUrl 供调用方直接解析目录
  function probeUrl(cfg, url, timeoutMs, depth, externalSignal, path) {
    var dirUrl = buildDirUrl(url, path || '');
    var t0 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
    var effectiveTimeout = timeoutMs || PROBE_TIMEOUT_MS;
    return propfind(dirUrl, cfg, depth || '0', effectiveTimeout, externalSignal).then(function (result) {
      var resp = result.resp;
      if (!resp.ok) throw wrapError(null, resp, effectiveTimeout);
      var t1 = (win.performance && win.performance.now) ? win.performance.now() : Date.now();
      return { url: url, ms: Math.round(t1 - t0), status: resp.status, text: result.text, dirUrl: dirUrl };
    }).catch(function (err) {
      // 透传带 _timeoutMs 的错误，否则补充 timeoutMs
      if (!err._timeoutMs) err._timeoutMs = effectiveTimeout;
      throw err;
    });
  }

  // 竞速：取第一个成功结果（即最快可达节点）；全部失败才 reject
  function firstSuccess(promises) {
    return new Promise(function (resolve, reject) {
      var n = promises.length;
      if (n === 0) { reject(new Error('未配置 URL')); return; }
      var errors = [], pending = n;
      promises.forEach(function (p, i) {
        Promise.resolve(p).then(function (val) {
          resolve(val); // 首个成功者胜出（并发下即最快节点）
        }, function (err) {
          errors[i] = err;
          pending--;
          if (pending === 0) reject(errors.filter(Boolean)[0] || new Error('所有节点均不可达'));
        });
      });
    });
  }

  // ── 多节点错误汇总：生成「N个节点超时，M个403…」格式的简洁摘要 ──────
  function _summarizeMultiErrors(errors, urls) {
    var byType = {};  // type → count
    for (var i = 0; i < errors.length; i++) {
      var e = errors[i];
      if (!e) continue;
      var c = classifyError(e, e.resp, e._timeoutMs);
      byType[c.type] = (byType[c.type] || 0) + 1;
    }
    var parts = [];
    if (byType[ERROR.TIMEOUT]) parts.push(byType[ERROR.TIMEOUT] + '个超时');
    if (byType[ERROR.AUTH]) parts.push(byType[ERROR.AUTH] + '个认证失败');
    if (byType[ERROR.NETWORK]) parts.push(byType[ERROR.NETWORK] + '个网络不可达');
    if (byType[ERROR.CORS]) parts.push(byType[ERROR.CORS] + '个跨域受限');
    if (byType[ERROR.SERVER]) parts.push(byType[ERROR.SERVER] + '个服务器错误');
    if (byType[ERROR.UNKNOWN]) parts.push(byType[ERROR.UNKNOWN] + '个未知错误');
    return parts.length ? urls.length + '个节点全部失败：' + parts.join('，') : '所有节点均不可达';
  }

  // P2-4 + P3-6：多域名竞速时首个成功即 abort 其余请求；超时使用 PROBE_TIMEOUT_MS
  function pickFastestUrl(cfg, timeoutMs, depth, path) {
    var urls = candidateUrls(cfg);
    if (urls.length === 0) return Promise.reject(new Error('未配置 WebDAV 地址'));
    if (urls.length === 1) return probeUrl(cfg, urls[0], timeoutMs || PROBE_TIMEOUT_MS, depth, null, path);
    // 多域名：为每个探测创建 AbortController，首个成功后取消其余
    var controllers = urls.map(function () { return new AbortController(); });
    var probes = urls.map(function (u, i) {
      return probeUrl(cfg, u, timeoutMs || PROBE_TIMEOUT_MS, depth, controllers[i].signal, path);
    });
    return new Promise(function (resolve, reject) {
      var errors = [], pending = probes.length;
      probes.forEach(function (p, i) {
        Promise.resolve(p).then(function (val) {
          // 首个成功：取消其余所有探测
          controllers.forEach(function (c, j) { if (j !== i) { try { c.abort(); } catch (e) {} } });
          resolve(val);
        }, function (err) {
          errors[i] = err;
          pending--;
          if (pending === 0) {
            // 全部失败：汇总错误信息，帮助用户诊断
            var firstErr = errors.filter(Boolean)[0];
            var timeoutMs = firstErr && firstErr._timeoutMs ? firstErr._timeoutMs : (timeoutMs || PROBE_TIMEOUT_MS);
            var summary = _summarizeMultiErrors(errors, urls);
            var e = wrapError(firstErr, firstErr && firstErr.resp, timeoutMs);
            e.message = summary + '（' + e.message + '）';
            reject(e);
          }
        });
      });
    });
  }

  // ── 配置管理（localStorage）───────────────────────────────────────────
  function normalizeConfig(cfg) {
    cfg = cfg || {};
    var urls = (cfg.urls && cfg.urls.length) ? cfg.urls.slice() : null;
    return {
      id: cfg.id || ('wd_' + Date.now()),
      name: cfg.name || 'WebDAV',
      url: trimSlash(cfg.url || ''),
      urls: urls,                       // 多域名候选（可空）
      username: cfg.username || '',
      password: cfg.password || '',          // 加密后存储（见 saveConfig/_initCrypto）
      authType: cfg.authType || 'basic',
      note: cfg.note || '',
      preset: !!cfg.preset,
      startPath: cfg.startPath || ''     // 预置服务器初始目录路径
    };
  }

  function getConfigs() {
    // P1-1：优先返回解密后的缓存（crypto 初始化后填充）
    if (_configCache) return _configCache;
    return _getConfigsRaw();
  }

  function saveConfig(config) {
    var c = normalizeConfig(config);
    var plaintextPwd = c.password;
    // 同步更新内存缓存（使用明文密码，供后续连接使用）
    if (_configCache) {
      var foundC = false;
      for (var ci = 0; ci < _configCache.length; ci++) {
        if (_configCache[ci].id === c.id) { _configCache[ci] = c; foundC = true; break; }
      }
      if (!foundC) _configCache.push(c);
    }
    // 异步加密密码后写入 localStorage
    _initCrypto().then(function () {
      return _encryptPassword(plaintextPwd);
    }).then(function (encPwd) {
      var toStore = Object.assign({}, c, { password: encPwd });
      var configs = _getConfigsRaw();
      var found = false;
      for (var i = 0; i < configs.length; i++) {
        if (configs[i].id === toStore.id) { configs[i] = toStore; found = true; break; }
      }
      if (!found) configs.push(toStore);
      try {
        win.localStorage.setItem(CFG_KEY, JSON.stringify(configs));
      } catch (e) {
        // P2-5：不再静默吞错，记录到控制台
        console.error('[WebDAV] 保存配置失败:', e);
      }
    }).catch(function (e) {
      console.error('[WebDAV] 加密保存失败，降级明文写入:', e);
      // 降级：直接写明文（优于不保存）
      var configs = _getConfigsRaw();
      var found = false;
      for (var i = 0; i < configs.length; i++) {
        if (configs[i].id === c.id) { configs[i] = c; found = true; break; }
      }
      if (!found) configs.push(c);
      try { win.localStorage.setItem(CFG_KEY, JSON.stringify(configs)); } catch (e2) {}
    });
    return c;
  }

  function getConfigById(id) {
    // 先查预置（持久，随包下发）
    for (var k = 0; k < _presets.length; k++) {
      if (_presets[k].id === id) return Promise.resolve(_presets[k]);
    }
    // P1-1：等待 crypto 初始化后返回解密配置
    return _initCrypto().then(function () {
      var configs = getConfigs();
      for (var i = 0; i < configs.length; i++) {
        if (configs[i].id === id) return configs[i];
      }
      return null;
    });
  }

  // 全部可用配置：预置（在前）+ 用户已保存（在后），按 ID 去重（预置优先）
  function getAllConfigs() {
    var saved = getConfigs();
    var presetIds = {};
    for (var k = 0; k < _presets.length; k++) presetIds[_presets[k].id] = true;
    var deduped = [];
    for (var i = 0; i < saved.length; i++) {
      if (!presetIds[saved[i].id]) deduped.push(saved[i]);
    }
    return _presets.concat(deduped);
  }

  function setActiveConfig(id) {
    try {
      if (id) win.localStorage.setItem(ACTIVE_KEY, id);
      else win.localStorage.removeItem(ACTIVE_KEY);
    } catch (e) {}
    // DEV-2：按 id 在存储中查找并缓存激活 config（未保存的 config 由 connect 直接写 _activeConfigCache）。
    // 预置 id 不在 bk_webdav_configs 存储，需优先按 getActiveConfig 的回退顺序查 _presets。
    if (!id) {
      _activeConfigCache = null;
      return;
    }
    for (var p = 0; p < _presets.length; p++) {
      if (_presets[p].id === id) { _activeConfigCache = _presets[p]; return; }
    }
    var configs = getConfigs();
    for (var i = 0; i < configs.length; i++) {
      if (configs[i].id === id) { _activeConfigCache = configs[i]; break; }
    }
  }

  // 删除用户配置：从 bk_webdav_configs 移除 + 激活 id 回退 + 双缓存同步。
  // 预置服务器（preset:true，随包下发）不可删，返回 false。
  // 纯逻辑（删除/回退）由 sync/webdav-config.js 的 removeConfig/resolveActiveAfterRemove 提供。
  function deleteConfig(id) {
    if (!id) return false;
    for (var p = 0; p < _presets.length; p++) {
      if (_presets[p].id === id) return false;
    }
    var raw = _getConfigsRaw();
    var found = false;
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] && raw[i].id === id) { found = true; break; }
    }
    if (!found) return false;

    var WC = (win.BK && win.BK.WebDavConfig) ? win.BK.WebDavConfig : null;
    var remaining = WC ? WC.removeConfig(raw, id) : raw.filter(function (c) { return !(c && c.id === id); });
    var activeIdBefore = null;
    try { activeIdBefore = win.localStorage.getItem(ACTIVE_KEY) || null; } catch (e) {}
    var fb = WC ? WC.resolveActiveAfterRemove(remaining, id, activeIdBefore) : (function () {
      var act = (activeIdBefore && activeIdBefore === id)
        ? (remaining.length ? remaining[0].id : null)
        : activeIdBefore;
      var actObj = null;
      for (var a = 0; a < remaining.length; a++) {
        if (act && remaining[a] && remaining[a].id === act) { actObj = remaining[a]; break; }
      }
      return { activeId: act, active: actObj };
    })();

    // 写回配置存储 + 同步解密缓存
    try { win.localStorage.setItem(CFG_KEY, JSON.stringify(remaining)); } catch (e2) {}
    if (_configCache) {
      _configCache = WC ? WC.removeConfig(_configCache, id)
        : _configCache.filter(function (c) { return !(c && c.id === id); });
    }
    // 激活 id 写回 + DEV-2 激活缓存同步
    try {
      if (fb.activeId) win.localStorage.setItem(ACTIVE_KEY, fb.activeId);
      else win.localStorage.removeItem(ACTIVE_KEY);
    } catch (e3) {}
    _activeConfigCache = fb.active;
    return true;
  }

  function getActiveConfig() {
    // DEV-2：优先返回模块内缓存（含 connect 但未保存的 config）
    if (_activeConfigCache) return _activeConfigCache;
    var id = null;
    try { id = win.localStorage.getItem(ACTIVE_KEY); } catch (e) {}
    if (!id) return null;
    // 预置（持久）
    for (var k = 0; k < _presets.length; k++) {
      if (_presets[k].id === id) return _presets[k];
    }
    // 已保存
    var configs = getConfigs();
    for (var i = 0; i < configs.length; i++) {
      if (configs[i].id === id) return configs[i];
    }
    return null;
  }

  // ── MKCOL：创建远程目录（WebDAV）────────────────────────────────────
  function mkcol(config, path) {
    return ensureRacedConfig(config).then(function (cfg) {
      var url = buildDirUrl(cfg.url, path);
      // MKCOL 对集合路径需不带尾斜杠
      url = trimSlash(url);
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
      return fetch(url, {
        method: 'MKCOL',
        headers: buildHeaders(cfg, {}),
        signal: controller.signal
      }).then(function (resp) {
        clearTimeout(timer);
        // 201=已创建, 405=已存在（均视为成功）
        if (resp.status === 201 || resp.status === 405) {
          return { ok: true, status: resp.status };
        }
        throw wrapError(null, resp, TIMEOUT_MS);
      }).catch(function (err) {
        clearTimeout(timer);
        if (err.type) throw err;
        throw wrapError(err, null, TIMEOUT_MS);
      });
    });
  }

  // ── DELETE：删除远程资源（文件或空目录）──────────────────────────────
  // remotePath: 完整 URL 或相对路径
  function deleteResource(config, remotePath) {
    return ensureRacedConfig(config).then(function (cfg) {
      var url;
      if (remotePath && /^[a-z][a-z0-9+.\-]*:/i.test(remotePath)) {
        // 绝对 URL：替换为竞速后的域名
        url = _replaceUrlOrigin(remotePath, cfg.url);
      } else {
        url = buildDirUrl(cfg.url, remotePath);
      }
      // 文件路径不带尾斜杠，目录路径可以带（部分服务器要求）
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
      return fetch(url, {
        method: 'DELETE',
        headers: buildHeaders(cfg, {}),
        signal: controller.signal
      }).then(function (resp) {
        clearTimeout(timer);
        // 204=已删除, 200=部分服务器返回, 404=不存在（幂等，视为成功）
        if (resp.status === 204 || resp.status === 200 || resp.status === 404) {
          return { ok: true, status: resp.status };
        }
        throw wrapError(null, resp, TIMEOUT_MS);
      }).catch(function (err) {
        clearTimeout(timer);
        if (err.type) throw err;
        throw wrapError(err, null, TIMEOUT_MS);
      });
    });
  }

  // ── 确保远程路径存在（逐级 MKCOL）───────────────────────────────────
  function ensureRemotePath(config, remotePath) {
    if (!remotePath) return Promise.resolve();
    return ensureRacedConfig(config).then(function (cfg) {
      // 拆分路径段，逐级创建
      var segments = remotePath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
      var chain = Promise.resolve();
      var currentPath = '';
      for (var i = 0; i < segments.length; i++) {
        (function (seg) {
          chain = chain.then(function () {
            currentPath = currentPath ? currentPath + '/' + seg : seg;
            // 直接用 raced config 调 mkcol 内部逻辑（避免每级都走 ensureRacedConfig）
            var url = trimSlash(buildDirUrl(cfg.url, currentPath));
            var controller = new AbortController();
            var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
            return fetch(url, {
              method: 'MKCOL',
              headers: buildHeaders(cfg, {}),
              signal: controller.signal
            }).then(function (resp) {
              clearTimeout(timer);
              if (resp.status === 201 || resp.status === 405) {
                return { ok: true, status: resp.status };
              }
              throw wrapError(null, resp, TIMEOUT_MS);
            }).catch(function (err) {
              clearTimeout(timer);
              // 405 = 已存在，不算错误
              if (err && err.status === 405) return;
              if (err.type) throw err;
              throw wrapError(err, null, TIMEOUT_MS);
            });
          });
        })(segments[i]);
      }
      return chain;
    });
  }

  // ── 上传单文件（PUT）─────────────────────────────────────────────────
  // data: string | Uint8Array | ArrayBuffer | Blob
  // onProgress(p): p ∈ [0,1]；无法追踪时 p = -1
  // 返回 { url, status, size }
  function uploadFile(config, remotePath, data, mime, onProgress) {
    return ensureRacedConfig(config).then(function (cfg) {
      var url = buildDirUrl(cfg.url, remotePath);
      url = trimSlash(url);
      var controller = new AbortController();
      // 上传超时：基于数据大小动态计算（30s base + 10s/MB，上限 300s）
      var dataSize = 0;
      if (typeof data === 'string') {
        dataSize = new TextEncoder().encode(data).length;
      } else if (data instanceof Uint8Array) {
        dataSize = data.length;
      } else if (data instanceof ArrayBuffer) {
        dataSize = data.byteLength;
      } else if (data && typeof data.size === 'number') {
        dataSize = data.size; // Blob
      }
      var timeoutMs = calcUploadTimeout(dataSize);
      var timer = setTimeout(function () { controller.abort(); }, timeoutMs);

      var headers = buildHeaders(cfg, {
        'Content-Type': mime || 'application/octet-stream'
      });
      // 对文本数据明确设置 Content-Length（部分服务器要求）
      if (typeof data === 'string') {
        var encoded = new TextEncoder().encode(data);
        headers['Content-Length'] = String(encoded.length);
        data = encoded; // 转为 Uint8Array 保证一致
      }

      function fail(err) {
        clearTimeout(timer);
        if (err.type) throw err;
        if (err.name === 'AbortError') throw wrapError(err, null, timeoutMs);
        throw wrapError(err, null, timeoutMs);
      }

      return fetch(url, {
        method: 'PUT',
        headers: headers,
        body: data,
        signal: controller.signal
      }).then(function (resp) {
        clearTimeout(timer);
        // 201=已创建, 204=已覆盖, 200=部分服务器返回
        if (resp.status === 201 || resp.status === 204 || resp.status === 200) {
          if (onProgress) onProgress(1);
          return { url: url, status: resp.status, size: dataSize };
        }
        throw wrapError(null, resp, timeoutMs);
      }).catch(function (err) {
        clearTimeout(timer);
        if (err.type) throw err;
        throw wrapError(err, null, timeoutMs);
      });
    });
  }

  // 上传超时计算（复用下载逻辑：30s base + 10s/MB，上限 300s）
  function calcUploadTimeout(size) {
    return calcDownloadTimeout(size); // 同样逻辑
  }

  // ── 暴露 ────────────────────────────────────────────────────────────────
  win.WebDavManager = {
    testConnection: testConnection,
    connect: connect,
    listDir: listDir,
    downloadFile: downloadFile,
    uploadFile: uploadFile,
    mkcol: mkcol,
    deleteResource: deleteResource,
    ensureRemotePath: ensureRemotePath,
    resyncBook: resyncBook,
    saveConfig: saveConfig,
    getConfigs: getConfigs,
    getConfigById: getConfigById,
    getAllConfigs: getAllConfigs,
    getActiveConfig: getActiveConfig,
    setActiveConfig: setActiveConfig,
    deleteConfig: deleteConfig,
    ensureCryptoReady: function () { return _cryptoReady || Promise.resolve(); },
    // 多域名 / 最快节点（供 UI 与测试）
    candidateUrls: candidateUrls,
    pickFastestUrl: pickFastestUrl,
    // 工具函数（供 webdav-upload.js 复用）
    buildHeaders: buildHeaders,
    buildDirUrl: buildDirUrl,
    trimSlash: trimSlash,
    encodePathSegments: encodePathSegments,
    basicAuthHeader: basicAuthHeader,
    // 竞速缓存（供外部强制清除或复用）
    ensureRacedConfig: ensureRacedConfig,
    clearRaceCache: _clearRaceCache,
    // 常量（UI / QA 只读）
    ERROR: ERROR,
    MESSAGES: MESSAGES,
    TIMEOUT_MS: TIMEOUT_MS,
    PROBE_TIMEOUT_MS: PROBE_TIMEOUT_MS,
    IMPORTABLE_EXT: IMPORTABLE_EXT,
    UPLOAD_EXT: ['.txt', '.epub', '.md', '.markdown', '.pdf']
  };

}(window));
