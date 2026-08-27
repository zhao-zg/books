  // ── 资源检查与管理 ────────────────────────────────────────────────────

  /**
   * 检查资源下载统计
   * 返回 { total, downloaded, missing }
   * （estimatedTotalSize / estimatedMissingSize 已移除：唯一调用方仅使用 downloaded/total）
   */
  function checkResources() {
    var indexPromise = _cachedIndex ? Promise.resolve(_cachedIndex) : loadIndex();
    return indexPromise.then(function (indexData) {
      var books = indexData.books || [];
      var total = books.length;

      return getDownloadedIdsList().then(function (downloadedIds) {
        var downloadedCount = 0;

        for (var i = 0; i < books.length; i++) {
          if (downloadedIds.indexOf(books[i].id) !== -1) {
            downloadedCount++;
          }
        }

        return {
          total: total,
          downloaded: downloadedCount,
          missing: total - downloadedCount
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
      var ciKeys = [];
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf(KEY_BOOK_PREFIX) === 0) {
          bookKeys.push(keys[i]);
        } else if (keys[i].indexOf(KEY_CONTENT_INDEX_PREFIX) === 0 || keys[i] === KEY_CONTENT_INDEX_IDS) {
          ciKeys.push(keys[i]);
        }
      }
      var allKeys = bookKeys.concat(ciKeys);
      var removePromises = allKeys.map(function (key) {
        return storeRemove(key);
      });
      return Promise.all(removePromises).then(function () {
        _contentIndexMap = null;
        return saveDownloadedIdsList([]).then(function () {
          // 失效占用缓存（全部书籍数据已清空）
          _invalidateBookSizeCache();
          console.log('[DataManager] 已清除全部书籍缓存: ' + bookKeys.length + ' 本, 内容索引: ' + ciKeys.length + ' 条');
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

  // ── 内容索引（按需生成，全文搜索） ────────────────────────────────────

  /**
   * 从书籍数据中提取章节纯文本
   * @param {object} ch 章节对象，content 可为字符串或结构化数组
   * @returns {string}
   */
  function _chapterText(ch) {
    if (!ch) return '';
    if (typeof ch.content === 'string') return ch.content;
    if (Array.isArray(ch.content)) {
      var t = '';
      for (var i = 0; i < ch.content.length; i++) {
        t += (ch.content[i].text || '');
      }
      return t;
    }
    return '';
  }

  /**
   * 为书籍生成全文内容索引并持久化到 localforage
   * 每个章节存储：章节号(n)、标题(t)、全文纯文本(c)
   * @param {object} bookData 书籍数据（需含 id, title, chapters）
   * @returns {Promise}
   */
  function buildContentIndex(bookData) {
    if (!bookData || !bookData.id) return Promise.resolve();
    var chapters = bookData.chapters || [];
    var chaptersEntry = [];
    for (var i = 0; i < chapters.length; i++) {
      var ch = chapters[i];
      chaptersEntry.push({
        n: ch.number || (i + 1),
        t: ch.title || '',
        c: _chapterText(ch)
      });
    }
    var entry = {
      id: bookData.id,
      title: bookData.title || bookData.id,
      series: bookData.series || '',
      chapters: chaptersEntry
    };

    // 更新内存缓存
    if (!_contentIndexMap) _contentIndexMap = {};
    _contentIndexMap[bookData.id] = entry;

    // 持久化：单本书索引 + ID 列表
    return storeSet(KEY_CONTENT_INDEX_PREFIX + bookData.id, entry)
      .then(function () {
        return storeGet(KEY_CONTENT_INDEX_IDS).then(function (ids) {
          ids = ids || [];
          if (ids.indexOf(bookData.id) === -1) ids.push(bookData.id);
          return storeSet(KEY_CONTENT_INDEX_IDS, ids);
        });
      })
      .then(function () {
        console.log('[DataManager] 内容索引已构建: ' + bookData.id + '（' + chaptersEntry.length + ' 章）');
      })
      .catch(function (err) {
        console.warn('[DataManager] 构建内容索引失败:', err);
      });
  }

  /**
   * 移除书籍的内容索引
   * @param {string} bookId
   * @returns {Promise}
   */
  function removeContentIndex(bookId) {
    if (!bookId) return Promise.resolve();
    // 清内存
    if (_contentIndexMap) delete _contentIndexMap[bookId];
    // 持久化
    return storeRemove(KEY_CONTENT_INDEX_PREFIX + bookId)
      .then(function () {
        return storeGet(KEY_CONTENT_INDEX_IDS).then(function (ids) {
          ids = ids || [];
          var idx = ids.indexOf(bookId);
          if (idx !== -1) ids.splice(idx, 1);
          return storeSet(KEY_CONTENT_INDEX_IDS, ids);
        });
      })
      .then(function () {
        console.log('[DataManager] 内容索引已移除: ' + bookId);
      })
      .catch(function (err) {
        console.warn('[DataManager] 移除内容索引失败:', err);
      });
  }

  /**
   * 加载所有已有的内容索引到内存（懒加载）
   * 从 localforage 逐本读取，合并到 _contentIndexMap
   * @returns {Promise<object>} _contentIndexMap
   */
  function loadContentIndexes() {
    // ★ 修复：_contentIndexMap 可能为 {}（如索引为空或已被加载完）。
    //   若直接以 {} 作为"已加载"标记（if (_contentIndexMap) return），后续
    //   加载会被空对象短路，导致 store 中已有索引的书籍永远搜不到正文。
    //   因此仅在「非空」时才视为已加载；空对象也必须重新从 store 读取。
    if (_contentIndexMap && Object.keys(_contentIndexMap).length > 0) {
      return Promise.resolve(_contentIndexMap);
    }
    // 并发去重：同一时刻只允许一次加载，其余调用复用进行中的 Promise
    if (_contentIndexLoading) return _contentIndexLoading;
    _contentIndexMap = {};
    _contentIndexLoading = Promise.resolve()
      .then(function () { return storeGet(KEY_CONTENT_INDEX_IDS); })
      .then(function (ids) {
        if (!ids || !ids.length) return _contentIndexMap;
        var promises = ids.map(function (bookId) {
          return storeGet(KEY_CONTENT_INDEX_PREFIX + bookId).then(function (entry) {
            if (entry) _contentIndexMap[bookId] = entry;
          });
        });
        return Promise.all(promises).then(function () {
          var count = Object.keys(_contentIndexMap).length;
          console.log('[DataManager] 内容索引已加载: ' + count + ' 本书');
          return _contentIndexMap;
        });
      })
      .finally(function () {
        _contentIndexLoading = null;
      });
    return _contentIndexLoading;
  }

  /**
   * 获取内容索引映射（同步）
   * 返回 null 如果尚未加载
   */
  function getContentIndexMap() {
    return _contentIndexMap;
  }

  /**
   * 将书籍追加到书目索引（运行时，供导入外部书籍在阶段1书名搜索中可见）
   * 仅更新内存缓存 _cachedIndex，不持久化（索引在刷新时从远程重载）
   * @param {object} bookData 书籍数据（需含 id, title）
   */
  function addToBookIndex(bookData) {
    if (!bookData || !bookData.id || !_cachedIndex) return;
    if (!_cachedIndex.books) _cachedIndex.books = [];
    // 去重
    for (var i = 0; i < _cachedIndex.books.length; i++) {
      if (_cachedIndex.books[i].id === bookData.id) {
        // 已存在：若为运行时导入条目则确保打上 _runtime 标记；
        // 若是书城原生条目（无 _runtime）则保持原样（不得改标记）。
        if (_cachedIndex.books[i]._runtime !== true) {
          _cachedIndex.books[i]._runtime = true;
        }
        return;
      }
    }
    // 运行时新增（导入书 / 缓存书），打 _runtime 标记，供 removeFromBookIndex 区分
    _cachedIndex.books.push({
      id: bookData.id,
      title: bookData.title || bookData.id,
      series: bookData.series || '',
      chapter_count: (bookData.chapters || []).length,
      _runtime: true
    });
    // 确保 series 存在
    if (_cachedIndex.series && bookData.series) {
      var found = false;
      for (var s = 0; s < _cachedIndex.series.length; s++) {
        if (_cachedIndex.series[s].id === bookData.series) { found = true; break; }
      }
      if (!found) {
        _cachedIndex.series.push({ id: bookData.series, title: bookData.seriesTitle || bookData.series });
      }
    }
    console.log('[DataManager] 书目索引已更新（添加: ' + bookData.id + '）');
  }

  /**
   * 从书目索引中移除书籍（运行时，供移除外部书籍使用）
   * ★ 修复误判 bug：仅移除「运行时添加」的条目（_runtime === true，即导入书）。
   *   书城原生条目（无 _runtime）永不移除——否则 deleteBook() 删除下载缓存时
   *   会把书城书从内存索引剔除，导致后续 ZIP 导入时 _isCityBookId() 查不到该书、
   *   误判为导入书（出现 imported- 前缀副本入架 + 书城缓存丢失）。
   * @param {string} bookId
   */
  function removeFromBookIndex(bookId) {
    if (!bookId || !_cachedIndex || !_cachedIndex.books) return;
    for (var i = _cachedIndex.books.length - 1; i >= 0; i--) {
      var entry = _cachedIndex.books[i];
      if (entry && entry.id === bookId) {
        if (!entry._runtime) {
          // 书城原生条目：保留，仅移除本地缓存数据（调用方 deleteBook 负责）
          console.log('[DataManager] 书城原生索引条目保留（不移除）: ' + bookId);
          return;
        }
        _cachedIndex.books.splice(i, 1);
        console.log('[DataManager] 书目索引已更新（移除运行时条目: ' + bookId + '）');
        return;
      }
    }
  }

  // ── 公开 API ─────────────────────────────────────────────────────────

  win.DataManager = {
    loadIndex: loadIndex,
    getCachedIndex: getCachedIndex,
    checkIndexUpdate: checkIndexUpdate,
    loadContentIndexes: loadContentIndexes,
    getContentIndexMap: getContentIndexMap,
    buildContentIndex: buildContentIndex,
    removeContentIndex: removeContentIndex,
    addToBookIndex: addToBookIndex,
    removeFromBookIndex: removeFromBookIndex,
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
    },
    // 内部方法（供 dm-pack-download.js 引用）
    _getBaseUrl: function () { return DATA_BASE_URL; },
    _getBaseUrls: function () { return DATA_BASE_URLS.slice(); }
  };

