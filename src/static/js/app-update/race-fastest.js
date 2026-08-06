/*!
 * race-fastest.js — 全局镜像竞速工具
 *
 * 两类竞速，互不干扰：
 *   1. version 竞速：轻量级（几百字节），延迟优先
 *      → 竞速 CF 服务器的 version.json，选最快响应的
 *      → 用于 version.json / changelog.json / 赞助图等所有轻量 CF 请求
 *      → 持久化缓存（localStorage），不过期；请求失败时调用 invalidateVersion 重新竞速
 *
 *   2. download 竞速：下载 300KB 测速文件，带宽优先
 *      → 顺序下载每个服务器的 speedtest.bin，独占带宽，结果真实
 *      → 若某服务器已≥5MB/s，跳过剩余提前返回
 *      → 用于 APK 下载等大文件场景
 *      → 独立缓存 5 分钟，不复用 version 竞速结果
 *
 * 暴露：window.BK.RaceFastest
 *   .version()            → Promise<{serverUrl, data}>  CF version.json 竞速
 *   .download(serverUrls) → Promise<{serverUrl}>        下载竞速（speedtest.bin 测速）
 *   .invalidateVersion()  void                        清除 version 缓存（请求失败时调用）
 *   .getVersionCache()    → {serverUrl, data}|null      同步读缓存
 *   .clearCache()         void                          清除所有缓存
 */
