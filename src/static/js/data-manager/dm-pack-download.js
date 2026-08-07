/**
 * dm-pack-download.js — 系列 ZIP 压缩包下载与解压
 *
 * 混合策略核心模块：
 *   - 首次全量下载 → 走 ZIP 压缩包（减少 HTTP 请求次数）
 *   - 增量更新 → 走逐本 JSON（只下载新增/变更的书）
 *
 * 支持按压缩体积自动拆分（Cloudflare Pages 25MB 限制）：
 *   单系列可拆为多个分片 ZIP，如 books-part1.zip、books-part2.zip、...
 *   packs/manifest.json 中每个系列有 files 数组列出所有分片。
 *
 * 依赖：
 *   - JSZip (vendor/jszip.min.js) — 延迟加载，运行时检查
 *   - dm-shared.js / dm-storage.js / dm-api.js
 */
(function (win) {
  'use strict';

  // ── 配置 ──────────────────────────────────────────────────────────
  var PACK_THRESHOLD = 3;
  var EXTRACT_CONCURRENCY = 5; // 解压入库并发数

  // 缓存 packs/manifest.json（60s TTL）
  var _packsManifestCache = null;
  var _packsManifestTs = 0;
  var PACKS_MANIFEST_TTL = 60000;

  // ── JSZip 就绪检查 ──────────────────────────────────────────────

  /**
   * 确保 JSZip 已加载（处理 defer 延迟加载场景）
   * 最多等待 5 秒，每 100ms 检查一次
   * @returns {Promise<JSZip>}
   */
  function _ensureJSZip() {
    if (win.JSZip) return Promise.resolve(win.JSZip);
    console.warn('[PackDL] JSZip 尚未加载，等待中...');
    var maxWait = 5000;
    var interval = 100;
    var elapsed = 0;
    return new Promise(function (resolve, reject) {
      function check() {
        if (win.JSZip) { resolve(win.JSZip); return; }
        elapsed += interval;
        if (elapsed >= maxWait) {
          reject(new Error('JSZip 加载超时，请刷新页面后重试'));
          return;
        }
        setTimeout(check, interval);
      }
      check();
    });
  }

  // ── URL 构建（支持 CDN 容灾） ──────────────────────────────────

  /**
   * 构建所有可用的包 URL 列表（主地址 + 备用地址）
   * @param {string} relativePath 如 "packs/books-part1.zip"
   * @returns {string[]} 所有可用 URL
   */
  function _buildAllPackUrls(relativePath) {
    var urls = [];
    // 获取 DataManager 暴露的多地址列表
    var baseUrls = (win.DataManager && win.DataManager._getBaseUrls)
      ? win.DataManager._getBaseUrls()
      : [];
    if (!baseUrls.length) {
      // 降级到单地址
      var single = (win.DataManager && win.DataManager._getBaseUrl)
        ? win.DataManager._getBaseUrl()
        : '';
      baseUrls = single ? [single] : [];
    }
    for (var i = 0; i < baseUrls.length; i++) {
      urls.push(baseUrls[i].replace(/\/+$/, '') + '/' + relativePath);
    }
    // 如果完全没有配置地址，使用相对路径
    if (!urls.length) urls.push(relativePath);
    return urls;
  }

  // ── 工具函数 ──────────────────────────────────────────────────────

  /**
   * 获取 packs/manifest.json（带缓存）
   * @returns {Promise<object|null>}
   */
  function fetchPacksManifest() {
    var now = Date.now();
    if (_packsManifestCache && (now - _packsManifestTs < PACKS_MANIFEST_TTL)) {
      return Promise.resolve(_packsManifestCache);
    }

    // 尝试所有可用地址
    var urls = _buildAllPackUrls('packs/manifest.json');
    console.log('[PackDL] fetchPacksManifest: 尝试 ' + urls.length + ' 个地址');
    for (var ui = 0; ui < urls.length; ui++) {
      console.log('[PackDL]   地址' + ui + ': ' + urls[ui]);
    }
    return _fetchFirstAvailable(urls)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (manifest) {
        if (!manifest || !Array.isArray(manifest.packs)) return null;
        _packsManifestCache = manifest;
        _packsManifestTs = now;
        return manifest;
      })
      .catch(function (err) {
        console.warn('[PackDL] packs/manifest.json 获取失败:', err.message || err);
        return null;
      });
  }

  /**
   * 依次尝试多个 URL，返回第一个成功的 Response
   * @param {string[]} urls
   * @returns {Promise<Response>}
   */
  function _fetchFirstAvailable(urls) {
    if (!urls.length) return Promise.reject(new Error('无可用地址'));
    function tryUrl(idx) {
      if (idx >= urls.length) return Promise.reject(new Error('所有地址均不可用'));
      return fetch(urls[idx], { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          // Cloudflare Pages 对不存在的路径返回 200 + index.html，需检测 content-type
          var ct = r.headers.get('content-type') || '';
          if (ct.indexOf('text/html') !== -1) {
            var htmlErr = new Error('HTML_RESPONSE');
            htmlErr._isHtmlResponse = true;
            throw htmlErr;
          }
          return r;
        })
        .catch(function (err) {
          // HTML 响应说明文件在该 CDN 不存在，跳过后续重试直接尝试下一个地址
          if (err && err._isHtmlResponse) {
            console.warn('[PackDL] 地址返回 HTML（文件不存在）: ' + urls[idx]);
          }
          return tryUrl(idx + 1);
        });
    }
    return tryUrl(0);
  }

  /**
   * 判断某系列（或系列列表）是否适合走 ZIP 通道
   * @param {string|Array<string>} seriesId 单个系列 ID 或数组
   * @param {number} pendingCount
   * @returns {Promise<boolean>}
   */
  function shouldUsePack(seriesId, pendingCount) {
    if (pendingCount < PACK_THRESHOLD) {
      console.log('[PackDL] shouldUsePack: 待下载 ' + pendingCount + ' 本 < 阈值 ' + PACK_THRESHOLD + '，跳过 ZIP 通道');
      return Promise.resolve(false);
    }
    return fetchPacksManifest().then(function (manifest) {
      if (!manifest) {
        console.log('[PackDL] shouldUsePack: packs/manifest.json 不可用，跳过 ZIP 通道');
        return false;
      }
      var ids = Array.isArray(seriesId) ? seriesId : [seriesId];
      // 检查所有指定系列是否都有对应的 ZIP 包
      for (var i = 0; i < ids.length; i++) {
        var found = false;
        for (var j = 0; j < manifest.packs.length; j++) {
          if (manifest.packs[j].id === ids[i]) { found = true; break; }
        }
        if (!found) {
          console.log('[PackDL] shouldUsePack: 系列 ' + ids[i] + ' 不在 manifest 中，跳过 ZIP 通道');
          return false;
        }
      }
      console.log('[PackDL] shouldUsePack: 系列 ' + ids.join(',') + ' 走 ZIP 通道（' + pendingCount + ' 本待下载）');
      return true;
    });
  }

  /**
   * 字节级流式 fetch ZIP（支持 CDN 容灾）
   * @param {string} relativePath 相对路径如 "packs/books-part1.zip"
   * @param {function} onProgress (received, total) => {}
   * @param {function} shouldAbort () => true
   * @param {function} [shouldPause] () => true（暂停支持）
   * @returns {Promise<ArrayBuffer>}
   */
  function _fetchZipStreamed(relativePath, onProgress, shouldAbort, shouldPause) {
    var MAX_RETRIES = 3;
    var urls = _buildAllPackUrls(relativePath);
    var urlIdx = 0;

    function attemptWithUrl(retries) {
      if (shouldAbort && shouldAbort()) {
        var e = new Error('下载已取消');
        e.code = 'CANCELLED';
        throw e;
      }

      var url = urls[urlIdx];

      return fetch(url, { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          var total = parseInt(r.headers.get('Content-Length') || '0', 10) || 0;
          var received = 0;
          var chunks = [];

          if (!r.body || typeof r.body.getReader !== 'function') {
            return r.arrayBuffer().then(function (buf) {
              if (shouldAbort && shouldAbort()) {
                var e2 = new Error('下载已取消');
                e2.code = 'CANCELLED';
                throw e2;
              }
              if (onProgress) onProgress(buf.byteLength, total || buf.byteLength);
              return buf;
            });
          }

          var reader = r.body.getReader();
          function pump() {
            // 暂停支持：挂起 Promise，恢复时继续读取
            if (shouldPause && shouldPause()) {
              return new Promise(function (resolve, reject) {
                var checkInterval = setInterval(function () {
                  if (shouldAbort && shouldAbort()) {
                    clearInterval(checkInterval);
                    try { reader.cancel(); } catch (ex) {}
                    var e3 = new Error('下载已取消');
                    e3.code = 'CANCELLED';
                    reject(e3);
                    return;
                  }
                  if (!shouldPause()) {
                    clearInterval(checkInterval);
                    resolve();
                  }
                }, 200);
              }).then(function () {
                return pump();
              });
            }

            if (shouldAbort && shouldAbort()) {
              try { reader.cancel(); } catch (ex) {}
              var e4 = new Error('下载已取消');
              e4.code = 'CANCELLED';
              throw e4;
            }

            return reader.read().then(function (result) {
              if (shouldAbort && shouldAbort()) {
                try { reader.cancel(); } catch (ex) {}
                var e5 = new Error('下载已取消');
                e5.code = 'CANCELLED';
                throw e5;
              }
              if (result.done) {
                var blob = new Blob(chunks);
                return blob.arrayBuffer();
              }
              received += result.value.length;
              if (onProgress) onProgress(received, total);
              chunks.push(result.value);
              return pump();
            });
          }
          return pump();
        })
        .catch(function (err) {
          if (err && err.code === 'CANCELLED') throw err;
          // 当前地址重试
          if (retries > 0) {
            var delay = Math.pow(2, MAX_RETRIES - retries) * 1000;
            console.warn('[PackDL] ZIP 下载失败，' + delay + 'ms 后重试: ' + url);
            return new Promise(function (resolve) { setTimeout(resolve, delay); })
              .then(function () {
                if (shouldAbort && shouldAbort()) {
                  var e6 = new Error('下载已取消');
                  e6.code = 'CANCELLED';
                  throw e6;
                }
                return attemptWithUrl(retries - 1);
              });
          }
          // 切换到下一个地址
          if (urlIdx < urls.length - 1) {
            urlIdx++;
            console.warn('[PackDL] 切换到备用地址: ' + urls[urlIdx]);
            return attemptWithUrl(MAX_RETRIES);
          }
          throw err;
        });
    }
    return attemptWithUrl(MAX_RETRIES);
  }

  /**
   * 解压单个 ZIP buffer 并将书籍写入 IndexedDB（小批量并发）
   * @param {ArrayBuffer} zipBuffer
   * @param {Object} skipSet 跳过的书籍 ID 集合
   * @param {Object} opts { shouldAbort, shouldPause, onBookStored }
   *   - onBookStored(bookId) 每本书入库成功后触发，供外部实时更新进度
   * @returns {Promise<{success:number, failed:number, errors:Array}>}
   */
  function _extractAndStore(zipBuffer, skipSet, opts) {
    return _ensureJSZip().then(function (JSZip) {
      return JSZip.loadAsync(zipBuffer).then(function (zip) {
        var bookFiles = [];
        zip.forEach(function (relativePath) {
          if (!relativePath.endsWith('.json') ||
              relativePath === 'index.json' || relativePath === 'categories.json') {
            return;
          }
          bookFiles.push(relativePath);
        });

        var success = 0, failed = 0, errors = [];

        // 小批量并发处理（EXTRACT_CONCURRENCY 路）
        function processBatch(startIdx) {
          if (startIdx >= bookFiles.length) return Promise.resolve();
          if (opts.shouldAbort && opts.shouldAbort()) {
            var e = new Error('下载已取消');
            e.code = 'CANCELLED';
            throw e;
          }

          var endIdx = Math.min(startIdx + EXTRACT_CONCURRENCY, bookFiles.length);
          var batchPromises = [];

          for (var i = startIdx; i < endIdx; i++) {
            (function (filePath) {
              batchPromises.push(
                zip.file(filePath).async('string').then(function (jsonText) {
                  var rawBook;
                  try { rawBook = JSON.parse(jsonText); } catch (ex) {
                    failed++;
                    errors.push({ file: filePath, error: 'JSON 解析失败' });
                    return;
                  }
                  var bookId = rawBook.id || filePath.replace(/\.json$/, '');
                  var slashIdx = bookId.lastIndexOf('/');
                  if (slashIdx >= 0) bookId = bookId.substring(slashIdx + 1);

                  if (skipSet[bookId]) return;

                  var converted = convertBookData(rawBook);
                  return storeSet(KEY_BOOK_PREFIX + bookId, converted)
                    .then(function () { return addDownloadedId(bookId); })
                    .then(function () {
                      buildContentIndex(converted);
                      addToBookIndex(converted);
                      _invalidateBookSizeCache();
                      success++;
                      // ★ 每本书入库成功后通知外部，供实时更新已完成本数和"已缓存"计数
                      if (opts.onBookStored) opts.onBookStored(bookId);
                    })
                    .catch(function (err) {
                      failed++;
                      errors.push({ id: bookId, error: err.message || '写入失败' });
                    });
                })
              );
            })(bookFiles[i]);
          }

          return Promise.all(batchPromises).then(function () {
            return processBatch(endIdx);
          });
        }

        return processBatch(0).then(function () {
          return { success: success, failed: failed, errors: errors };
        });
      });
    });
  }

  /**
   * 下载并解压系列 ZIP（支持多分片）
   *
   * @param {string} seriesId
   * @param {Object} [opts]
   * @param {function} [opts.onProgress] (percent, status) => {}
   * @param {function} [opts.shouldAbort] () => true
   * @param {function} [opts.shouldPause] () => true（暂停支持）
   * @param {Array<string>} [opts.skipIds]
   * @returns {Promise<{success:number, failed:number, errors:Array}>}
   */
  function downloadPack(seriesId, opts) {
    opts = opts || {};

    return _ensureJSZip().then(function () {
      return fetchPacksManifest().then(function (manifest) {
        if (!manifest) {
          return Promise.reject(new Error('packs/manifest.json 不可用'));
        }

        // 查找系列的 pack 信息
        var packInfo = null;
        for (var i = 0; i < manifest.packs.length; i++) {
          if (manifest.packs[i].id === seriesId) {
            packInfo = manifest.packs[i];
            break;
          }
        }
        if (!packInfo) {
          return Promise.reject(new Error('系列 ' + seriesId + ' 没有对应的 ZIP 包'));
        }

        var files = packInfo.files || [];
        var totalFiles = files.length;
        var totalSize = packInfo.totalSize || 0;
        var skipSet = {};
        if (opts.skipIds) {
          for (var s = 0; s < opts.skipIds.length; s++) {
            skipSet[opts.skipIds[s]] = true;
          }
        }

        console.log('[PackDL] 开始下载系列: ' + seriesId +
          '（' + totalFiles + ' 个分片，共 ' + formatSize(totalSize) + '）');

        // 进度状态放入闭包，避免并发干扰
        var overallReceived = 0;
        var prevPartReceived = 0; // 上一分片已接收字节的锚点
        var accResult = { success: 0, failed: 0, errors: [] };
        // ★ 用于解压阶段的扩展 opts（包含 onBookStored 回调）
        var extractOpts = {
          shouldAbort: opts.shouldAbort,
          shouldPause: opts.shouldPause,
          onBookStored: opts.onBookStored
        };
        var chain = Promise.resolve();

        for (var fi = 0; fi < files.length; fi++) {
          (function (zipFile, partIndex) {
            chain = chain.then(function () {
              if (opts.shouldAbort && opts.shouldAbort()) {
                var e = new Error('下载已取消');
                e.code = 'CANCELLED';
                throw e;
              }

              var label = totalFiles > 1
                ? '分片 ' + (partIndex + 1) + '/' + totalFiles + ' '
                : '';

              console.log('[PackDL] 下载分片: ' + zipFile);

              // 记录此分片开始前的全局已接收量
              var partStartReceived = overallReceived;

              // 下载 ZIP（0-90% 按字节进度）
              return _fetchZipStreamed('packs/' + zipFile, function (received, total) {
                if (opts.onProgress) {
                  // 跨分片累加：overallReceived = 之前分片的总和 + 当前分片已接收
                  overallReceived = partStartReceived - prevPartReceived + received;
                  var pct = totalSize > 0
                    ? Math.floor(overallReceived / totalSize * 90)
                    : Math.floor((partIndex / totalFiles) * 90);
                  opts.onProgress(Math.min(90, pct),
                    label + '下载 ' + formatSize(overallReceived) + ' / ' + formatSize(totalSize));
                }
              }, opts.shouldAbort, opts.shouldPause)
                .then(function (buffer) {
                  // 记录此分片完成后更新锚点
                  prevPartReceived = overallReceived;
                  if (opts.shouldAbort && opts.shouldAbort()) {
                    var e2 = new Error('下载已取消');
                    e2.code = 'CANCELLED';
                    throw e2;
                  }

                  // 解压+入库（90-99%）
                  if (opts.onProgress) opts.onProgress(90, label + '解压入库...');
                  return _extractAndStore(buffer, skipSet, extractOpts);
                })
                .then(function (result) {
                  accResult.success += result.success;
                  accResult.failed += result.failed;
                  accResult.errors = accResult.errors.concat(result.errors);
                  // 更新整体进度
                  var partPct = 90 + Math.floor(((partIndex + 1) / totalFiles) * 9);
                  if (opts.onProgress) opts.onProgress(partPct, label + '完成');
                });
            });
          })(files[fi], fi);
        }

        return chain.then(function () {
          if (opts.onProgress) opts.onProgress(100, '系列包下载完成');
          console.log('[PackDL] 系列 ' + seriesId + ' 下载完成: 成功=' +
            accResult.success + ' 失败=' + accResult.failed);
          return accResult;
        });
      });
    });
  }

  // ── 混合策略入口 ──────────────────────────────────────────────────

  function smartDownloadSeries(seriesId, booksToDownload, onProgress) {
    return getDownloadedIdsList().then(function (downloadedIds) {
      var pending = booksToDownload.filter(function (b) {
        return downloadedIds.indexOf(b.id) === -1;
      });

      if (!pending.length) {
        return { success: 0, failed: 0, errors: [] };
      }

      return shouldUsePack(seriesId, pending.length).then(function (usePack) {
        if (usePack) {
          console.log('[PackDL] 系列 ' + seriesId + ' 走 ZIP 通道（' + pending.length + ' 本待下载）');
          return downloadPack(seriesId, {
            skipIds: downloadedIds,
            onProgress: function (pct, status) {
              if (onProgress) {
                var completed = Math.floor(pct / 100 * pending.length);
                onProgress(completed, pending.length, status);
              }
            },
          });
        } else {
          console.log('[PackDL] 系列 ' + seriesId + ' 走逐本通道（' + pending.length + ' 本待下载）');
          return Promise.resolve({ pending: pending, usePack: false });
        }
      });
    });
  }

  // ── 导出 ──────────────────────────────────────────────────────────
  win.DataManager = win.DataManager || {};
  win.DataManager._packDl = {
    fetchPacksManifest: fetchPacksManifest,
    shouldUsePack: shouldUsePack,
    downloadPack: downloadPack,
    smartDownloadSeries: smartDownloadSeries,
    PACK_THRESHOLD: PACK_THRESHOLD,
    ensureJSZip: _ensureJSZip,
  };

})(window);
