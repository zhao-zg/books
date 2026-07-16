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

  // ── 搜索索引 ────────────────────────────────────────────────────────────

  /**
   * 加载搜索索引 search-index.json
   * 策略：内存缓存 → localforage → 远程获取
   * 返回 { version, generated_at, books: [...] }
   */
  function loadSearchIndex() {
    // 1. 内存缓存
    if (_cachedSearchIndex) {
      return Promise.resolve(_cachedSearchIndex);
    }

    // 2. localforage 缓存
    return storeGet(KEY_SEARCH_INDEX).then(function (cached) {
      if (cached) {
        _cachedSearchIndex = cached;
        console.log('[DataManager] 使用缓存搜索索引（' + ((cached.books || []).length) + ' 本书）');
        return cached;
      }

      // 3. 远程获取
      var url = buildUrl('books/search-index.json?t=' + Date.now());
      console.log('[DataManager] 远程加载搜索索引: ' + url);
      return fetchWithRetry(url)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          _cachedSearchIndex = data;
          return storeSet(KEY_SEARCH_INDEX, data).then(function () {
            console.log('[DataManager] 搜索索引加载成功，共 ' +
              ((data.books || []).length) + ' 本书');
            return data;
          });
        })
        .catch(function (err) {
          console.error('[DataManager] 加载搜索索引失败:', err);
          throw new Error('无法加载搜索索引');
        });
    });
  }

  /**
   * 获取已缓存的搜索索引（同步）
   * 返回 null 如果尚未加载
   */
  function getCachedSearchIndex() {
    return _cachedSearchIndex;
  }

  // ── 公开 API ─────────────────────────────────────────────────────────

  win.DataManager = {
    loadIndex: loadIndex,
    getCachedIndex: getCachedIndex,
    checkIndexUpdate: checkIndexUpdate,
    loadSearchIndex: loadSearchIndex,
    getCachedSearchIndex: getCachedSearchIndex,
    downloadBook: downloadBook,
    downloadSeries: downloadSeries,
    downloadAll: downloadAll,
    getBook: getBook,
    isBookDownloaded: isBookDownloaded,
    getDownloadedBookIds: getDownloadedBookIds,
    cacheBook: cacheBook,
    deleteBook: deleteBook,
    getStorageStats: getStorageStats,
    checkResources: checkResources,
    clearAllBooks: clearAllBooks,
    getBooksBySeriesStatus: getBooksBySeriesStatus,
    pauseDownload: pauseDownload,
    resumeDownload: resumeDownload,
    cancelDownload: cancelDownload,
    getDownloadStatus: getDownloadStatus,
    setBaseUrl: function (urlOrArray) {
      if (Array.isArray(urlOrArray)) {
        DATA_BASE_URLS = urlOrArray.map(function(u) { return u.replace(/\/+$/, ''); });
        _currentUrlIndex = 0;
        DATA_BASE_URL = DATA_BASE_URLS[0] || '';
      } else {
        DATA_BASE_URLS = [(urlOrArray || '').replace(/\/+$/, '')];
        _currentUrlIndex = 0;
        DATA_BASE_URL = DATA_BASE_URLS[0] || '';
      }
    }
  };

