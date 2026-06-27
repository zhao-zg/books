/*!
 * data-manager.js — 书籍数据在线下载、本地存储和管理
 *
 * 暴露：window.DataManager
 *   .loadIndex()              加载/更新全局索引
 *   .getCachedIndex()         获取已缓存索引（同步）
 *   .checkIndexUpdate()       检查索引是否需要更新
 *   .downloadBook(id,series)  下载单本书
 *   .downloadSeries(id)       批量下载某系列
 *   .downloadAll()            下载全部书籍
 *   .getBook(id,series)       获取书籍数据（优先本地）
 *   .isBookDownloaded(id)     检查是否已下载
 *   .getDownloadedBookIds()   获取已下载 ID 列表
 *   .deleteBook(id)           删除本地缓存
 *   .getStorageStats()        存储统计
 *   .checkResources()         检查资源下载统计与估算大小
 *   .clearAllBooks()           清除所有已下载书籍数据
 *   .getBooksBySeriesStatus()  按系列分组返回缓存统计
 *   .pauseDownload()          暂停批量下载
 *   .resumeDownload()         恢复批量下载
 *   .cancelDownload()         取消批量下载
 *   .getDownloadStatus()      获取下载状态
 *   .setBaseUrl(url)          设置数据基础 URL
 */
(function (win) {
  'use strict';

  // ── 配置 ──────────────────────────────────────────────────────────────
  var DATA_BASE_URL = '';

  // ── localforage 实例 ─────────────────────────────────────────────────
  var store = (typeof localforage !== 'undefined')
    ? localforage.createInstance({ name: 'books', storeName: 'zl-data' })
    : null;

  // 存储 key 常量
  var KEY_INDEX     = 'zl_index';
  var KEY_MANIFEST  = 'zl_manifest';
  var KEY_DOWNLOADED = 'zl_downloaded_ids';
  var KEY_BOOK_PREFIX = 'zl_book:';

  // ── 内存缓存 ──────────────────────────────────────────────────────────
  var _cachedIndex = null;
  var _cachedManifest = null;

  // ── 下载队列状态 ─────────────────────────────────────────────────────
  var _isDownloading = false;
  var _isPaused = false;
  var _isCancelled = false;
  var _dlCompleted = 0;
  var _dlTotal = 0;
  var _dlCurrentTitle = '';
  // 并发控制
  var MAX_CONCURRENT = 3;
  var MAX_RETRIES = 3;

  // ── 工具函数 ──────────────────────────────────────────────────────────

  /**
   * 构建完整 URL
   */
  function buildUrl(path) {
    var base = DATA_BASE_URL || '';
    if (!base) return path;
    return base.replace(/\/+$/, '') + '/' + path;
  }

  /**
   * 带重试的 fetch
   * @param {string} url
   * @param {number} [retries] 剩余重试次数
   * @returns {Promise<Response>}
   */
  function fetchWithRetry(url, retries) {
    if (typeof retries === 'undefined') retries = MAX_RETRIES;
    return fetch(url, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r;
      })
      .catch(function (err) {
        if (retries <= 0) throw err;
        // 指数退避：1s, 2s, 4s
        var delay = Math.pow(2, MAX_RETRIES - retries) * 1000;
        console.warn('[DataManager] 请求失败，' + delay + 'ms 后重试: ' + url);
        return new Promise(function (resolve) {
          setTimeout(resolve, delay);
        }).then(function () {
          return fetchWithRetry(url, retries - 1);
        });
      });
  }

  /**
   * 纯文本 → 结构化 content 数组
   * 保留所有经文引用原文，不做清洗
   */
  function textToContents(text) {
    if (!text || typeof text !== 'string') return [];
    return text.split('\n')
      .filter(function (line) { return line.trim(); })
      .map(function (line) { return { type: 'paragraph', text: line.trim() }; });
  }

  /**
   * 将原始 JSON 数据转换为渲染器期望的格式
   * content 字段从纯文本字符串转为结构化数组
   */
  function convertBookData(rawBook) {
    var chapters = (rawBook.chapters || []).map(function (ch) {
      var content = ch.content;
      // 如果 content 是字符串，转为结构化数组
      if (typeof content === 'string') {
        content = textToContents(content);
      } else if (!Array.isArray(content)) {
        content = [];
      }
      return {
        number: ch.number,
        title: ch.title || '',
        content: content,
        footnotes: ch.footnotes || []
      };
    });

    // 构建转换后的书籍对象（保留所有原始字段）
    var result = {};
    var keys = Object.keys(rawBook);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k !== 'chapters') {
        result[k] = rawBook[k];
      }
    }
    result.chapters = chapters;
    return result;
  }

  /**
   * 格式化文件大小
   */
  function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
  }

  // ── localforage 辅助 ─────────────────────────────────────────────────

  /**
   * 安全地写入 localforage
   */
  function storeSet(key, value) {
    if (!store) {
      console.warn('[DataManager] localforage 不可用');
      return Promise.resolve();
    }
    return store.setItem(key, value).catch(function (err) {
      console.error('[DataManager] 存储写入失败: ' + key, err);
      throw new Error('存储空间不足，请清理后重试');
    });
  }

  /**
   * 安全地读取 localforage
   */
  function storeGet(key) {
    if (!store) return Promise.resolve(null);
    return store.getItem(key).catch(function (err) {
      console.error('[DataManager] 存储读取失败: ' + key, err);
      return null;
    });
  }

  /**
   * 安全地删除 localforage 条目
   */
  function storeRemove(key) {
    if (!store) return Promise.resolve();
    return store.removeItem(key).catch(function (err) {
      console.error('[DataManager] 存储删除失败: ' + key, err);
    });
  }

  // ── 已下载列表管理 ───────────────────────────────────────────────────

  function getDownloadedIdsList() {
    return storeGet(KEY_DOWNLOADED).then(function (list) {
      return Array.isArray(list) ? list : [];
    });
  }

  function saveDownloadedIdsList(list) {
    return storeSet(KEY_DOWNLOADED, list);
  }

  function addDownloadedId(bookId) {
    return getDownloadedIdsList().then(function (list) {
      if (list.indexOf(bookId) === -1) {
        list.push(bookId);
      }
      return saveDownloadedIdsList(list);
    });
  }

  function removeDownloadedId(bookId) {
    return getDownloadedIdsList().then(function (list) {
      var idx = list.indexOf(bookId);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
      return saveDownloadedIdsList(list);
    });
  }

  // ── 索引管理 ─────────────────────────────────────────────────────────

  /**
   * 加载/更新全局索引 books-index.json
   * 返回 { series: [...], books: [...] }
   */
  function loadIndex() {
    var url = buildUrl('books-index.json?t=' + Date.now());
    console.log('[DataManager] 加载全局索引: ' + url);
    return fetchWithRetry(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        _cachedIndex = data;
        return storeSet(KEY_INDEX, data).then(function () {
          console.log('[DataManager] 全局索引加载成功，共 ' +
            ((data.books || []).length) + ' 本书，' +
            ((data.series || []).length) + ' 个系列');
          return data;
        });
      })
      .catch(function (err) {
        console.error('[DataManager] 加载全局索引失败:', err);
        // 尝试读取缓存
        return storeGet(KEY_INDEX).then(function (cached) {
          if (cached) {
            _cachedIndex = cached;
            console.log('[DataManager] 使用缓存的全局索引');
            return cached;
          }
          throw new Error('无法加载书籍索引，请检查网络连接');
        });
      });
  }

  /**
   * 获取已缓存的索引（同步）
   */
  function getCachedIndex() {
    return _cachedIndex;
  }

  /**
   * 检查索引是否需要更新（通过 manifest.json version）
   * 返回 { needUpdate: boolean, remoteVersion, localVersion }
   */
  function checkIndexUpdate() {
    var url = buildUrl('manifest.json?t=' + Date.now());
    console.log('[DataManager] 检查清单更新: ' + url);
    return fetchWithRetry(url)
      .then(function (r) { return r.json(); })
      .then(function (remoteManifest) {
        return storeGet(KEY_MANIFEST).then(function (localManifest) {
          var remoteVer = remoteManifest.version || 0;
          var localVer = (localManifest && localManifest.version) || 0;
          var needUpdate = remoteVer > localVer;
          console.log('[DataManager] 清单版本: 远程=' + remoteVer + ' 本地=' + localVer +
            ' 需要更新=' + needUpdate);
          // 更新缓存的 manifest
          _cachedManifest = remoteManifest;
          return storeSet(KEY_MANIFEST, remoteManifest).then(function () {
            return {
              needUpdate: needUpdate,
              remoteVersion: remoteVer,
              localVersion: localVer,
              manifest: remoteManifest
            };
          });
        });
      })
      .catch(function (err) {
        console.error('[DataManager] 检查清单更新失败:', err);
        return { needUpdate: false, remoteVersion: 0, localVersion: 0, error: err.message };
      });
  }

  // ── 书籍下载 ─────────────────────────────────────────────────────────

  /**
   * 下载单本书，返回转换后的书籍数据
   * @param {string} bookId  如 "lee8-01"
   * @param {string} series  如 "lee8"
   * @param {function} [onProgress] 可选回调 (percent, status) => {}
   */
  function downloadBook(bookId, series, onProgress) {
    var url = buildUrl(series + '/' + bookId + '.json');
    console.log('[DataManager] 下载书籍: ' + bookId + ' → ' + url);
    if (onProgress) onProgress(0, '开始下载...');

    return fetchWithRetry(url)
      .then(function (r) {
        if (onProgress) onProgress(50, '解析数据...');
        return r.json();
      })
      .then(function (rawBook) {
        var converted = convertBookData(rawBook);
        // 存入 localforage
        return storeSet(KEY_BOOK_PREFIX + bookId, converted)
          .then(function () {
            return addDownloadedId(bookId);
          })
          .then(function () {
            if (onProgress) onProgress(100, '下载完成');
            console.log('[DataManager] 书籍下载完成: ' + bookId);
            return converted;
          });
      })
      .catch(function (err) {
        console.error('[DataManager] 下载书籍失败: ' + bookId, err);
        if (onProgress) onProgress(-1, '下载失败: ' + err.message);
        throw err;
      });
  }

  /**
   * 并发控制器：以最多 maxConcurrent 个并发执行任务列表
   * @param {Array<function>} tasks 返回 Promise 的工厂函数数组
   * @param {number} maxConcurrent
   * @param {function} [onTaskComplete] 每完成一个任务的回调
   * @returns {Promise<{success:number, failed:number, errors:Array}>}
   */
  function runConcurrent(tasks, maxConcurrent, onTaskComplete) {
    var success = 0;
    var failed = 0;
    var errors = [];
    var nextIdx = 0;

    function runNext() {
      // 检查取消
      if (_isCancelled) {
        return Promise.resolve();
      }
      // 检查暂停：轮询等待
      if (_isPaused) {
        return new Promise(function (resolve) {
          var checkInterval = setInterval(function () {
            if (!_isPaused || _isCancelled) {
              clearInterval(checkInterval);
              if (_isCancelled) {
                resolve();
              } else {
                resolve(runNext());
              }
            }
          }, 200);
        });
      }

      if (nextIdx >= tasks.length) {
        return Promise.resolve();
      }

      var idx = nextIdx;
      nextIdx++;
      var taskFn = tasks[idx];

      return taskFn()
        .then(function () {
          success++;
          if (onTaskComplete) onTaskComplete(success + failed, tasks.length);
        })
        .catch(function (err) {
          failed++;
          errors.push({ index: idx, error: err.message || String(err) });
          if (onTaskComplete) onTaskComplete(success + failed, tasks.length);
        })
        .then(function () {
          return runNext();
        });
    }

    // 启动 maxConcurrent 个并发 worker
    var workers = [];
    for (var w = 0; w < maxConcurrent; w++) {
      workers.push(runNext());
    }
    return Promise.all(workers).then(function () {
      return { success: success, failed: failed, errors: errors };
    });
  }

  /**
   * 批量下载某系列所有书籍
   * @param {string} seriesId 如 "lee8"
   * @param {function} [onProgress] (completed, total, currentTitle) => {}
   */
  function downloadSeries(seriesId, onProgress) {
    if (_isDownloading) {
      return Promise.reject(new Error('已有下载任务正在进行'));
    }

    _isDownloading = true;
    _isPaused = false;
    _isCancelled = false;
    _dlCompleted = 0;
    _dlTotal = 0;
    _dlCurrentTitle = '';

    console.log('[DataManager] 开始批量下载系列: ' + seriesId);

    // 先获取系列索引
    var indexUrl = buildUrl(seriesId + '/index.json');
    return fetchWithRetry(indexUrl)
      .then(function (r) { return r.json(); })
      .then(function (seriesBooks) {
        if (!Array.isArray(seriesBooks) || !seriesBooks.length) {
          _isDownloading = false;
          return { success: 0, failed: 0, errors: [] };
        }

        // 获取已下载列表，跳过已下载的
        return getDownloadedIdsList().then(function (downloadedIds) {
          var toDownload = seriesBooks.filter(function (b) {
            return downloadedIds.indexOf(b.id) === -1;
          });

          _dlTotal = toDownload.length;
          console.log('[DataManager] 系列 ' + seriesId + ' 共 ' + seriesBooks.length +
            ' 本，已下载 ' + (seriesBooks.length - toDownload.length) +
            ' 本，待下载 ' + toDownload.length + ' 本');

          if (!toDownload.length) {
            _isDownloading = false;
            if (onProgress) onProgress(0, 0, '全部已下载');
            return { success: 0, failed: 0, errors: [] };
          }

          // 构建任务列表
          var tasks = toDownload.map(function (book) {
            return function () {
              _dlCurrentTitle = book.title || book.id;
              if (onProgress) onProgress(_dlCompleted, _dlTotal, _dlCurrentTitle);
              return downloadBook(book.id, seriesId);
            };
          });

          return runConcurrent(tasks, MAX_CONCURRENT, function (completed, total) {
            _dlCompleted = completed;
            if (onProgress) onProgress(completed, total, _dlCurrentTitle);
          }).then(function (result) {
            _isDownloading = false;
            _dlCurrentTitle = '';
            console.log('[DataManager] 系列 ' + seriesId + ' 下载完成: 成功=' +
              result.success + ' 失败=' + result.failed);
            return result;
          });
        });
      })
      .catch(function (err) {
        _isDownloading = false;
        console.error('[DataManager] 批量下载系列失败: ' + seriesId, err);
        throw err;
      });
  }

  /**
   * 下载全部书籍
   * @param {function} [onProgress] (completed, total, currentTitle) => {}
   */
  function downloadAll(onProgress) {
    if (_isDownloading) {
      return Promise.reject(new Error('已有下载任务正在进行'));
    }

    _isDownloading = true;
    _isPaused = false;
    _isCancelled = false;
    _dlCompleted = 0;
    _dlTotal = 0;
    _dlCurrentTitle = '';

    console.log('[DataManager] 开始下载全部书籍');

    // 先加载全局索引
    var indexPromise = _cachedIndex ? Promise.resolve(_cachedIndex) : loadIndex();

    return indexPromise
      .then(function (indexData) {
        var allBooks = indexData.books || [];
        if (!allBooks.length) {
          _isDownloading = false;
          return { success: 0, failed: 0, errors: [] };
        }

        return getDownloadedIdsList().then(function (downloadedIds) {
          var toDownload = allBooks.filter(function (b) {
            return downloadedIds.indexOf(b.id) === -1;
          });

          _dlTotal = toDownload.length;
          console.log('[DataManager] 共 ' + allBooks.length + ' 本书，已下载 ' +
            (allBooks.length - toDownload.length) + ' 本，待下载 ' + toDownload.length + ' 本');

          if (!toDownload.length) {
            _isDownloading = false;
            if (onProgress) onProgress(0, 0, '全部已下载');
            return { success: 0, failed: 0, errors: [] };
          }

          var tasks = toDownload.map(function (book) {
            return function () {
              _dlCurrentTitle = book.title || book.id;
              if (onProgress) onProgress(_dlCompleted, _dlTotal, _dlCurrentTitle);
              return downloadBook(book.id, book.series);
            };
          });

          return runConcurrent(tasks, MAX_CONCURRENT, function (completed, total) {
            _dlCompleted = completed;
            if (onProgress) onProgress(completed, total, _dlCurrentTitle);
          }).then(function (result) {
            _isDownloading = false;
            _dlCurrentTitle = '';
            console.log('[DataManager] 全部下载完成: 成功=' +
              result.success + ' 失败=' + result.failed);
            return result;
          });
        });
      })
      .catch(function (err) {
        _isDownloading = false;
        console.error('[DataManager] 下载全部书籍失败:', err);
        throw err;
      });
  }

  // ── 书籍读取 ─────────────────────────────────────────────────────────

  /**
   * 获取书籍数据（优先本地缓存，无缓存则在线获取并缓存）
   * 返回转换后的书籍数据（content 为结构化数组）
   * @param {string} bookId
   * @param {string} series
   */
  function getBook(bookId, series) {
    // 先尝试本地缓存
    return storeGet(KEY_BOOK_PREFIX + bookId).then(function (cached) {
      if (cached) {
        console.log('[DataManager] 从本地缓存读取: ' + bookId);
        return cached;
      }
      // 本地无缓存，在线获取并缓存
      console.log('[DataManager] 本地无缓存，在线获取: ' + bookId);
      if (!series) {
        // 尝试从索引中获取 series
        if (_cachedIndex && _cachedIndex.books) {
          for (var i = 0; i < _cachedIndex.books.length; i++) {
            if (_cachedIndex.books[i].id === bookId) {
              series = _cachedIndex.books[i].series;
              break;
            }
          }
        }
      }
      if (!series) {
        return Promise.reject(new Error('未找到书籍 ' + bookId + ' 所属系列'));
      }
      return downloadBook(bookId, series);
    });
  }

  /**
   * 检查书籍是否已下载到本地
   * @param {string} bookId
   */
  function isBookDownloaded(bookId) {
    return storeGet(KEY_BOOK_PREFIX + bookId).then(function (data) {
      return !!data;
    });
  }

  /**
   * 获取所有已下载书籍的 ID 列表
   */
  function getDownloadedBookIds() {
    return getDownloadedIdsList();
  }

  // ── 存储管理 ─────────────────────────────────────────────────────────

  /**
   * 删除本地缓存的书籍
   * @param {string} bookId
   */
  function deleteBook(bookId) {
    console.log('[DataManager] 删除本地缓存: ' + bookId);
    return storeRemove(KEY_BOOK_PREFIX + bookId)
      .then(function () {
        return removeDownloadedId(bookId);
      })
      .then(function () {
        console.log('[DataManager] 已删除: ' + bookId);
      });
  }

  /**
   * 获取存储统计信息
   * 返回 { downloadedCount, totalSizeBytes, totalSizeFormatted }
   */
  function getStorageStats() {
    return getDownloadedIdsList().then(function (ids) {
      var count = ids.length;
      // 估算总大小：遍历所有已存储的书籍数据
      if (!store || !count) {
        return {
          downloadedCount: count,
          totalSizeBytes: 0,
          totalSizeFormatted: '0 B'
        };
      }

      var sizePromises = ids.map(function (id) {
        return storeGet(KEY_BOOK_PREFIX + id).then(function (data) {
          if (!data) return 0;
          // 估算 JSON 序列化后的大小
          try {
            return JSON.stringify(data).length * 2; // UTF-16 近似
          } catch (e) {
            return 0;
          }
        });
      });

      return Promise.all(sizePromises).then(function (sizes) {
        var totalBytes = 0;
        for (var i = 0; i < sizes.length; i++) {
          totalBytes += sizes[i];
        }
        return {
          downloadedCount: count,
          totalSizeBytes: totalBytes,
          totalSizeFormatted: formatSize(totalBytes)
        };
      });
    });
  }

  // ── 下载队列控制 ─────────────────────────────────────────────────────

  /**
   * 暂停当前批量下载
   */
  function pauseDownload() {
    if (_isDownloading && !_isPaused) {
      _isPaused = true;
      console.log('[DataManager] 下载已暂停');
    }
  }

  /**
   * 恢复暂停的批量下载
   */
  function resumeDownload() {
    if (_isDownloading && _isPaused) {
      _isPaused = false;
      console.log('[DataManager] 下载已恢复');
    }
  }

  /**
   * 取消当前批量下载
   */
  function cancelDownload() {
    if (_isDownloading) {
      _isCancelled = true;
      _isPaused = false;
      console.log('[DataManager] 下载已取消');
    }
  }

  /**
   * 获取下载状态
   * 返回 { isDownloading, isPaused, progress: { completed, total, currentTitle } }
   */
  function getDownloadStatus() {
    return {
      isDownloading: _isDownloading,
      isPaused: _isPaused,
      isCancelled: _isCancelled,
      progress: {
        completed: _dlCompleted,
        total: _dlTotal,
        currentTitle: _dlCurrentTitle
      }
    };
  }

  // ── 资源检查与管理 ────────────────────────────────────────────────────

  /**
   * 检查资源下载统计与估算大小
   * 返回 { total, downloaded, missing, estimatedTotalSize, estimatedMissingSize }
   */
  function checkResources() {
    var indexPromise = _cachedIndex ? Promise.resolve(_cachedIndex) : loadIndex();
    return indexPromise.then(function (indexData) {
      var books = indexData.books || [];
      var total = books.length;
      var BYTES_PER_CHAPTER = 3072;

      return getDownloadedIdsList().then(function (downloadedIds) {
        var downloadedCount = 0;
        var estimatedTotalSize = 0;
        var estimatedMissingSize = 0;

        for (var i = 0; i < books.length; i++) {
          var chapters = books[i].chapter_count || 0;
          var bookSize = chapters * BYTES_PER_CHAPTER;
          estimatedTotalSize += bookSize;

          if (downloadedIds.indexOf(books[i].id) !== -1) {
            downloadedCount++;
          } else {
            estimatedMissingSize += bookSize;
          }
        }

        return {
          total: total,
          downloaded: downloadedCount,
          missing: total - downloadedCount,
          estimatedTotalSize: estimatedTotalSize,
          estimatedMissingSize: estimatedMissingSize
        };
      });
    });
  }

  /**
   * 清除所有已下载书籍数据，保留索引和清单
   * 返回 { cleared: 删除的数量 }
   */
  function clearAllBooks() {
    if (!store) {
      return Promise.resolve({ cleared: 0 });
    }
    return store.keys().then(function (keys) {
      var bookKeys = [];
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf(KEY_BOOK_PREFIX) === 0) {
          bookKeys.push(keys[i]);
        }
      }
      var removePromises = bookKeys.map(function (key) {
        return storeRemove(key);
      });
      return Promise.all(removePromises).then(function () {
        return saveDownloadedIdsList([]).then(function () {
          console.log('[DataManager] 已清除全部书籍缓存: ' + bookKeys.length + ' 本');
          return { cleared: bookKeys.length };
        });
      });
    });
  }

  /**
   * 按系列分组返回缓存统计
   * 返回 { series: [{id, title, total, cached, estimatedSize}] }
   */
  function getBooksBySeriesStatus() {
    var BYTES_PER_CHAPTER = 3072;
    var indexPromise = _cachedIndex ? Promise.resolve(_cachedIndex) : loadIndex();
    return indexPromise.then(function (indexData) {
      var books = indexData.books || [];
      var seriesList = indexData.series || [];

      return getDownloadedIdsList().then(function (downloadedIds) {
        // 按系列分组统计
        var seriesMap = {};
        for (var i = 0; i < seriesList.length; i++) {
          seriesMap[seriesList[i].id] = {
            id: seriesList[i].id,
            title: seriesList[i].title,
            total: 0,
            cached: 0,
            estimatedSize: 0
          };
        }

        for (var j = 0; j < books.length; j++) {
          var book = books[j];
          var sid = book.series;
          if (!seriesMap[sid]) {
            seriesMap[sid] = {
              id: sid,
              title: sid,
              total: 0,
              cached: 0,
              estimatedSize: 0
            };
          }
          seriesMap[sid].total++;
          if (downloadedIds.indexOf(book.id) !== -1) {
            seriesMap[sid].cached++;
          } else {
            seriesMap[sid].estimatedSize += (book.chapter_count || 0) * BYTES_PER_CHAPTER;
          }
        }

        var result = [];
        var ids = Object.keys(seriesMap);
        for (var k = 0; k < ids.length; k++) {
          result.push(seriesMap[ids[k]]);
        }
        return { series: result };
      });
    });
  }

  // ── 公开 API ─────────────────────────────────────────────────────────

  win.DataManager = {
    loadIndex: loadIndex,
    getCachedIndex: getCachedIndex,
    checkIndexUpdate: checkIndexUpdate,
    downloadBook: downloadBook,
    downloadSeries: downloadSeries,
    downloadAll: downloadAll,
    getBook: getBook,
    isBookDownloaded: isBookDownloaded,
    getDownloadedBookIds: getDownloadedBookIds,
    deleteBook: deleteBook,
    getStorageStats: getStorageStats,
    checkResources: checkResources,
    clearAllBooks: clearAllBooks,
    getBooksBySeriesStatus: getBooksBySeriesStatus,
    pauseDownload: pauseDownload,
    resumeDownload: resumeDownload,
    cancelDownload: cancelDownload,
    getDownloadStatus: getDownloadStatus,
    setBaseUrl: function (url) { DATA_BASE_URL = url; }
  };

}(window));