(function () {
  'use strict';

  var _DL_TTL = 5 * 60 * 1000; // download 缓存 5 分钟
  var _LS_KEY_VER = 'bk_race_version'; // localStorage key

  // ── 缓存 ──────────────────────────────────────────────────────────
  var _verCache = null;   // { serverUrl, data, ts }
  var _verPending = null; // 防重复竞速

  var _dlCache = null;    // { serverUrl, bps, serverUrls, ts }
  var _dlPending = null;  // 防重复竞速

  // ── localStorage 持久化（version 竞速）─────────────────────────────
  function _lsLoadVer() {
    try {
      var raw = localStorage.getItem(_LS_KEY_VER);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (obj && obj.serverUrl) {
        return obj;
      }
      localStorage.removeItem(_LS_KEY_VER);
    } catch (e) {}
    return null;
  }

  function _lsSaveVer(obj) {
    try {
      localStorage.setItem(_LS_KEY_VER, JSON.stringify(obj));
    } catch (e) {}
  }

  // ── 网络变化监听（清除 download 缓存）────────────────────────────
  if (typeof window !== 'undefined') {
    window.addEventListener('online', function () {
      console.log('[RaceFastest] 网络恢复，清除 download 缓存');
      _dlCache = null;
      _dlPending = null;
    });
  }

  function _getCfServers() {
    return (window.BK_SERVERS && window.BK_SERVERS.cloudflare) || [];
  }

  /**
   * 读取 speedtest 配置（由 remote-config.js 注入）
   * 兜底值与 config.yaml 默认值一致
   */
  function _getSpeedtestConfig() {
    var cfg = window.BK_SERVERS || {};
    return {
      filename: cfg.speedtest_filename || 'speedtest.bin',
      sizeKb: cfg.speedtest_size_kb || 100,
      timeoutPerKb: cfg.speedtest_timeout_per_kb || 20,  // ms per KB
      fastEnoughMs: cfg.speedtest_fast_enough_ms || 2000  // 下载耗时≤此值认为够快
    };
  }

  // ── version 竞速（延迟优先）─────────────────────────────────────────
  /**
   * 竞速 CF 服务器的 version.json（几百字节），选最快响应的服务器
   * 结果全局缓存 5 分钟，所有轻量 CF 请求复用
   *
   * @returns {Promise<{serverUrl: string, data: object}>}
   *   serverUrl: 最快 CF 服务器 URL（含尾部 /）
   *   data: version.json 解析后的对象
   */
  function raceVersion() {
    // 内存缓存命中（不过期，仅 invalidateVersion 清除）
    if (_verCache) {
      console.log('[RaceFastest] version 缓存命中: ' + _verCache.serverUrl);
      return Promise.resolve({ serverUrl: _verCache.serverUrl, data: _verCache.data });
    }

    // 尝试从 localStorage 恢复（页面刷新后仍可用）
    var lsCache = _lsLoadVer();
    if (lsCache) {
      _verCache = lsCache;
      console.log('[RaceFastest] version 缓存恢复(localStorage): ' + lsCache.serverUrl);
      return Promise.resolve({ serverUrl: lsCache.serverUrl, data: lsCache.data });
    }

    // 防重复：已有进行中的竞速，复用
    if (_verPending) return _verPending;

    var servers = _getCfServers();
    if (!servers.length) {
      return Promise.reject(new Error('无可用 CF 服务器'));
    }

    console.log('[RaceFastest] 开始 version 竞速（' + servers.length + ' 个服务器）');

    _verPending = new Promise(function (resolve) {
      var ts = Date.now();

      // 检测 CapacitorHttp（APK 环境优先使用，绕过 WebView CORS 限制）
      var CapacitorHttp = null;
      if (window.Capacitor) {
        CapacitorHttp = window.Capacitor.CapacitorHttp
          || (window.Capacitor.Plugins && (window.Capacitor.Plugins.CapacitorHttp || window.Capacitor.Plugins.Http))
          || null;
      }
      console.log('[RaceFastest] version 竞速请求方式: ' + (CapacitorHttp ? 'CapacitorHttp（原生HTTP，无CORS限制）' : 'fetch（浏览器标准请求）'));

      var fetches = servers.map(function (url) {
        var fullUrl = url + 'version.json?t=' + ts;
        if (CapacitorHttp) {
          // APK 环境：使用 CapacitorHttp 原生 HTTP 请求，无 CORS 限制
          console.log('[RaceFastest] version 竞速 CapacitorHttp 请求: ' + fullUrl);
          return CapacitorHttp.get({ url: fullUrl, connectTimeout: 5000, readTimeout: 8000 })
            .then(function (resp) {
              console.log('[RaceFastest] version 竞速 CapacitorHttp 响应: ' + url + ' → HTTP ' + resp.status);
              if (resp.status !== 200) throw new Error('HTTP ' + resp.status);
              var d = (typeof resp.data === 'string') ? JSON.parse(resp.data) : resp.data;
              return { serverUrl: url, data: d };
            })
            .catch(function (e) {
              console.warn('[RaceFastest] version 竞速 CapacitorHttp 失败: ' + url + ' → ' + (e.message || e));
              throw e;
            });
        }
        // Web/PWA 环境：使用 fetch
        console.log('[RaceFastest] version 竞速 fetch 请求: ' + fullUrl);
        return fetch(fullUrl, { cache: 'no-cache' })
          .then(function (r) {
            console.log('[RaceFastest] version 竞速 fetch 响应: ' + url + ' → HTTP ' + r.status);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json().then(function (d) {
              return { serverUrl: url, data: d };
            });
          })
          .catch(function (e) {
            console.warn('[RaceFastest] version 竞速 fetch 失败: ' + url + ' → ' + (e.message || e));
            throw e;
          });
      });

      // Promise.any 语义：取第一个成功的
      var race = typeof Promise.any === 'function'
        ? Promise.any(fetches)
        : new Promise(function (res) {
            var done = false;
            fetches.forEach(function (p) {
              p.then(function (d) { if (!done) { done = true; res(d); } }).catch(function () {});
            });
            setTimeout(function () { if (!done) res(null); }, 8000);
          });

      race.then(function (result) {
        if (result) {
          _verCache = { serverUrl: result.serverUrl, data: result.data, ts: Date.now() };
          _lsSaveVer(_verCache); // 持久化，重启后仍可用
          console.log('[RaceFastest] version 竞速完成: ' + result.serverUrl);
        }
        _verPending = null;
        resolve(result || Promise.reject(new Error('所有服务器均无法访问')));
      }).catch(function (err) {
        console.error('[RaceFastest] version 竞速全部失败:', err.message || err);
        _verPending = null;
        resolve(Promise.reject(err));
      });
    });

    return _verPending;
  }

  // ── download 竞速（带宽优先，300KB 测速文件）────────────────────────
  /**
   * 对候选服务器逐个顺序下载 speedtest.bin（300KB），选实际吞吐最高的服务器
   * 顺序执行，独占带宽，测速结果真实可靠
   * 独立于 version 竞速，不复用其结果
   *
   * @param {Array<string>} serverUrls  候选服务器 URL 列表（如 CF 服务器地址）
   *   每个 URL 应为站点根路径（含尾部 /），函数会自动拼接 speedtest.bin
   * @returns {Promise<{serverUrl: string, bps: number}>}  最优服务器 URL 及其实测带宽
   */
  function raceDownload(serverUrls) {
    if (!serverUrls || !serverUrls.length) {
      return Promise.reject(new Error('无候选服务器 URL'));
    }
    // 单服务器无需竞速
    if (serverUrls.length === 1) {
      return Promise.resolve({ serverUrl: serverUrls[0], bps: 0 });
    }

    var now = Date.now();
    // 缓存命中（相同服务器列表，TTL 内有效）
    if (_dlCache && (now - _dlCache.ts < _DL_TTL) && _dlCache.serverUrls) {
      var match = true;
      if (_dlCache.serverUrls.length !== serverUrls.length) {
        match = false;
      } else {
        for (var i = 0; i < serverUrls.length; i++) {
          if (_dlCache.serverUrls[i] !== serverUrls[i]) { match = false; break; }
        }
      }
      if (match) {
        console.log('[RaceFastest] download 缓存命中: ' + _dlCache.serverUrl);
        return Promise.resolve({ serverUrl: _dlCache.serverUrl, bps: _dlCache.bps || 0 });
      }
    }

    // 防重复
    if (_dlPending) return _dlPending;

    console.log('[RaceFastest] 开始 download 竞速（' + serverUrls.length + ' 个服务器，顺序下载测速）');

    _dlPending = _raceDownloadSeq(serverUrls).then(function (result) {
      if (result) {
        _dlCache = { serverUrl: result.serverUrl, serverUrls: serverUrls, bps: result.bps, ts: Date.now() };
      }
      _dlPending = null;
      if (!result) throw new Error('所有下载线路都不可用');
      return result;
    }).catch(function (err) {
      _dlPending = null;
      throw err;
    });

    return _dlPending;
  }

  /**
   * 顺序测速：逐个下载 speedtest.bin，独占带宽，结果真实
   * 如果某个服务器已经很快（≥5MB/s），跳过后续服务器提前返回
   */
  function _raceDownloadSeq(serverUrls) {
    // 检测 CapacitorHttp（APK 环境优先使用）
    var CapacitorHttp = null;
    if (window.Capacitor) {
      CapacitorHttp = window.Capacitor.CapacitorHttp
        || (window.Capacitor.Plugins && (window.Capacitor.Plugins.CapacitorHttp || window.Capacitor.Plugins.Http))
        || null;
    }

    var stCfg = _getSpeedtestConfig();
    var best = null;
    var bestBps = -1;
    var idx = 0;

    function testNext() {
      if (idx >= serverUrls.length) {
        // 全部测完
        if (best) {
          console.log('[RaceFastest] download 竞速完成: ' + best.serverUrl +
            ' (' + Math.round(bestBps / 1024) + ' KB/s)');
        }
        return Promise.resolve(best);
      }

      var serverUrl = serverUrls[idx++];
      var testUrl = serverUrl.replace(/\/+$/, '') + '/' + stCfg.filename;

      return _downloadTest(CapacitorHttp, testUrl, serverUrl, stCfg).then(function (result) {
        if (result) {
          console.log('[RaceFastest] ' + serverUrl + ' → ' +
            Math.round(result.bps / 1024) + ' KB/s (' + result.elapsed + 'ms)');
          if (result.bps > bestBps) {
            bestBps = result.bps;
            best = result;
          }
          // 已经够快，无需再测后续服务器
          if (result.elapsed <= stCfg.fastEnoughMs) {
            console.log('[RaceFastest] 耗时 ' + result.elapsed + 'ms ≤ ' + stCfg.fastEnoughMs + 'ms，跳过剩余服务器');
            return best;
          }
        } else {
          console.log('[RaceFastest] ' + serverUrl + ' → 失败');
        }
        return testNext();
      });
    }

    return testNext();
  }

  /** 下载单个测速文件并计算 bps，超时按大小等比缩放并自动取消请求 */
  function _downloadTest(CapacitorHttp, testUrl, serverUrl, stCfg) {
    // 总超时 = 文件大小(KB) × 每 KB 超时(ms)，如 100KB × 20ms = 2s，最小 4s
    var timeoutMs = Math.max(4000, stCfg.sizeKb * stCfg.timeoutPerKb);

    return new Promise(function (resolve) {
      var startTime = Date.now();
      var aborted = false;

      // 超时取消请求，避免挂起的 fetch 占用带宽影响后续测速
      var abortCtrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timeout = setTimeout(function () {
        aborted = true;
        if (abortCtrl) {
          try { abortCtrl.abort(); } catch (e) {}
        }
        console.log('[RaceFastest] ' + serverUrl + ' → 超时 (' + timeoutMs + 'ms)');
        resolve(null);
      }, timeoutMs);

      if (CapacitorHttp) {
        CapacitorHttp.get({
          url: testUrl,
          connectTimeout: 5000,
          readTimeout: timeoutMs
        }).then(function (response) {
          clearTimeout(timeout);
          if (aborted) return; // 已超时，丢弃
          var elapsed = Date.now() - startTime;
          if (response.status === 200) {
            var size = 0;
            if (response.data instanceof ArrayBuffer) {
              size = response.data.byteLength;
            } else if (typeof response.data === 'string') {
              size = response.data.length;
            } else if (response.data) {
              size = JSON.stringify(response.data).length;
            }
            var bps = elapsed > 0 ? (size * 1000 / elapsed) : 0;
            resolve({ serverUrl: serverUrl, bps: bps, elapsed: elapsed });
          } else {
            resolve(null);
          }
        }).catch(function () {
          clearTimeout(timeout);
          if (aborted) return;
          resolve(null);
        });
      } else {
        var fetchOpts = { cache: 'no-cache' };
        if (abortCtrl) fetchOpts.signal = abortCtrl.signal;
        fetch(testUrl, fetchOpts).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        }).then(function (buf) {
          clearTimeout(timeout);
          if (aborted) return;
          var elapsed = Date.now() - startTime;
          var bps = elapsed > 0 ? (buf.byteLength * 1000 / elapsed) : 0;
          resolve({ serverUrl: serverUrl, bps: bps, elapsed: elapsed });
        }).catch(function () {
          clearTimeout(timeout);
          if (aborted) return;
          resolve(null);
        });
      }
    });
  }

  // ── 同步缓存读取 ──────────────────────────────────────────────────
  function getVersionCache() {
    if (_verCache) {
      return { serverUrl: _verCache.serverUrl, data: _verCache.data };
    }
    return null;
  }

  /** 清除 version 缓存（请求失败时调用，下次 version() 会重新竞速） */
  function invalidateVersion() {
    console.log('[RaceFastest] version 缓存已失效，下次调用将重新竞速');
    _verCache = null;
    _verPending = null;
    try { localStorage.removeItem(_LS_KEY_VER); } catch (e) {}
  }

  function clearCache() {
    _verCache = null;
    _dlCache = null;
    _verPending = null;
    _dlPending = null;
    try { localStorage.removeItem(_LS_KEY_VER); } catch (e) {}
  }

  // ── 注册全局 ──────────────────────────────────────────────────────
  window.BK = window.BK || {};
  window.BK.RaceFastest = {
    version: raceVersion,
    download: raceDownload,
    invalidateVersion: invalidateVersion,
    getVersionCache: getVersionCache,
    clearCache: clearCache
  };

})();
